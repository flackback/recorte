use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::io::Write as _;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::RECT;
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType,
};
use windows_capture::encoder::{ImageEncoder, ImageEncoderPixelFormat, ImageFormat};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, GraphicsCaptureItemType,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use crate::audio::{self, WavSink};
use crate::clock::{HNS_PER_SEC, now_hns};
use crate::cursor::{self, Button, KeyPress, Kind, RawEvent, Shape};
use crate::sources;

pub const META_FILE: &str = "take.json";
pub(crate) const VIDEO_FILE: &str = "screen.mp4";
const MIC_FILE: &str = "mic.wav";
const SYSTEM_FILE: &str = "system.wav";
/// While recording, video goes to short, finished segments here; they become `screen.mp4` when
/// the recording stops. A crash loses at most the segment being written.
const SEGMENT_DIR: &str = "segments";
const SEGMENT_HNS: i64 = 30 * HNS_PER_SEC;
/// The next segment's encoder is made this long before it is needed, on its own thread.
const PREPARE_HNS: i64 = 3 * HNS_PER_SEC;
/// After a segment fails to start, the current one goes on this much longer before a new try.
const RETRY_HNS: i64 = 5 * HNS_PER_SEC;
/// Finished segments and the first frame's time, rewritten after each segment.
const SEGMENTS_FILE: &str = "segments.json";
/// The take's description, written at the start so an interrupted take can be recovered.
const RECORDING_FILE: &str = "recording.json";
/// Mouse and key events, appended every few seconds while recording.
const CURSOR_PARTIAL: &str = "cursor.partial.jsonl";
const KEYS_PARTIAL: &str = "keys.partial.jsonl";
const PARTIAL_EVERY: Duration = Duration::from_secs(2);
pub(crate) const CURSOR_FILE: &str = "cursor.json";
const KEYS_FILE: &str = "keys.json";
pub(crate) const THUMB_FILE: &str = "thumb.jpg";
/// The thumbnail is taken this many frames in, past any first-frame artifacts.
const THUMB_FRAME: u64 = 20;

type CaptureError = Box<dyn Error + Send + Sync>;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceRef {
    Monitor { index: usize },
    Window { hwnd: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    pub source: SourceRef,
    pub system_audio: bool,
    pub microphone: bool,
    pub show_cursor: bool,
    #[serde(default)]
    pub keystrokes: bool,
    /// Clicks made while drawing on the screen count as clicks (they make zooms in the editor).
    #[serde(default = "yes")]
    pub draw_zoom: bool,
    /// Area picked before recording, in video pixels; becomes the take's initial crop.
    #[serde(default)]
    pub crop: Option<CropRect>,
    /// For a browser window: only its page, without tabs and address bar (as the initial crop).
    #[serde(default)]
    pub page_only: bool,
    pub fps: u32,
}

fn yes() -> bool {
    true
}

/// A paused stretch of the take, in ms from the first frame. The editor starts with it cut.
#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct PauseSpan {
    pub start: f64,
    pub end: f64,
}

/// A finished piece of the recording, placed on the take's timeline.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub file: String,
    pub start_ms: f64,
    pub end_ms: f64,
    pub frames: u64,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct CropRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Everything the editor needs to know about a take, saved next to its media as `take.json`.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TakeMeta {
    pub version: u32,
    pub id: String,
    pub created_at: String,
    pub source_kind: String,
    pub source_name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Top-left of the captured area in physical screen pixels; cursor positions are relative to it.
    pub origin_x: i32,
    pub origin_y: i32,
    pub duration_ms: f64,
    pub frames: u64,
    pub video: String,
    pub system_audio: bool,
    /// System sound as its own WAV; older takes have it inside the video instead.
    #[serde(default)]
    pub system_file: Option<String>,
    pub mic: Option<String>,
    pub cursor: String,
    pub cursor_in_video: bool,
    /// Keystrokes file, when recorded.
    #[serde(default)]
    pub keys: Option<String>,
    /// Webcam recording and where it starts on the take's timeline; set by the frontend.
    #[serde(default)]
    pub webcam: Option<String>,
    #[serde(default)]
    pub webcam_offset_ms: Option<f64>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    /// Name the user gave the take; the source name is shown otherwise.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub crop: Option<CropRect>,
    #[serde(default)]
    pub pauses: Vec<PauseSpan>,
    /// Moments marked during recording (Alt+Shift+M), in ms from the first frame.
    #[serde(default)]
    pub markers: Vec<f64>,
    /// QPC time (100 ns) of the first frame, to line up streams recorded elsewhere (webcam).
    #[serde(default)]
    pub start_hns: i64,
    pub warnings: Vec<String>,
    /// Video segments still to be joined into `video`; empty once joined.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<Segment>,
    /// Filled in when listing; not stored.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub dir: String,
}

struct EncoderConfig {
    dir: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
}

/// The segment being written: its number, first frame (QPC, 100 ns) and frame count.
#[derive(Default)]
struct SegmentState {
    index: u32,
    start: i64,
    frames: u64,
    /// Extra length after failed tries to start the next segment.
    delay: i64,
    /// Whether the next segment's encoder was asked for.
    asked: bool,
}

