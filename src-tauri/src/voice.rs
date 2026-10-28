//! Voice enhancement for the microphone track: RNNoise denoising (nnnoiseless) plus a
//! "podcast" polish — rumble filter, compression and peak normalization — at one of three
//! strengths.

use std::path::Path;

use anyhow::Context;
use nnnoiseless::DenoiseState;

const SAMPLE_RATE: u32 = 48_000;
/// Peak level the result is normalized to (-1 dBFS).
const TARGET_PEAK: f32 = 0.89;
/// RNNoise hands back each frame one frame late (measured); the result is moved back by this much.
const DENOISE_DELAY: usize = DenoiseState::FRAME_SIZE;

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
    /// Share of the denoised sound; the rest is the original.
    denoised: f32,
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
        Level::Light => Settings { denoised: 0.85, high_pass: 70.0, threshold_db: -20.0, ratio: 2.0, presence_db: 0.0, gate_db: None },
        Level::Medium => Settings { denoised: 1.0, high_pass: 80.0, threshold_db: -24.0, ratio: 3.0, presence_db: 0.0, gate_db: None },
        Level::Strong => Settings { denoised: 1.0, high_pass: 100.0, threshold_db: -28.0, ratio: 4.0, presence_db: 3.0, gate_db: Some(-48.0) },
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

    // Mono in i16 range, as RNNoise expects, mixed down while reading so only one buffer is kept;
    // every step below works on it in place.
    let mut voice: Vec<f32> = Vec::with_capacity(reader.duration() as usize + DENOISE_DELAY);
    let (mut sum, mut count) = (0.0f32, 0);
    for sample in reader.samples::<i16>() {
        sum += sample? as f32;
        count += 1;
        if count == channels {
            voice.push(sum / channels as f32);
            (sum, count) = (0.0, 0);
        }
    }
    if count > 0 {
        voice.push(sum / channels as f32);
    }
    let length = voice.len();
    // One more frame of silence flushes the last frame out of RNNoise.
    voice.resize(length + DENOISE_DELAY, 0.0);

    let mut state = DenoiseState::new();
    let mut input_frame = [0.0f32; DenoiseState::FRAME_SIZE];
    let mut output_frame = [0.0f32; DenoiseState::FRAME_SIZE];
    // The original of the frame before, which is what each output frame matches.
    let mut previous = [0.0f32; DenoiseState::FRAME_SIZE];
    let dry = 1.0 - settings.denoised;
    for chunk in voice.chunks_mut(DenoiseState::FRAME_SIZE) {
        input_frame.fill(0.0);
        input_frame[..chunk.len()].copy_from_slice(chunk);
        state.process_frame(&mut output_frame, &input_frame);
        for ((sample, denoised), original) in chunk.iter_mut().zip(&output_frame).zip(&previous) {
            *sample = (denoised * settings.denoised + original * dry) / 32768.0;
        }
        previous = input_frame;
    }
    voice.drain(..DENOISE_DELAY);
    voice.truncate(length);

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
