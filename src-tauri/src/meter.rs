//! Live sound levels for the level bars: the latest peak of the system sound and of the
//! microphone. The recorder's audio threads feed them while recording; before recording, a light
//! meter thread opens the default devices only to read their peaks (nothing is written).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use wasapi::initialize_mta;

use crate::audio::{self, Source};

/// A shown peak falls by half every this many ms, so short sounds stay visible for a moment.
const HALF_LIFE_MS: f32 = 160.0;
/// A source not polled for this long has no device (or no thread reading it): shown as off.
const STALE_MS: u64 = 1000;
/// How often the idle meter tries again to open a device that failed or went away.
const RETRY: Duration = Duration::from_secs(2);

fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

/// One source's level: the peak (0..1, as f32 bits), when it was set, and when the device was last
/// read successfully.
pub struct Level {
    peak: AtomicU32,
    peak_at: AtomicU64,
    seen_at: AtomicU64,
}

impl Level {
    const fn new() -> Self {
        Self { peak: AtomicU32::new(0), peak_at: AtomicU64::new(0), seen_at: AtomicU64::new(0) }
    }

    fn decayed(&self, now: u64) -> f32 {
        let peak = f32::from_bits(self.peak.load(Ordering::Relaxed));
        let age = now.saturating_sub(self.peak_at.load(Ordering::Relaxed)) as f32;
        peak * 0.5f32.powf(age / HALF_LIFE_MS)
    }

    /// Notes a packet's peak; a louder one replaces the falling one. Races only lose a frame.
    pub fn push(&self, peak: f32) {
        let now = now_ms();
        if peak >= self.decayed(now) {
            self.peak.store(peak.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
            self.peak_at.store(now, Ordering::Relaxed);
        }
    }

    /// The device was read (with or without sound): the source is alive.
    pub fn touch(&self) {
        self.seen_at.store(now_ms(), Ordering::Relaxed);
    }

    /// The device went away.
    pub fn lost(&self) {
        self.seen_at.store(0, Ordering::Relaxed);
    }

    fn read(&self) -> Option<f32> {
        let now = now_ms();
        let seen = self.seen_at.load(Ordering::Relaxed);
        (seen != 0 && now.saturating_sub(seen) <= STALE_MS).then(|| self.decayed(now))
    }
}

static SYSTEM: Level = Level::new();
static MIC: Level = Level::new();

pub fn level(source: Source) -> &'static Level {
    match source {
        Source::System => &SYSTEM,
        Source::Microphone => &MIC,
    }
}

/// Peak of interleaved 16-bit samples, 0..1.
pub fn peak(pcm: &[u8]) -> f32 {
    let max = pcm.chunks_exact(2).map(|sample| i16::from_le_bytes([sample[0], sample[1]]).unsigned_abs()).max().unwrap_or(0);
    max as f32 / 32768.0
}

/// Current levels; `None` for a source without a working device or nobody reading it.
#[derive(Serialize)]
pub struct Levels {
    system: Option<f32>,
    mic: Option<f32>,
}

#[tauri::command]
pub fn audio_levels() -> Levels {
    Levels { system: SYSTEM.read(), mic: MIC.read() }
}

/// The idle meter's thread and what it should read.
struct Meter {
    handle: JoinHandle<()>,
    stop: Arc<AtomicBool>,
    system: Arc<AtomicBool>,
    mic: Arc<AtomicBool>,
}

static METER: Mutex<Option<Meter>> = Mutex::new(None);

/// Starts the idle meter, or changes which sources it reads.
#[tauri::command]
pub fn meter_start(system: bool, mic: bool) {
    if !system && !mic {
        meter_stop();
        return;
    }
    let mut meter = METER.lock().unwrap();
    if let Some(running) = meter.as_ref().filter(|running| !running.handle.is_finished()) {
        running.system.store(system, Ordering::Relaxed);
        running.mic.store(mic, Ordering::Relaxed);
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let wants = (Arc::new(AtomicBool::new(system)), Arc::new(AtomicBool::new(mic)));
    let (flag, want_system, want_mic) = (stop.clone(), wants.0.clone(), wants.1.clone());
    let spawned = thread::Builder::new().name("audio-meter".into()).spawn(move || run(&flag, &want_system, &want_mic));
    // No thread: the bars just show as off.
    *meter = spawned.ok().map(|handle| Meter { handle, stop, system: wants.0, mic: wants.1 });
}

/// Stops the idle meter without waiting for it; it closes its devices on its own.
#[tauri::command]
pub fn meter_stop() {
    if let Some(meter) = METER.lock().unwrap().take() {
        meter.stop.store(true, Ordering::Relaxed);
    }
}

/// One source of the idle meter: its stream while open, and when to try opening it again.
struct Input {
    source: Source,
    stream: Option<audio::Stream>,
    retry_at: Instant,
}

impl Input {
    fn poll(&mut self, wanted: bool, queue: &mut VecDeque<u8>, scratch: &mut Vec<(i64, Vec<u8>)>) {
        let level = level(self.source);
        if !wanted {
            if self.stream.take().is_some() {
                level.lost();
            }
            return;
        }
        if self.stream.is_none() && Instant::now() >= self.retry_at {
            self.retry_at = Instant::now() + RETRY;
            self.stream = audio::open(self.source).ok();
        }
        let Some(stream) = &self.stream else {
            return;
        };
        scratch.clear();
        // Peaks are noted while reading; the sound itself is dropped. Any error (device gone,
        // default device changed) closes the stream, and it is opened again later.
        if audio::read_packets(self.source, &stream.capture, queue, scratch).is_ok() {
            level.touch();
        } else {
            self.stream = None;
            self.retry_at = Instant::now();
            level.lost();
        }
    }
}

fn run(stop: &AtomicBool, system: &AtomicBool, mic: &AtomicBool) {
    if initialize_mta().ok().is_err() {
        return;
    }
    let mut inputs = [Source::System, Source::Microphone].map(|source| Input { source, stream: None, retry_at: Instant::now() });
    let (mut queue, mut scratch) = (VecDeque::new(), Vec::new());
    while !stop.load(Ordering::Relaxed) {
        for input in &mut inputs {
            let wanted = match input.source {
                Source::System => system.load(Ordering::Relaxed),
                Source::Microphone => mic.load(Ordering::Relaxed),
            };
            input.poll(wanted, &mut queue, &mut scratch);
        }
        thread::sleep(Duration::from_millis(25));
    }
    for input in inputs {
        if let Some(stream) = input.stream {
            let _ = stream.client.stop_stream();
            level(input.source).lost();
        }
    }
}