/// Top-left of the captured area from `time` (QPC, 100 ns) on, in physical screen pixels.
#[derive(Clone, Copy, Default)]
struct Origin {
    time: i64,
    x: i32,
    y: i32,
}

/// Where the captured area was at `time`.
fn origin_at(origins: &[Origin], time: i64) -> Origin {
    let index = origins.partition_point(|origin| origin.time <= time);
    origins.get(index.saturating_sub(1)).copied().unwrap_or_default()
}

fn segment_name(index: u32) -> String {
    format!("{SEGMENT_DIR}/{index:03}.mp4")
}

fn new_encoder(config: &EncoderConfig, index: u32) -> Result<VideoEncoder, CaptureError> {
    Ok(VideoEncoder::new(
        VideoSettingsBuilder::new(config.width, config.height)
            .sub_type(VideoSettingsSubType::H264)
            .frame_rate(config.fps)
            .bitrate(bitrate(config.width, config.height, config.fps)),
        // Sound goes to WAV files, which survive a crash; segments are video only.
        AudioSettingsBuilder::new().disabled(true),
        ContainerSettingsBuilder::new(),
        config.dir.join(segment_name(index)),
    )?)
}

fn hns_to_ms(hns: i64) -> f64 {
    (hns as f64 / (HNS_PER_SEC as f64 / 1000.0) * 10.0).round() / 10.0
}

/// State shared by the capture thread, the audio threads and the command that stops the take.
pub struct Shared {
    pub encoder: Mutex<Option<VideoEncoder>>,
    /// QPC time (100 ns) of the first video frame; 0 until it arrives. Every track starts here.
    pub t0: AtomicI64,
    pub stop: AtomicBool,
    pub closed: AtomicBool,
    pub frames: AtomicU64,
    thumbnail: PathBuf,
    config: EncoderConfig,
    segment: Mutex<SegmentState>,
    /// The next segment's encoder, made ahead on its own thread: making it on the frame thread
    /// blocks long enough to drop frames.
    next: Mutex<Option<Result<VideoEncoder, String>>>,
    /// Set while `next` is being made.
    preparing: AtomicBool,
    /// Segments whose file is finished, in order.
    finished: Mutex<Vec<Segment>>,
    /// Threads finishing earlier segments' files, making the next encoder or saving the thumbnail.
    finishing: Mutex<Vec<JoinHandle<()>>>,
    /// Why the capture ended on its own, if it did. The capture then never calls `on_closed`.
    failure: Mutex<Option<String>>,
    /// Problems the capture worked around, added to the take's warnings when it stops.
    notes: Mutex<Vec<String>>,
    /// Where the captured area was over time, oldest first; a recorded window can move.
    origins: Mutex<Vec<Origin>>,
}

impl Shared {
    fn fail(&self, error: String) {
        self.failure.lock().unwrap().get_or_insert(error);
    }

    /// The encoder for segment `index`: the one made ahead, or a new one if none was asked for.
    /// `None` while it is still being made.
    fn take_next(&self, index: u32) -> Option<Result<VideoEncoder, String>> {
        // Checked before `next`, which is filled before `preparing` is cleared.
        if self.preparing.load(Ordering::Acquire) {
            return None;
        }
        if let Some(ready) = self.next.lock().unwrap().take() {
            return Some(ready);
        }
        Some(new_encoder(&self.config, index).map_err(|error| error.to_string()))
    }

    /// Records a finished segment and rewrites the list, so recovery knows what is safe.
    fn segment_done(&self, segment: Segment) {
        let mut finished = self.finished.lock().unwrap();
        finished.push(segment);
        finished.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
        let list = serde_json::json!({ "t0": self.t0.load(Ordering::Acquire), "segments": *finished });
        let _ = write_json(&self.config.dir.join(SEGMENTS_FILE), &list);
    }
}

/// Makes segment `index`'s encoder on its own thread, for `Shared::take_next`.
fn prepare_next(shared: &Arc<Shared>, index: u32) {
    shared.preparing.store(true, Ordering::Release);
    let worker = shared.clone();
    let spawned = thread::Builder::new().name("segment-encoder".into()).spawn(move || {
        let encoder = new_encoder(&worker.config, index).map_err(|error| error.to_string());
        *worker.next.lock().unwrap() = Some(encoder);
        worker.preparing.store(false, Ordering::Release);
    });
    match spawned {
        Ok(handle) => shared.finishing.lock().unwrap().push(handle),
        // `take_next` then makes it on the frame thread.
        Err(_) => shared.preparing.store(false, Ordering::Release),
    }
}

