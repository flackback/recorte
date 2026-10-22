//! Voice enhancement for the microphone track: RNNoise denoising (nnnoiseless) plus a light
//! "podcast" polish — rumble filter, gentle compression and loudness normalization.

use std::path::Path;

use anyhow::Context;
use nnnoiseless::DenoiseState;

const SAMPLE_RATE: u32 = 48_000;
/// Peak level the result is normalized to (-1 dBFS).
const TARGET_PEAK: f32 = 0.89;

/// Reads `input` (16-bit WAV, any channel count, 48 kHz) and writes the enhanced mono-as-stereo
/// WAV to `output`.
pub fn enhance(input: &Path, output: &Path) -> anyhow::Result<()> {
    let mut reader = hound::WavReader::open(input).with_context(|| format!("abrir {}", input.display()))?;
    let spec = reader.spec();
    if spec.sample_rate != SAMPLE_RATE || spec.bits_per_sample != 16 {
        anyhow::bail!("o microfone precisa estar em 48 kHz e 16 bits");
    }
    let channels = spec.channels.max(1) as usize;
    let samples: Vec<i16> = reader.samples::<i16>().collect::<Result<_, _>>()?;

    // Mono in i16 range, as RNNoise expects.
    let mono: Vec<f32> = samples.chunks(channels).map(|frame| frame.iter().map(|&s| s as f32).sum::<f32>() / channels as f32).collect();

    let mut state = DenoiseState::new();
    let mut denoised = vec![0.0f32; mono.len()];
    let mut input_frame = [0.0f32; DenoiseState::FRAME_SIZE];
    let mut output_frame = [0.0f32; DenoiseState::FRAME_SIZE];
    for (index, chunk) in mono.chunks(DenoiseState::FRAME_SIZE).enumerate() {
        input_frame.fill(0.0);
        input_frame[..chunk.len()].copy_from_slice(chunk);
        state.process_frame(&mut output_frame, &input_frame);
        let start = index * DenoiseState::FRAME_SIZE;
        denoised[start..start + chunk.len()].copy_from_slice(&output_frame[..chunk.len()]);
    }

    let mut voice: Vec<f32> = denoised.iter().map(|sample| sample / 32768.0).collect();
    high_pass(&mut voice, 80.0);
    compress(&mut voice);
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

/// Smooth 3:1 compression above -24 dBFS, so quiet and loud passages sit closer together.
fn compress(samples: &mut [f32]) {
    let threshold = 10f32.powf(-24.0 / 20.0);
    let ratio = 3.0;
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
