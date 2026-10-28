//! Voice enhancement for the microphone track: DeepFilterNet3 denoising (RNNoise when the model
//! cannot start) plus a "podcast" polish — rumble filter, compression and peak normalization — at
//! one of three strengths.

use std::path::Path;

use anyhow::Context;
use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::Array2;
use nnnoiseless::DenoiseState;

const SAMPLE_RATE: u32 = 48_000;
/// Peak level the result is normalized to (-1 dBFS).
const TARGET_PEAK: f32 = 0.89;
/// RNNoise hands back each frame one frame late (measured); the result is moved back by this much.
const RNNOISE_DELAY: usize = DenoiseState::FRAME_SIZE;
/// DeepFilterNet skips a frame, without moving its delay line, when the frame's mean square is
/// under 1e-7 (-70 dBFS). Quieter frames get a faint noise of this mean square added, so every
/// frame goes through and the delay stays fixed.
const KEEP_ALIVE: f32 = 2e-7;

/// How much the voice is processed.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// Some of the original sound stays, for a natural voice in a quiet room.
    Light,
    Medium,
    /// Also lowers what is left between words and brings the voice forward.
    Strong,
}

impl Level {
    pub fn parse(value: &str) -> Level {
        match value {
            "light" => Level::Light,
            "strong" => Level::Strong,
            _ => Level::Medium,
        }
    }

    /// The enhanced file's name next to `mic.wav`; the medium one keeps its original name.
    pub fn file(self) -> &'static str {
        match self {
            Level::Light => "mic.enhanced-light.wav",
            Level::Medium => "mic.enhanced.wav",
            Level::Strong => "mic.enhanced-strong.wav",
        }
    }
}

struct Settings {
    /// How far the noise may be lowered, in dB; None takes out all of it.
    limit_db: Option<f32>,
    high_pass: f32,
    threshold_db: f32,
    ratio: f32,
    /// Boost around 3.2 kHz, where speech is understood.
    presence_db: f32,
    /// Lowers what stays under this level (dBFS) between words; None leaves it.
    gate_db: Option<f32>,
}

fn settings(level: Level) -> Settings {
    match level {
        Level::Light => Settings { limit_db: Some(15.0), high_pass: 70.0, threshold_db: -20.0, ratio: 2.0, presence_db: 0.0, gate_db: None },
        Level::Medium => Settings { limit_db: Some(30.0), high_pass: 80.0, threshold_db: -24.0, ratio: 3.0, presence_db: 0.0, gate_db: None },
        Level::Strong => Settings { limit_db: None, high_pass: 100.0, threshold_db: -28.0, ratio: 4.0, presence_db: 3.0, gate_db: Some(-48.0) },
    }
}

/// Writes the enhanced microphone for `level` next to `mic.wav`, unless it is already there and
/// newer. Returns its file name.
pub fn enhance_take(dir: &Path, level: Level) -> anyhow::Result<&'static str> {
    let input = dir.join("mic.wav");
    let output = dir.join(level.file());
    let modified = |path: &Path| std::fs::metadata(path).and_then(|meta| meta.modified()).ok();
    if let (Some(made), Some(source)) = (modified(&output), modified(&input)) {
        if made >= source {
            return Ok(level.file());
        }
    }
    enhance(&input, &output, level)?;
    Ok(level.file())
}