/// Saves the thumbnail on its own thread; only reading the pixels back happens on the frame thread.
fn save_thumbnail(shared: &Shared, frame: &mut Frame) {
    let Ok(buffer) = frame.buffer() else {
        return;
    };
    let (width, height) = (buffer.width(), buffer.height());
    let mut unpadded = Vec::new();
    let pixels = buffer.as_nopadding_buffer(&mut unpadded).to_vec();
    let path = shared.thumbnail.clone();
    let handle = thread::spawn(move || {
        let image = ImageEncoder::new(ImageFormat::Jpeg, ImageEncoderPixelFormat::Rgba8).and_then(|encoder| encoder.encode(&pixels, width, height));
        if let Ok(bytes) = image {
            let _ = fs::write(path, bytes);
        }
    });
    shared.finishing.lock().unwrap().push(handle);
}

struct Capture {
    shared: Arc<Shared>,
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = Arc<Shared>;
    type Error = CaptureError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let shared = ctx.flags;
        fs::create_dir_all(shared.config.dir.join(SEGMENT_DIR))?;
        let encoder = new_encoder(&shared.config, 0)?;
        *shared.encoder.lock().unwrap() = Some(encoder);
        Ok(Self { shared })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, _control: InternalCaptureControl) -> Result<(), Self::Error> {
        // An error ends the capture; it is kept so the app can tell and the take still stops.
        self.frame_arrived(frame).inspect_err(|error| self.shared.fail(error.to_string()))
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.shared.closed.store(true, Ordering::Release);
        Ok(())
    }
}

impl Capture {
    fn frame_arrived(&mut self, frame: &mut Frame) -> Result<(), CaptureError> {
        let mut encoder = self.shared.encoder.lock().unwrap();
        let Some(encoder) = encoder.as_mut() else {
            return Ok(());
        };
        let time = frame.timestamp()?.Duration;
        let _ = self.shared.t0.compare_exchange(0, time, Ordering::AcqRel, Ordering::Acquire);
        {
            let mut segment = self.shared.segment.lock().unwrap();
            let length = time - segment.start;
            let due = SEGMENT_HNS + segment.delay;
            if segment.frames > 0 && !segment.asked && length >= due - PREPARE_HNS {
                segment.asked = true;
                prepare_next(&self.shared, segment.index + 1);
            }
            // Every 30 s a new file starts; the finished one is closed on its own thread.
            if segment.frames > 0 && length >= due {
                let next = segment.index + 1;
                match self.shared.take_next(next) {
                    // Still being made: the current file goes on a little longer.
                    None => {}
                    Some(Ok(next_encoder)) => {
                        let finished = std::mem::replace(encoder, next_encoder);
                        let t0 = self.shared.t0.load(Ordering::Acquire);
                        let done = Segment { file: segment_name(segment.index), start_ms: hns_to_ms(segment.start - t0), end_ms: hns_to_ms(time - t0), frames: segment.frames };
                        let shared = self.shared.clone();
                        let handle = thread::spawn(move || {
                            if finished.finish().is_ok() {
                                shared.segment_done(done);
                            }
                        });
                        self.shared.finishing.lock().unwrap().push(handle);
                        *segment = SegmentState { index: next, start: time, ..SegmentState::default() };
                    }
                    // Keeps writing to the current file and tries again later, instead of ending the capture.
                    Some(Err(error)) => {
                        if segment.delay == 0 {
                            self.shared.notes.lock().unwrap().push(format!("Um trecho do vídeo ficou mais longo: o próximo não pôde ser criado ({error})."));
                        }
                        segment.delay += RETRY_HNS;
                        segment.asked = false;
                    }
                }
            }
            if segment.frames == 0 {
                segment.start = time;
            }
            segment.frames += 1;
        }
        encoder.send_frame(frame)?;
        if self.shared.frames.fetch_add(1, Ordering::Relaxed) == THUMB_FRAME {
            save_thumbnail(&self.shared, frame);
        }
        Ok(())
    }
}

/// The capture source; `GraphicsCaptureItemType` itself isn't `Send`, so the raw source travels
/// to the capture thread and is converted there.
enum Item {
    Monitor(Monitor),
    Window(Window),
}

struct CaptureOptions {
    cursor: CursorCaptureSettings,
    interval: MinimumUpdateIntervalSettings,
}

fn launch<T>(source: T, options: &CaptureOptions, shared: Arc<Shared>) -> Result<CaptureControl<Capture, CaptureError>, String>
where
    T: TryInto<GraphicsCaptureItemType> + Send + 'static,
{
    let settings = Settings::new(
        source,
        options.cursor,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        options.interval,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        shared,
    );
    Capture::start_free_threaded(settings).map_err(|error| error.to_string())
}

/// Roughly 0.15 bits per pixel per frame for H.264 screen content, kept within sane limits.
fn bitrate(width: u32, height: u32, fps: u32) -> u32 {
    let bits = width as f64 * height as f64 * fps as f64 * 0.15;
    bits.clamp(8_000_000.0, 80_000_000.0) as u32
}

pub struct Status {
    /// Recorded time, not counting pauses.
    pub elapsed_ms: f64,
    pub frames: u64,
    pub closed: bool,
    pub paused: bool,
    /// Why the capture stopped on its own, if it did; the take still has to be stopped.
    pub error: Option<String>,
}

