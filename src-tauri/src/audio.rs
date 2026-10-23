use std::collections::VecDeque;
use std::fs::File;
use std::io::BufWriter;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow};
use wasapi::{AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WasapiError, WaveFormat, initialize_mta};

use crate::clock::{HNS_PER_SEC, now_hns};
use crate::meter;
use crate::recorder::Shared;

pub const SAMPLE_RATE: i64 = 48_000;
pub const CHANNELS: u16 = 2;
/// Bytes per interleaved 16-bit stereo frame.
const BLOCK: usize = CHANNELS as usize * 2;
/// Silence is only padded in up to this far behind "now", so late packets still land in place.
const PAD_LAG: i64 = SAMPLE_RATE / 10;
/// Clock jitter below this is tolerated instead of trimming or padding.
const JITTER: i64 = SAMPLE_RATE / 100;

#[derive(Clone, Copy)]
pub enum Source {
    /// What the default output device plays (WASAPI loopback).
    System,
    /// The default input device.
    Microphone,
}

pub trait Sink: Send {
    fn write(&mut self, pcm: &[u8]);
    fn finish(self: Box<Self>) -> anyhow::Result<()>;
}

/// How often the WAV header is brought up to date, so an interrupted take keeps its audio.
const FLUSH_EVERY: Duration = Duration::from_secs(2);

/// Writes a track (microphone or system sound) to its own WAV file.
pub struct WavSink {
    writer: hound::WavWriter<BufWriter<File>>,
    error: Option<hound::Error>,
    flushed: Instant,
}

impl WavSink {
    pub fn create(path: &Path) -> anyhow::Result<Self> {
        let spec = hound::WavSpec {
            channels: CHANNELS,
            sample_rate: SAMPLE_RATE as u32,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let writer = hound::WavWriter::create(path, spec).with_context(|| format!("criar {}", path.display()))?;
        Ok(Self { writer, error: None, flushed: Instant::now() })
    }
}

impl Sink for WavSink {
    fn write(&mut self, pcm: &[u8]) {
        if self.error.is_some() {
            return;
        }
        for sample in pcm.chunks_exact(2) {
            if let Err(error) = self.writer.write_sample(i16::from_le_bytes([sample[0], sample[1]])) {
                self.error = Some(error);
                return;
            }
        }
        // Writes the buffered samples and the real sizes into the header.
        if self.flushed.elapsed() >= FLUSH_EVERY {
            self.flushed = Instant::now();
            if let Err(error) = self.writer.flush() {
                self.error = Some(error);
            }
        }
    }

    fn finish(self: Box<Self>) -> anyhow::Result<()> {
        if let Some(error) = self.error {
            return Err(error.into());
        }
        self.writer.finalize()?;
        Ok(())
    }
}

/// Starts capturing `source` on its own thread. Returns once the device is open, so a missing
/// device fails here instead of silently producing an empty track.
pub fn spawn(source: Source, shared: Arc<Shared>, mut sink: Box<dyn Sink>) -> anyhow::Result<JoinHandle<anyhow::Result<()>>> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let name = match source {
        Source::System => "audio-system",
        Source::Microphone => "audio-mic",
    };
    let handle = thread::Builder::new().name(name.into()).spawn(move || {
        let result = run(source, &shared, sink.as_mut(), &ready_tx);
        if let Err(error) = &result {
            let _ = ready_tx.send(Err(format!("{error:#}")));
        }
        let finished = sink.finish();
        result.and(finished)
    })?;

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(error)) => {
            let _ = handle.join();
            Err(anyhow!(error))
        }
        Err(_) => Err(anyhow!("a thread de áudio terminou antes de abrir o dispositivo")),
    }
}

/// `AUDCLNT_E_DEVICE_INVALIDATED`: the device went away, or stopped being the default one.
const DEVICE_INVALIDATED: u32 = 0x8889_0004;
/// How often a vanished device is looked for again.
const REOPEN_EVERY: Duration = Duration::from_millis(500);

/// An open capture stream on the default device.
pub struct Stream {
    pub client: AudioClient,
    pub capture: AudioCaptureClient,
}