/// Reads `input` (16-bit WAV, any channel count, 48 kHz) and writes the enhanced mono-as-stereo
/// WAV to `output`.
pub fn enhance(input: &Path, output: &Path, level: Level) -> anyhow::Result<()> {
    let settings = settings(level);
    let mut reader = hound::WavReader::open(input).with_context(|| format!("abrir {}", input.display()))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE || spec.bits_per_sample != 16 {
        anyhow::bail!("o microfone precisa estar em 48 kHz e 16 bits");
    }
    let channels = spec.channels.max(1) as usize;

    // Mono in -1..1, mixed down while reading so only one buffer is kept (with room for the
    // denoiser's flush); every step below works on it in place.
    let mut voice: Vec<f32> = Vec::with_capacity(reader.duration() as usize + 2048);
    let (mut sum, mut count) = (0.0f32, 0);
    for sample in reader.samples::<i16>() {
        sum += sample? as f32;
        count += 1;
        if count == channels {
            voice.push(sum / channels as f32 / 32768.0);
            (sum, count) = (0.0, 0);
        }
    }
    if count > 0 {
        voice.push(sum / channels as f32 / 32768.0);
    }

    denoise(&mut voice, settings.limit_db)?;
    high_pass(&mut voice, settings.high_pass);
    if settings.presence_db > 0.0 {
        presence(&mut voice, 3200.0, settings.presence_db);
    }
    if let Some(gate_db) = settings.gate_db {
        expand(&mut voice, gate_db);
    }
    compress(&mut voice, settings.threshold_db, settings.ratio);
    normalize(&mut voice);

    let out_spec = hound::WavSpec { channels: 2, sample_rate: SAMPLE_RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut writer = hound::WavWriter::create(output, out_spec).with_context(|| format!("criar {}", output.display()))?;
    for sample in voice {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        writer.write_sample(value)?;
        writer.write_sample(value)?;
    }
    writer.finalize()?;
    Ok(())
}

/// Removes the noise with DeepFilterNet3, or with RNNoise when the model does not start. The
/// result stays sample-aligned with the input.
fn denoise(voice: &mut Vec<f32>, limit_db: Option<f32>) -> anyhow::Result<()> {
    match deep_filter_model(limit_db) {
        Ok(model) => deep_filter(voice, model),
        Err(error) => {
            eprintln!("DeepFilterNet indisponível, usando RNNoise: {error:#}");
            rnnoise(voice, limit_db);
            Ok(())
        }
    }
}

/// The built-in DeepFilterNet3 model; 100 dB or more means no limit to it.
fn deep_filter_model(limit_db: Option<f32>) -> anyhow::Result<DfTract> {
    let params = RuntimeParams::default_with_ch(1).with_atten_lim(limit_db.unwrap_or(100.0));
    DfTract::new(DfParams::default(), &params)
}

/// Samples DeepFilterNet hands each one back late: the STFT window less one hop, plus the
/// model's look-ahead frames (1440, 30 ms, for DFN3; the tests check it).
fn deep_filter_delay(model: &DfTract) -> usize {
    model.fft_size - model.hop_size + model.lookahead * model.hop_size
}

fn deep_filter(voice: &mut Vec<f32>, mut model: DfTract) -> anyhow::Result<()> {
    let hop = model.hop_size;
    let delay = deep_filter_delay(&model);
    let length = voice.len();
    // Silence after the end flushes the last samples out of the model.
    voice.resize(length + delay, 0.0);
    let mut noisy = Array2::<f32>::zeros((1, hop));
    let mut enhanced = Array2::<f32>::zeros((1, hop));
    // Pseudo-random signs (xorshift), so the keep-alive noise is white and the same on every run.
    let mut seed = 0x2545_f491u32;
    let keep_alive = KEEP_ALIVE.sqrt();
    for chunk in voice.chunks_mut(hop) {
        let frame = noisy.as_slice_mut().context("quadro de áudio")?;
        frame.fill(0.0);
        frame[..chunk.len()].copy_from_slice(chunk);
        if frame.iter().map(|sample| sample * sample).sum::<f32>() / (hop as f32) < KEEP_ALIVE {
            for sample in frame.iter_mut() {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                *sample += if seed & 1 == 0 { keep_alive } else { -keep_alive };
            }
        }
        model.process(noisy.view(), enhanced.view_mut()).context("reduzir o ruído")?;
        let frame = enhanced.as_slice().context("quadro de áudio")?;
        chunk.copy_from_slice(&frame[..chunk.len()]);
    }
    voice.drain(..delay);
    voice.truncate(length);
    Ok(())
}

/// RNNoise, with as much of the original mixed back in as `limit_db` leaves.
fn rnnoise(voice: &mut Vec<f32>, limit_db: Option<f32>) {
    let dry = limit_db.map_or(0.0, |db| 10f32.powf(-db / 20.0));
    let length = voice.len();
    // One more frame of silence flushes the last frame out of RNNoise.
    voice.resize(length + RNNOISE_DELAY, 0.0);
    let mut state = DenoiseState::new();
    let mut input_frame = [0.0f32; DenoiseState::FRAME_SIZE];
    let mut output_frame = [0.0f32; DenoiseState::FRAME_SIZE];
    // The original of the frame before, which is what each output frame matches.
    let mut previous = [0.0f32; DenoiseState::FRAME_SIZE];
    for chunk in voice.chunks_mut(DenoiseState::FRAME_SIZE) {
        // RNNoise works in the i16 range.
        input_frame.fill(0.0);
        for (frame, sample) in input_frame.iter_mut().zip(chunk.iter()) {
            *frame = sample * 32768.0;
        }
        state.process_frame(&mut output_frame, &input_frame);
        for ((sample, denoised), original) in chunk.iter_mut().zip(&output_frame).zip(&previous) {
            *sample = (denoised * (1.0 - dry) + original * dry) / 32768.0;
        }
        previous = input_frame;
    }
    voice.drain(..RNNOISE_DELAY);
    voice.truncate(length);
}

/// Peaking filter (RBJ biquad) that lifts `gain_db` around `frequency`.
fn presence(samples: &mut [f32], frequency: f32, gain_db: f32) {
    let a = 10f32.powf(gain_db / 40.0);
    let w = 2.0 * std::f32::consts::PI * frequency / SAMPLE_RATE as f32;
    let alpha = w.sin() / (2.0 * 0.9);
    let (b0, b1, b2) = (1.0 + alpha * a, -2.0 * w.cos(), 1.0 - alpha * a);
    let (a0, a1, a2) = (1.0 + alpha / a, -2.0 * w.cos(), 1.0 - alpha / a);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for sample in samples.iter_mut() {
        let x = *sample;
        let y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        (x2, x1, y2, y1) = (x1, x, y1, y);
        *sample = y;
    }
}

/// Downward expander: below `threshold_db`, the sound is lowered further the quieter it is, so
/// the hiss left between words fades without cutting into soft speech.
fn expand(samples: &mut [f32], threshold_db: f32) {
    let threshold = 10f32.powf(threshold_db / 20.0);
    let attack = (-1.0 / (0.002 * SAMPLE_RATE as f32)).exp();
    let release = (-1.0 / (0.150 * SAMPLE_RATE as f32)).exp();
    let mut envelope = 0.0f32;
    for sample in samples.iter_mut() {
        let level = sample.abs();
        let coefficient = if level > envelope { attack } else { release };
        envelope = coefficient * envelope + (1.0 - coefficient) * level;
        if envelope < threshold {
            *sample *= (envelope / threshold).max(0.05);
        }
    }
}

/// One-pole high-pass: removes desk thumps and low hum below `cutoff` Hz.
fn high_pass(samples: &mut [f32], cutoff: f32) {
    let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff);
    let dt = 1.0 / SAMPLE_RATE as f32;
    let alpha = rc / (rc + dt);
    let mut previous_in = 0.0;
    let mut previous_out = 0.0;
    for sample in samples.iter_mut() {
        let output = alpha * (previous_out + *sample - previous_in);
        previous_in = *sample;
        previous_out = output;
        *sample = output;
    }
}