pub struct Recording {
    shared: Arc<Shared>,
    control: CaptureControl<Capture, CaptureError>,
    audio: Vec<(&'static str, JoinHandle<anyhow::Result<()>>)>,
    cursor: cursor::Logger,
    /// Appends input events to disk while recording.
    saver: Option<JoinHandle<()>>,
    meta: TakeMeta,
    dir: PathBuf,
    /// When the current pause began, in ms on the take's timeline.
    paused_since: Option<f64>,
}

/// `page` (on the desktop) as a crop of the recorded window `window`, in video pixels, with even
/// sides; None when they hardly overlap.
fn page_crop(window: &RECT, page: &RECT, width: u32, height: u32) -> Option<CropRect> {
    let x = (page.left - window.left).clamp(0, width as i32);
    let y = (page.top - window.top).clamp(0, height as i32);
    let right = (page.right - window.left).clamp(0, width as i32);
    let bottom = (page.bottom - window.top).clamp(0, height as i32);
    let (crop_width, crop_height) = ((right - x) & !1, (bottom - y) & !1);
    (crop_width >= 100 && crop_height >= 100).then_some(CropRect { x, y, width: crop_width, height: crop_height })
}

struct Target {
    kind: &'static str,
    name: String,
    rect: RECT,
}

impl Recording {
    pub fn start(options: StartOptions, root: &Path) -> anyhow::Result<Self> {
        sources::use_physical_pixels();
        let fps = options.fps.clamp(15, 120);

        let (target, item) = match &options.source {
            SourceRef::Monitor { index } => {
                let monitor = Monitor::from_index(*index).map_err(|e| anyhow!("monitor {index}: {e}"))?;
                let (rect, _) = sources::monitor_rect(&monitor).context("ler a área do monitor")?;
                let name = monitor.name().unwrap_or_else(|_| format!("Monitor {index}"));
                (Target { kind: "monitor", name, rect }, Item::Monitor(monitor))
            }
            SourceRef::Window { hwnd } => {
                let raw: isize = hwnd.parse().context("hwnd inválido")?;
                let window = Window::from_raw_hwnd(raw as *mut _);
                if !window.is_valid() {
                    bail!("a janela não está mais disponível");
                }
                let rect = sources::window_rect(&window).context("ler a área da janela")?;
                let name = window.title().unwrap_or_default();
                (Target { kind: "window", name, rect }, Item::Window(window))
            }
        };

        // H.264 needs even dimensions; dropping one pixel row or column is invisible.
        let width = ((target.rect.right - target.rect.left) as u32) & !1;
        let height = ((target.rect.bottom - target.rect.top) as u32) & !1;
        if width < 2 || height < 2 {
            bail!("área de captura vazia");
        }
        // A browser's page: the whole window is recorded, and the crop leaves out its tabs and
        // address bar (the editor can still widen it).
        let crop = match (&item, options.page_only) {
            (Item::Window(window), true) => sources::page_rect(window).and_then(|page| page_crop(&target.rect, &page, width, height)).or(options.crop),
            _ => options.crop,
        };

        let created = chrono::Local::now();
        let (id, dir) = create_take_dir(root, &format!("take-{}", created.format("%Y%m%d-%H%M%S")))?;

        let shared = Arc::new(Shared {
            encoder: Mutex::new(None),
            t0: AtomicI64::new(0),
            stop: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            frames: AtomicU64::new(0),
            thumbnail: dir.join(THUMB_FILE),
            config: EncoderConfig { dir: dir.clone(), width, height, fps },
            segment: Mutex::new(SegmentState::default()),
            next: Mutex::new(None),
            preparing: AtomicBool::new(false),
            finished: Mutex::new(Vec::new()),
            finishing: Mutex::new(Vec::new()),
            failure: Mutex::new(None),
            notes: Mutex::new(Vec::new()),
            origins: Mutex::new(vec![Origin { time: 0, x: target.rect.left, y: target.rect.top }]),
        });
        // A recorded window can move; its place is followed so mouse positions stay on it.
        let followed = match &item {
            Item::Window(window) => Some(*window),
            Item::Monitor(_) => None,
        };

        let mut warnings = Vec::new();
        let mut audio_threads = Vec::new();
        let cursor = cursor::Logger::start(options.keystrokes, options.draw_zoom).inspect_err(|_| {
            let _ = fs::remove_dir_all(&dir);
        })?;

        let mut system_file = None;
        if options.system_audio {
            let path = dir.join(SYSTEM_FILE);
            let started = WavSink::create(&path).and_then(|sink| audio::spawn(audio::Source::System, shared.clone(), Box::new(sink)));
            match started {
                Ok(handle) => {
                    system_file = Some(SYSTEM_FILE.to_string());
                    audio_threads.push(("áudio do sistema", handle));
                }
                Err(error) => {
                    let _ = fs::remove_file(&path);
                    warnings.push(format!("Áudio do sistema desativado: {error:#}"));
                }
            }
        }
        let mut mic = None;
        if options.microphone {
            let path = dir.join(MIC_FILE);
            let started = WavSink::create(&path)
                .and_then(|sink| audio::spawn(audio::Source::Microphone, shared.clone(), Box::new(sink)));
            match started {
                Ok(handle) => {
                    mic = Some(MIC_FILE.to_string());
                    audio_threads.push(("microfone", handle));
                }
                Err(error) => {
                    let _ = fs::remove_file(&path);
                    warnings.push(format!("Microfone desativado: {error:#}"));
                }
            }
        }

        let cursor_setting = if GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false) {
            if options.show_cursor { CursorCaptureSettings::WithCursor } else { CursorCaptureSettings::WithoutCursor }
        } else {
            CursorCaptureSettings::Default
        };
        let interval = if GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false) {
            MinimumUpdateIntervalSettings::Custom(Duration::from_nanos(1_000_000_000 / fps as u64))
        } else {
            MinimumUpdateIntervalSettings::Default
        };