pub fn open(source: Source) -> anyhow::Result<Stream> {
    let enumerator = DeviceEnumerator::new()?;
    // Loopback opens the output device in capture direction.
    let device_direction = match source {
        Source::System => Direction::Render,
        Source::Microphone => Direction::Capture,
    };
    let device = enumerator.get_default_device(&device_direction).map_err(|_| anyhow!("nenhum dispositivo de áudio padrão encontrado"))?;
    let mut client = device.get_iaudioclient()?;
    let format = WaveFormat::new(16, 16, &SampleType::Int, SAMPLE_RATE as usize, CHANNELS as usize, None);
    let mode = StreamMode::PollingShared { autoconvert: true, buffer_duration_hns: 2_000_000 };
    client.initialize_client(&format, &Direction::Capture, &mode)?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;
    Ok(Stream { client, capture })
}

/// Moves every packet waiting on the device into `pending`, noting its peak for the level bars.
pub fn read_packets(source: Source, capture: &AudioCaptureClient, queue: &mut VecDeque<u8>, pending: &mut Vec<(i64, Vec<u8>)>) -> Result<(), WasapiError> {
    while let Some(frames) = capture.get_next_packet_size()? {
        if frames == 0 {
            break;
        }
        queue.clear();
        let info = capture.read_from_device_to_deque(queue)?;
        let mut bytes: Vec<u8> = queue.drain(..).collect();
        if info.flags.silent {
            bytes.fill(0);
        } else {
            meter::level(source).push(meter::peak(&bytes));
        }
        pending.push((info.timestamp as i64, bytes));
    }
    Ok(())
}

fn run(source: Source, shared: &Shared, sink: &mut dyn Sink, ready: &mpsc::Sender<Result<(), String>>) -> anyhow::Result<()> {
    initialize_mta().ok().context("inicializar COM")?;

    // `None` while the device is gone; the track is kept filled with silence meanwhile.
    let mut stream = Some(open(source)?);
    let _ = ready.send(Ok(()));
    let mut reopen_at = Instant::now();

    let mut aligner = Aligner::default();
    let mut queue = VecDeque::new();
    // Packets that arrive before the first video frame, kept until the take's origin is known.
    let mut pending: Vec<(i64, Vec<u8>)> = Vec::new();

    loop {
        let stopping = shared.stop.load(Ordering::Acquire);

        if stream.is_none() && Instant::now() >= reopen_at {
            reopen_at = Instant::now() + REOPEN_EVERY;
            stream = open(source).ok();
        }
        if let Some(current) = &stream {
            match read_packets(source, &current.capture, &mut queue, &mut pending) {
                Ok(()) => meter::level(source).touch(),
                // The default device changed (headset plugged in, output switched): the same
                // track goes on from the new default, the gap filled with silence.
                Err(WasapiError::Windows(error)) if error.code().0 as u32 == DEVICE_INVALIDATED => {
                    meter::level(source).lost();
                    stream = None;
                    reopen_at = Instant::now();
                }
                Err(error) => return Err(error.into()),
            }
        }

        let t0 = shared.t0.load(Ordering::Acquire);
        if t0 != 0 {
            for (timestamp, bytes) in pending.drain(..) {
                aligner.push(t0, timestamp, &bytes, sink);
            }
            // Loopback delivers nothing while nothing plays, so keep the track filled with silence.
            let lag = if stopping { 0 } else { PAD_LAG };
            aligner.pad_to(frames_since(t0, now_hns()) - lag, sink);
        }

        if stopping {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    meter::level(source).lost();
    if let Some(stream) = stream {
        stream.client.stop_stream()?;
    }
    Ok(())
}

fn frames_since(t0: i64, timestamp: i64) -> i64 {
    (timestamp - t0) * SAMPLE_RATE / HNS_PER_SEC
}

/// Places audio packets on the take's timeline, which starts at the first video frame.
#[derive(Default)]
struct Aligner {
    written: i64,
}

impl Aligner {
    fn push(&mut self, t0: i64, timestamp: i64, bytes: &[u8], sink: &mut dyn Sink) {
        let frames = (bytes.len() / BLOCK) as i64;
        let start = frames_since(t0, timestamp);
        if start > self.written + JITTER {
            self.pad_to(start, sink);
        }
        let overlap = self.written - start;
        let skip = if overlap > JITTER { overlap.min(frames) } else { 0 };
        let data = &bytes[skip as usize * BLOCK..];
        if !data.is_empty() {
            sink.write(data);
            self.written += (data.len() / BLOCK) as i64;
        }
    }

    fn pad_to(&mut self, target: i64, sink: &mut dyn Sink) {
        const CHUNK: i64 = SAMPLE_RATE;
        while self.written < target {
            let frames = (target - self.written).min(CHUNK);
            sink.write(&vec![0u8; frames as usize * BLOCK]);
            self.written += frames;
        }
    }
}