/// Smooth compression above `threshold_db` (dBFS) at `ratio`:1, so quiet and loud passages sit
/// closer together.
fn compress(samples: &mut [f32], threshold_db: f32, ratio: f32) {
    let threshold = 10f32.powf(threshold_db / 20.0);
    let attack = (-1.0 / (0.005 * SAMPLE_RATE as f32)).exp();
    let release = (-1.0 / (0.120 * SAMPLE_RATE as f32)).exp();
    let mut envelope = 0.0f32;
    for sample in samples.iter_mut() {
        let level = sample.abs();
        let coefficient = if level > envelope { attack } else { release };
        envelope = coefficient * envelope + (1.0 - coefficient) * level;
        if envelope > threshold {
            let gain = (threshold * (envelope / threshold).powf(1.0 / ratio)) / envelope;
            *sample *= gain;
        }
    }
}

fn normalize(samples: &mut [f32]) {
    let peak = samples.iter().fold(0.0f32, |peak, sample| peak.max(sample.abs()));
    if peak > 1e-4 {
        let gain = TARGET_PEAK / peak;
        for sample in samples.iter_mut() {
            *sample *= gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Digital silence, then noise bursts: broadband, so the correlation peak is sharp.
    fn bursts() -> Vec<f32> {
        let mut seed = 1u32;
        (0..SAMPLE_RATE as usize)
            .map(|index| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = (seed >> 8) as f32 / (1 << 24) as f32 - 0.5;
                if index < 14_400 || index % 9_600 >= 2_400 { 0.0 } else { noise * 0.2 }
            })
            .collect()
    }

    /// Every 10 ms frame that has sound in `input` still has it in `output`, so no part of it
    /// was moved elsewhere.
    fn nothing_moved(input: &[f32], output: &[f32]) -> bool {
        let energy = |frame: &[f32]| frame.iter().map(|sample| sample * sample).sum::<f32>();
        input.chunks(480).zip(output.chunks(480)).all(|(before, after)| energy(after) >= 0.1 * energy(before))
    }

    /// The lag (in samples, within ±`range`) at which `output` best matches `input`.
    fn best_lag(input: &[f32], output: &[f32], range: isize) -> isize {
        let score = |lag: isize| -> f32 {
            (0..input.len() as isize)
                .filter_map(|index| {
                    let shifted = index + lag;
                    (shifted >= 0 && shifted < output.len() as isize).then(|| input[index as usize] * output[shifted as usize])
                })
                .sum()
        };
        (-range..=range).max_by(|a, b| score(*a).total_cmp(&score(*b))).unwrap()
    }

    #[test]
    fn deep_filter_stays_aligned() {
        let input = bursts();
        let mut output = input.clone();
        // With a 6 dB limit half of the original stays, so there is always something to match.
        deep_filter(&mut output, deep_filter_model(Some(6.0)).unwrap()).unwrap();
        assert_eq!(output.len(), input.len());
        assert_eq!(best_lag(&input, &output, 1_500), 0);
        // The silent gaps between bursts would otherwise push each burst's last 30 ms past them.
        assert!(nothing_moved(&input, &output));
    }

    #[test]
    fn rnnoise_stays_aligned() {
        let input = bursts();
        let mut output = input.clone();
        rnnoise(&mut output, Some(6.0));
        assert_eq!(output.len(), input.len());
        assert_eq!(best_lag(&input, &output, 1_500), 0);
        assert!(nothing_moved(&input, &output));
    }
}