        let meta = TakeMeta {
            version: 1,
            id,
            created_at: created.to_rfc3339(),
            source_kind: target.kind.into(),
            source_name: target.name,
            width,
            height,
            fps,
            origin_x: target.rect.left,
            origin_y: target.rect.top,
            duration_ms: 0.0,
            frames: 0,
            video: VIDEO_FILE.into(),
            system_audio: system_file.is_some(),
            system_file,
            mic,
            cursor: CURSOR_FILE.into(),
            cursor_in_video: options.show_cursor || cursor_setting == CursorCaptureSettings::Default,
            keys: options.keystrokes.then(|| KEYS_FILE.to_string()),
            webcam: None,
            webcam_offset_ms: None,
            thumbnail: None,
            title: None,
            crop,
            pauses: Vec::new(),
            markers: Vec::new(),
            start_hns: 0,
            warnings,
            segments: Vec::new(),
            dir: String::new(),
        };
        // Everything recovery needs to rebuild take.json if the app never gets to stop. Written
        // before the capture starts, so nothing can fail once it runs.
        if let Err(error) = write_json(&dir.join(RECORDING_FILE), &meta) {
            abandon(&shared, audio_threads, cursor, &dir);
            return Err(error);
        }

        let capture_options = CaptureOptions { cursor: cursor_setting, interval };
        let launched = match item {
            Item::Monitor(monitor) => launch(monitor, &capture_options, shared.clone()),
            Item::Window(window) => launch(window, &capture_options, shared.clone()),
        };
        let control = match launched {
            Ok(control) => control,
            Err(error) => {
                abandon(&shared, audio_threads, cursor, &dir);
                bail!("iniciar a captura: {error}");
            }
        };
        let saver = spawn_saver(shared.clone(), dir.clone(), followed);

        Ok(Self { shared, control, audio: audio_threads, cursor, saver: Some(saver), meta, dir, paused_since: None })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn warnings(&self) -> &[String] {
        &self.meta.warnings
    }

    /// Ms since the first frame.
    fn now_ms(&self) -> f64 {
        let t0 = self.shared.t0.load(Ordering::Acquire);
        if t0 == 0 { 0.0 } else { (now_hns() - t0) as f64 / 10_000.0 }
    }

    pub fn status(&self) -> Status {
        let now = self.now_ms();
        let paused: f64 = self.meta.pauses.iter().map(|span| span.end - span.start).sum::<f64>() + self.paused_since.map_or(0.0, |since| now - since);
        Status {
            elapsed_ms: (now - paused).max(0.0),
            frames: self.shared.frames.load(Ordering::Relaxed),
            closed: self.shared.closed.load(Ordering::Acquire),
            paused: self.paused_since.is_some(),
            error: self.shared.failure.lock().unwrap().clone(),
        }
    }

    /// Pausing keeps capturing (so nothing has to restart), and marks the stretch to be cut.
    pub fn pause(&mut self) {
        if self.paused_since.is_none() {
            self.paused_since = Some(self.now_ms());
        }
    }

    pub fn resume(&mut self) {
        if let Some(start) = self.paused_since.take() {
            self.meta.pauses.push(PauseSpan { start, end: self.now_ms() });
        }
    }

    /// Marks the current moment, to find it again in the editor. Returns how many marks there are.
    pub fn mark(&mut self) -> usize {
        let now = self.now_ms();
        self.meta.markers.push(now);
        self.meta.markers.len()
    }

    pub fn stop(mut self) -> anyhow::Result<TakeMeta> {
        self.resume();
        let Self { shared, control, audio, cursor, saver, mut meta, dir, .. } = self;
        let end = now_hns();
        shared.stop.store(true, Ordering::Release);

        // Audio first: the system track pads itself to `end` while the encoder is still open.
        for (name, handle) in audio {
            match handle.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => meta.warnings.push(format!("Falha no {name}: {error:#}")),
                Err(_) => meta.warnings.push(format!("A thread do {name} travou")),
            }
        }
        let (events, keys) = cursor.stop();
        // A failed stop still leaves finished segments and input events: the take is saved anyway.
        // A capture that already failed reports that failure again here; it is noted once below.
        if let Err(error) = control.stop() {
            if shared.failure.lock().unwrap().is_none() {
                meta.warnings.push(format!("Falha ao parar a captura: {error}"));
            }
        }
        // After the capture, so waiting for it never adds frames past the stop.
        if let Some(saver) = saver {
            let _ = saver.join();
        }

