use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Context as _, anyhow, bail};
use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::RECT;
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType,
};
use windows_capture::encoder::ImageFormat;
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, GraphicsCaptureItemType,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use crate::audio::{self, EncoderSink, WavSink};
use crate::clock::{HNS_PER_SEC, now_hns};
use crate::cursor::{self, Button, KeyPress, Kind, RawEvent, Shape};
use crate::sources;

pub const META_FILE: &str = "take.json";
const VIDEO_FILE: &str = "screen.mp4";
const MIC_FILE: &str = "mic.wav";
const CURSOR_FILE: &str = "cursor.json";
const KEYS_FILE: &str = "keys.json";
const THUMB_FILE: &str = "thumb.jpg";
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
    /// Area picked before recording, in video pixels; becomes the take's initial crop.
    #[serde(default)]
    pub crop: Option<CropRect>,
    pub fps: u32,
}

/// A paused stretch of the take, in ms from the first frame. The editor starts with it cut.
#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct PauseSpan {
    pub start: f64,
    pub end: f64,
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
    /// Filled in when listing; not stored.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub dir: String,
}

struct EncoderConfig {
    path: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
}

/// State shared by the capture thread, the audio threads and the command that stops the take.
pub struct Shared {
    pub encoder: Mutex<Option<VideoEncoder>>,
    /// QPC time (100 ns) of the first video frame; 0 until it arrives. Every track starts here.
    pub t0: AtomicI64,
    pub stop: AtomicBool,
    pub closed: AtomicBool,
    pub frames: AtomicU64,
    system_audio: AtomicBool,
    thumbnail: PathBuf,
    config: EncoderConfig,
}