        let encoder = shared.encoder.lock().unwrap().take();
        let Some(encoder) = encoder else {
            bail!("o codificador de vídeo não foi criado");
        };
        let last_finished = match encoder.finish() {
            Ok(()) => true,
            Err(error) => {
                meta.warnings.push(format!("O último trecho do vídeo se perdeu ao finalizar: {error}"));
                false
            }
        };
        for handle in shared.finishing.lock().unwrap().drain(..) {
            let _ = handle.join();
        }

        let t0 = shared.t0.load(Ordering::Acquire);
        let last = std::mem::take(&mut *shared.segment.lock().unwrap());
        if last.frames > 0 && last_finished {
            shared.segment_done(Segment { file: segment_name(last.index), start_ms: hns_to_ms(last.start - t0), end_ms: hns_to_ms(end - t0), frames: last.frames });
        }
        // An encoder made ahead for a segment that never started, and its empty file.
        drop(shared.next.lock().unwrap().take());
        let _ = fs::remove_file(dir.join(segment_name(last.index + 1)));
        meta.segments = shared.finished.lock().unwrap().clone();
        if let Some(error) = shared.failure.lock().unwrap().clone() {
            meta.warnings.push(if error == DISK_FULL { error } else { format!("A captura de vídeo parou antes da hora: {error}") });
        }
        meta.warnings.append(&mut shared.notes.lock().unwrap());
        if t0 == 0 {
            meta.warnings.push("Nenhum quadro foi capturado.".into());
        }
        meta.duration_ms = if t0 == 0 { 0.0 } else { (end - t0) as f64 / 10_000.0 };
        meta.frames = shared.frames.load(Ordering::Relaxed);
        meta.start_hns = t0;
        meta.thumbnail = dir.join(THUMB_FILE).exists().then(|| THUMB_FILE.to_string());

        write_json(&dir.join(CURSOR_FILE), &cursor_track(&events, t0, &shared.origins.lock().unwrap()))?;
        if meta.keys.is_some() {
            write_json(&dir.join(KEYS_FILE), &key_track(&keys, t0))?;
        }
        {
            let _guard = META_LOCK.lock().unwrap();
            write_json(&dir.join(META_FILE), &meta)?;
        }
        for partial in [CURSOR_PARTIAL, KEYS_PARTIAL, RECORDING_FILE] {
            let _ = fs::remove_file(dir.join(partial));
        }
        meta.dir = dir.to_string_lossy().into_owned();
        Ok(meta)
    }
}

/// Creates a new folder for a take; a take started in the same second gets a `-2`, `-3`… suffix.
pub(crate) fn create_take_dir(root: &Path, base: &str) -> anyhow::Result<(String, PathBuf)> {
    fs::create_dir_all(root).with_context(|| format!("criar {}", root.display()))?;
    for attempt in 1..100 {
        let id = if attempt == 1 { base.to_string() } else { format!("{base}-{attempt}") };
        let dir = root.join(&id);
        match fs::create_dir(&dir) {
            Ok(()) => return Ok((id, dir)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).with_context(|| format!("criar {}", dir.display())),
        }
    }
    bail!("criar a pasta da gravação em {}", root.display())
}

/// Stops what a take that failed to start had started, and removes its folder.
fn abandon(shared: &Shared, audio: Vec<(&'static str, JoinHandle<anyhow::Result<()>>)>, cursor: cursor::Logger, dir: &Path) {
    shared.stop.store(true, Ordering::Release);
    for (_, handle) in audio {
        let _ = handle.join();
    }
    let _ = cursor.stop();
    let _ = fs::remove_dir_all(dir);
}

/// Notes where a recorded window is when it has moved. A minimized window keeps its last place.
fn follow(shared: &Shared, window: &Window) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::IsIconic;

    if unsafe { IsIconic(HWND(window.as_raw_hwnd())) }.as_bool() {
        return;
    }
    let Some(rect) = sources::window_rect(window) else {
        return;
    };
    let mut origins = shared.origins.lock().unwrap();
    if origins.last().is_none_or(|origin| (origin.x, origin.y) != (rect.left, rect.top)) {
        origins.push(Origin { time: now_hns(), x: rect.left, y: rect.top });
    }
}

/// Below this much free space a recording doesn't start, and one in progress stops.
pub const DISK_STOP_BYTES: u64 = 300 * 1024 * 1024;
/// How often the saver looks at the free space while recording.
const DISK_EVERY: Duration = Duration::from_secs(5);
pub const DISK_FULL: &str = "O disco está quase cheio; a gravação parou para não se perder.";

/// Free space for the user on the drive holding `path` (or its nearest existing parent).
pub fn free_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::core::PCWSTR;

    let existing = path.ancestors().find(|candidate| candidate.exists())?;
    let wide: Vec<u16> = existing.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}

/// Appends new mouse and key events to disk every few seconds, already on the take's timeline,
/// so an interrupted take keeps them. Also follows a recorded window's place, and ends the
/// capture (through `fail`, like any capture error) before the disk fills up.
fn spawn_saver(shared: Arc<Shared>, dir: PathBuf, window: Option<Window>) -> JoinHandle<()> {
    thread::spawn(move || {
        // Window bounds in physical pixels, like the capture and the mouse events.
        sources::use_physical_pixels();
        let (mut events_done, mut keys_done) = (0, 0);
        let mut disk_checked = std::time::Instant::now();
        loop {
            let stopping = shared.stop.load(Ordering::Acquire);
            if disk_checked.elapsed() >= DISK_EVERY {
                disk_checked = std::time::Instant::now();
                if free_space(&dir).is_some_and(|free| free < DISK_STOP_BYTES) {
                    shared.fail(DISK_FULL.into());
                }
            }
            let t0 = shared.t0.load(Ordering::Acquire);
            if t0 != 0 {
                let (events, keys) = cursor::since(events_done, keys_done);
                events_done += events.len();
                keys_done += keys.len();
                let lines = |values: Vec<serde_json::Value>| values.iter().map(|value| format!("{value}\n")).collect::<String>();
                let track = serde_json::to_value(cursor_track(&events, t0, &shared.origins.lock().unwrap())).unwrap_or_default();
                append(&dir.join(CURSOR_PARTIAL), &lines(track["events"].as_array().cloned().unwrap_or_default()));
                let keys = key_track(&keys, t0);
                append(&dir.join(KEYS_PARTIAL), &lines(keys["events"].as_array().cloned().unwrap_or_default()));
            }
            if stopping {
                break;
            }
            // Short naps, so a stop is noticed at once and a moving window is followed closely.
            let started = std::time::Instant::now();
            while started.elapsed() < PARTIAL_EVERY && !shared.stop.load(Ordering::Acquire) {
                if let Some(window) = &window {
                    follow(&shared, window);
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    })
}

fn append(path: &Path, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(text.as_bytes());
    }
}

/// Rebuilds `take.json` for a take whose app stopped mid-recording: up to the last finished
/// segment, with the mouse and key events saved so far. Returns false when nothing is usable.
fn recover(dir: &Path) -> bool {
    let read = |name: &str| fs::read_to_string(dir.join(name)).ok().and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let Some(mut meta) = read(RECORDING_FILE).and_then(|value| serde_json::from_value::<TakeMeta>(value).ok()) else {
        return false;
    };
    let Some(list) = read(SEGMENTS_FILE) else {
        return false;
    };
    let segments: Vec<Segment> = serde_json::from_value(list["segments"].clone()).unwrap_or_default();
    let Some(last) = segments.last() else {
        return false;
    };
    let partial_events = |name: &str| -> Vec<serde_json::Value> {
        fs::read_to_string(dir.join(name)).unwrap_or_default().lines().filter_map(|line| serde_json::from_str(line).ok()).collect()
    };
    let _ = write_json(&dir.join(CURSOR_FILE), &serde_json::json!({ "version": 2, "events": partial_events(CURSOR_PARTIAL) }));
    if meta.keys.is_some() {
        let _ = write_json(&dir.join(KEYS_FILE), &serde_json::json!({ "version": 1, "events": partial_events(KEYS_PARTIAL) }));
    }
    meta.duration_ms = last.end_ms;
    meta.frames = segments.iter().map(|segment| segment.frames).sum();
    meta.start_hns = list["t0"].as_i64().unwrap_or(0);
    meta.thumbnail = dir.join(THUMB_FILE).exists().then(|| THUMB_FILE.to_string());
    let total = (last.end_ms / 1000.0) as u64;
    meta.warnings.push(format!(
        "Esta gravação foi interrompida e recuperada até {}:{:02}. O que veio depois desse ponto se perdeu.",
        total / 60,
        total % 60
    ));
    meta.title = Some("Gravação recuperada".into());
    meta.segments = segments;
    let _guard = META_LOCK.lock().unwrap();
    write_json(&dir.join(META_FILE), &meta).is_ok()
}

/// Guards every read-modify-write of `take.json`: commands that change it can run at once.
static META_LOCK: Mutex<()> = Mutex::new(());

/// Reads a take's `take.json`, applies `change` and writes it back. Returns the new metadata,
/// without `dir`.
pub fn update_meta(dir: &Path, change: impl FnOnce(&mut TakeMeta) -> anyhow::Result<()>) -> anyhow::Result<TakeMeta> {
    let _guard = META_LOCK.lock().unwrap();
    let path = dir.join(META_FILE);
    let text = fs::read_to_string(&path).with_context(|| format!("ler {}", path.display()))?;
    let mut meta: TakeMeta = serde_json::from_str(&text)?;
    change(&mut meta)?;
    write_json(&path, &meta)?;
    Ok(meta)
}

/// Called once the frontend has joined the segments into the video file: removes them.
pub fn segments_joined(dir: &Path) -> anyhow::Result<TakeMeta> {
    let mut meta = update_meta(dir, |meta| {
        let video = dir.join(&meta.video);
        if !fs::metadata(&video).is_ok_and(|file| file.len() > 0) {
            bail!("o vídeo juntado não foi encontrado");
        }
        meta.segments.clear();
        Ok(())
    })?;
    let _ = fs::remove_dir_all(dir.join(SEGMENT_DIR));
    for leftover in [SEGMENTS_FILE, RECORDING_FILE, CURSOR_PARTIAL, KEYS_PARTIAL] {
        let _ = fs::remove_file(dir.join(leftover));
    }
    meta.dir = dir.to_string_lossy().into_owned();
    Ok(meta)
}

#[derive(Serialize)]
struct CursorEvent {
    /// Milliseconds from the first video frame.
    t: f64,
    k: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    b: Option<Button>,
    x: i32,
    y: i32,
    #[serde(skip_serializing_if = "is_zero")]
    w: i16,
    #[serde(skip_serializing_if = "Option::is_none")]
    c: Option<Shape>,
}

fn is_zero(value: &i16) -> bool {
    *value == 0
}

#[derive(Serialize)]
struct CursorTrack {
    version: u32,
    events: Vec<CursorEvent>,
}

/// Puts events on the take's timeline in video pixels, keeping the last one before the start as
/// the initial position. Each event is placed against where the captured area was at that time.
fn cursor_track(events: &[RawEvent], t0: i64, origins: &[Origin]) -> CursorTrack {
    let last_before = |shape: bool| events.iter().rposition(|event| event.time <= t0 && matches!(event.kind, Kind::Shape) == shape);
    let (first_move, first_shape) = (last_before(false), last_before(true));
    let events = events
        .iter()
        .enumerate()
        .filter(|(index, event)| event.time > t0 || Some(*index) == first_move || Some(*index) == first_shape)
        .map(|(_, event)| {
            let origin = origin_at(origins, event.time);
            CursorEvent {
                t: (((event.time - t0).max(0) as f64 / (HNS_PER_SEC as f64 / 1000.0)) * 10.0).round() / 10.0,
                k: event.kind,
                b: event.button,
                x: event.x - origin.x,
                y: event.y - origin.y,
                w: event.wheel,
                c: event.shape,
            }
        })
        .collect();
    CursorTrack { version: 2, events }
}

#[derive(Serialize)]
struct KeyEvent {
    t: f64,
    n: String,
    m: Vec<&'static str>,
}

fn key_track(keys: &[KeyPress], t0: i64) -> serde_json::Value {
    let events: Vec<KeyEvent> = keys
        .iter()
        .filter(|key| key.time >= t0)
        .map(|key| KeyEvent {
            t: (((key.time - t0) as f64 / (HNS_PER_SEC as f64 / 1000.0)) * 10.0).round() / 10.0,
            n: key.name.clone(),
            m: key.modifiers.clone(),
        })
        .collect();
    serde_json::json!({ "version": 1, "events": events })
}

/// Writes then renames, so a crash mid-write never leaves a truncated file.
pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    let json = serde_json::to_vec_pretty(value)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, json).with_context(|| format!("gravar {}", temporary.display()))?;
    fs::rename(&temporary, path).with_context(|| format!("gravar {}", path.display()))
}