struct Capture {
    shared: Arc<Shared>,
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = Arc<Shared>;
    type Error = CaptureError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let shared = ctx.flags;
        let config = &shared.config;
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(config.width, config.height)
                .sub_type(VideoSettingsSubType::H264)
                .frame_rate(config.fps)
                .bitrate(bitrate(config.width, config.height, config.fps)),
            AudioSettingsBuilder::new().disabled(!shared.system_audio.load(Ordering::Acquire)),
            ContainerSettingsBuilder::new(),
            &config.path,
        )?;
        *shared.encoder.lock().unwrap() = Some(encoder);
        Ok(Self { shared })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, _control: InternalCaptureControl) -> Result<(), Self::Error> {
        let mut encoder = self.shared.encoder.lock().unwrap();
        let Some(encoder) = encoder.as_mut() else {
            return Ok(());
        };
        // Set while holding the encoder lock, so no audio reaches the encoder before this frame.
        let _ = self.shared.t0.compare_exchange(0, frame.timestamp()?.Duration, Ordering::AcqRel, Ordering::Acquire);
        encoder.send_frame(frame)?;
        if self.shared.frames.fetch_add(1, Ordering::Relaxed) == THUMB_FRAME {
            let _ = frame.save_as_image(&self.shared.thumbnail, ImageFormat::Jpeg);
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.shared.closed.store(true, Ordering::Release);
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
}

pub struct Recording {
    shared: Arc<Shared>,
    control: CaptureControl<Capture, CaptureError>,
    audio: Vec<(&'static str, JoinHandle<anyhow::Result<()>>)>,
    cursor: cursor::Logger,
    meta: TakeMeta,
    dir: PathBuf,
    /// When the current pause began, in ms on the take's timeline.
    paused_since: Option<f64>,
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

        let created = chrono::Local::now();
        let id = format!("take-{}", created.format("%Y%m%d-%H%M%S"));
        let dir = root.join(&id);
        fs::create_dir_all(&dir).with_context(|| format!("criar {}", dir.display()))?;

        let shared = Arc::new(Shared {
            encoder: Mutex::new(None),
            t0: AtomicI64::new(0),
            stop: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            frames: AtomicU64::new(0),
            system_audio: AtomicBool::new(false),
            thumbnail: dir.join(THUMB_FILE),
            config: EncoderConfig { path: dir.join(VIDEO_FILE), width, height, fps },
        });

        let mut warnings = Vec::new();
        let mut audio_threads = Vec::new();
        let cursor = cursor::Logger::start(options.keystrokes)?;

        if options.system_audio {
            match audio::spawn(audio::Source::System, shared.clone(), Box::new(EncoderSink(shared.clone()))) {
                Ok(handle) => {
                    shared.system_audio.store(true, Ordering::Release);
                    audio_threads.push(("áudio do sistema", handle));
                }
                Err(error) => warnings.push(format!("Áudio do sistema desativado: {error:#}")),
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

        let capture_options = CaptureOptions { cursor: cursor_setting, interval };
        let launched = match item {
            Item::Monitor(monitor) => launch(monitor, &capture_options, shared.clone()),
            Item::Window(window) => launch(window, &capture_options, shared.clone()),
        };
        let control = match launched {
            Ok(control) => control,
            Err(error) => {
                shared.stop.store(true, Ordering::Release);
                for (_, handle) in audio_threads {
                    let _ = handle.join();
                }
                let _ = cursor.stop();
                let _ = fs::remove_dir_all(&dir);
                bail!("iniciar a captura: {error}");
            }
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
            system_audio: shared.system_audio.load(Ordering::Acquire),
            mic,
            cursor: CURSOR_FILE.into(),
            cursor_in_video: options.show_cursor || cursor_setting == CursorCaptureSettings::Default,
            keys: options.keystrokes.then(|| KEYS_FILE.to_string()),
            webcam: None,
            webcam_offset_ms: None,
            thumbnail: None,
            title: None,
            crop: options.crop,
            pauses: Vec::new(),
            markers: Vec::new(),
            start_hns: 0,
            warnings,
            dir: String::new(),
        };

        Ok(Self { shared, control, audio: audio_threads, cursor, meta, dir, paused_since: None })
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
        let Self { shared, control, audio, cursor, mut meta, dir, .. } = self;
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
        control.stop().map_err(|error| anyhow!("parar a captura: {error}"))?;

        let encoder = shared.encoder.lock().unwrap().take();
        match encoder {
            Some(encoder) => encoder.finish().map_err(|error| anyhow!("finalizar o vídeo: {error}"))?,
            None => bail!("o codificador de vídeo não foi criado"),
        }

        let t0 = shared.t0.load(Ordering::Acquire);
        if t0 == 0 {
            meta.warnings.push("Nenhum quadro foi capturado.".into());
        }
        meta.duration_ms = if t0 == 0 { 0.0 } else { (end - t0) as f64 / 10_000.0 };
        meta.frames = shared.frames.load(Ordering::Relaxed);
        meta.start_hns = t0;
        meta.thumbnail = dir.join(THUMB_FILE).exists().then(|| THUMB_FILE.to_string());

        write_json(&dir.join(CURSOR_FILE), &cursor_track(&events, t0, meta.origin_x, meta.origin_y))?;
        if meta.keys.is_some() {
            write_json(&dir.join(KEYS_FILE), &key_track(&keys, t0))?;
        }
        write_json(&dir.join(META_FILE), &meta)?;
        meta.dir = dir.to_string_lossy().into_owned();
        Ok(meta)
    }
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
/// the initial position.
fn cursor_track(events: &[RawEvent], t0: i64, origin_x: i32, origin_y: i32) -> CursorTrack {
    let last_before = |shape: bool| events.iter().rposition(|event| event.time <= t0 && matches!(event.kind, Kind::Shape) == shape);
    let (first_move, first_shape) = (last_before(false), last_before(true));
    let events = events
        .iter()
        .enumerate()
        .filter(|(index, event)| event.time > t0 || Some(*index) == first_move || Some(*index) == first_shape)
        .map(|(_, event)| CursorEvent {
            t: (((event.time - t0).max(0) as f64 / (HNS_PER_SEC as f64 / 1000.0)) * 10.0).round() / 10.0,
            k: event.kind,
            b: event.button,
            x: event.x - origin_x,
            y: event.y - origin_y,
            w: event.wheel,
            c: event.shape,
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

fn write_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    let json = serde_json::to_vec_pretty(value)?;
    fs::write(path, json).with_context(|| format!("gravar {}", path.display()))
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

/// Takes in `root`, newest first. Folders without a readable `take.json` are skipped.
pub fn list_takes(root: &Path) -> Vec<TakeMeta> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut takes: Vec<TakeMeta> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let dir = entry.path();
            if !dir.join(META_FILE).exists() {
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