/// Removes a take folder left by a recording that never got going (app closed at the start): no
/// `take.json`, nothing but empty files, untouched for 10 minutes. Anything with data is kept.
fn remove_if_abandoned(dir: &Path) {
    let name = dir.file_name().map(|name| name.to_string_lossy().starts_with("take-")).unwrap_or(false);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let files: Vec<fs::Metadata> = entries.filter_map(Result::ok).filter_map(|entry| entry.metadata().ok()).collect();
    let all_empty = files.iter().all(|file| file.is_file() && file.len() == 0);
    let stale = fs::metadata(dir)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > Duration::from_secs(600));
    if name && all_empty && stale {
        let _ = fs::remove_dir_all(dir);
    }
}

/// Takes in `root`, newest first. Folders without a readable `take.json` are skipped, and so is
/// `active`, the take being recorded or stopped: it isn't interrupted, so it must not be recovered.
pub fn list_takes(root: &Path, active: Option<&Path>) -> Vec<TakeMeta> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut takes: Vec<TakeMeta> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let dir = entry.path();
            if active == Some(dir.as_path()) {
                return None;
            }
            if !dir.join(META_FILE).exists() && !(dir.join(RECORDING_FILE).exists() && recover(&dir)) {
                remove_if_abandoned(&dir);
                return None;
            }
            let text = fs::read_to_string(dir.join(META_FILE)).ok()?;
            let mut meta: TakeMeta = serde_json::from_str(&text).ok()?;
            meta.dir = dir.to_string_lossy().into_owned();
            Some(meta)
        })
        .collect();
    takes.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    takes
}
