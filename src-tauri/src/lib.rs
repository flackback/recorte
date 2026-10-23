mod audio;
mod clock;
mod ai;
mod control;
mod cursor;
mod export;
mod meter;
mod overlay;
pub mod recorder;
mod search;
pub mod sources;
mod voice;

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use recorder::{Recording, StartOptions, TakeMeta};

const PROJECT_FILE: &str = "project.json";

#[derive(Default)]
struct AppState {
    recording: Mutex<Option<Recording>>,
    /// Set while a recording starts, which takes seconds, so `recording` isn't locked meanwhile.
    starting: AtomicBool,
    /// Folder of the take being recorded or stopped, which the takes list must leave alone.
    active: Mutex<Option<PathBuf>>,
}

/// Clears `AppState::starting` however the start ends.
struct Starting<'a>(&'a AtomicBool);

impl Drop for Starting<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    warnings: Vec<String>,
    /// Take folder, so the frontend can save the webcam recording next to the screen.
    dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    recording: bool,
    elapsed_ms: f64,
    frames: u64,
    closed: bool,
    paused: bool,
    /// Why the capture stopped on its own (the take still has to be stopped), or null.
    error: Option<String>,
}

pub(crate) fn takes_root(app: &AppHandle) -> Result<PathBuf, String> {
    let videos = app.path().video_dir().map_err(|error| error.to_string())?;
    Ok(videos.join("Recorte"))
}

/// Runs blocking capture work off the main thread and the async runtime's workers.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_sources() -> Result<sources::Sources, String> {
    blocking(|| sources::list().map_err(|error| format!("{error:#}"))).await
}

#[tauri::command]
async fn start_recording(app: AppHandle, options: StartOptions) -> Result<Started, String> {
    let root = takes_root(&app)?;
    blocking(move || {
        let state = app.state::<AppState>();
        if state.recording.lock().unwrap().is_some() || state.starting.swap(true, Ordering::AcqRel) {
            return Err("já existe uma gravação em andamento".into());
        }
        let _starting = Starting(&state.starting);
        // A take that can't fit on the disk is refused here; one that fills it is stopped by the saver.
        if recorder::free_space(&root).is_some_and(|free| free < recorder::DISK_STOP_BYTES) {
            return Err("Não há espaço livre suficiente no disco das gravações (menos de 300 MB). Libere espaço e grave de novo.".into());
        }
        // The recording reads the devices itself; the idle level meter is no longer needed.
        meter::meter_stop();
        let recording = Recording::start(options, &root).map_err(|error| format!("{error:#}"))?;
        let warnings = recording.warnings().to_vec();
        let dir = recording.dir().to_string_lossy().into_owned();
        *state.active.lock().unwrap() = Some(recording.dir().to_path_buf());
        *state.recording.lock().unwrap() = Some(recording);
        Ok(Started { warnings, dir })
    })
    .await
}

#[tauri::command]
async fn stop_recording(app: AppHandle) -> Result<TakeMeta, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let recording = state.recording.lock().unwrap().take();
        let recording = recording.ok_or("nenhuma gravação em andamento")?;
        let stopped = recording.stop().map_err(|error| format!("{error:#}"));
        *state.active.lock().unwrap() = None;
        stopped
    })
    .await
}

#[tauri::command]
fn recording_status(app: AppHandle) -> Status {
    let state = app.state::<AppState>();
    let recording = state.recording.lock().unwrap();
    match recording.as_ref().map(Recording::status) {
        Some(status) => Status { recording: true, elapsed_ms: status.elapsed_ms, frames: status.frames, closed: status.closed, paused: status.paused, error: status.error },
        None => Status { recording: false, elapsed_ms: 0.0, frames: 0, closed: false, paused: false, error: None },
    }
}

/// Pauses or resumes the recording; paused stretches open in the editor already cut.
#[tauri::command]
fn recording_pause(app: AppHandle, paused: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut recording = state.recording.lock().unwrap();
    let recording = recording.as_mut().ok_or("nenhuma gravação em andamento")?;
    if paused {
        recording.pause();
    } else {
        recording.resume();
    }
    Ok(())
}

/// Marks the current moment of the recording; returns how many marks there are.
#[tauri::command]
fn recording_mark(app: AppHandle) -> Result<usize, String> {
    let state = app.state::<AppState>();
    let mut recording = state.recording.lock().unwrap();
    Ok(recording.as_mut().ok_or("nenhuma gravação em andamento")?.mark())
}

#[tauri::command]
async fn list_takes(app: AppHandle) -> Result<Vec<TakeMeta>, String> {
    let root = takes_root(&app)?;
    blocking(move || {
        let active = app.state::<AppState>().active.lock().unwrap().clone();
        Ok(recorder::list_takes(&root, active.as_deref()))
    })
    .await
}

/// Free bytes on the drive of the takes folder, or null if it can't be read.
#[tauri::command]
fn disk_free(app: AppHandle) -> Result<Option<u64>, String> {
    Ok(recorder::free_space(&takes_root(&app)?))
}

/// Takes whose transcript has every word of `query`, with a bit of text around the match.
#[tauri::command]
async fn takes_search(app: AppHandle, query: String) -> Result<Vec<search::Hit>, String> {
    let root = takes_root(&app)?;
    blocking(move || Ok(search::search(&root, &query))).await
}

#[tauri::command]
fn takes_dir(app: AppHandle) -> Result<String, String> {
    Ok(takes_root(&app)?.to_string_lossy().into_owned())
}

/// Called after the frontend joined a take's segments into its video: removes the segments.
#[tauri::command]
async fn take_segments_joined(app: AppHandle, dir: String) -> Result<TakeMeta, String> {
    let dir = take_dir(&app, &dir)?;
    blocking(move || recorder::segments_joined(&dir).map_err(|error| format!("{error:#}"))).await
}

/// Opens the takes folder in Explorer, creating it first if nothing was recorded yet.
#[tauri::command]
fn takes_dir_open(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = takes_root(&app)?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|error| error.to_string())
}

/// The take folder for `dir`, refusing anything outside the takes root so the frontend can't
/// write elsewhere on disk.
pub(crate) fn take_dir(app: &AppHandle, dir: &str) -> Result<PathBuf, String> {
    let root = takes_root(app)?.canonicalize().map_err(|error| error.to_string())?;
    let dir = PathBuf::from(dir).canonicalize().map_err(|error| error.to_string())?;
    if dir.parent() != Some(root.as_path()) {
        return Err("pasta de gravação inválida".into());
    }
    Ok(dir)
}

/// The QPC clock (100 ns), to line up streams recorded in the WebView (webcam) with the take.
#[tauri::command]
fn clock_now() -> i64 {
    clock::now_hns()
}

/// Renames a take in the list (an empty title goes back to the source name).
#[tauri::command]
fn take_rename(app: AppHandle, dir: String, title: String) -> Result<(), String> {
    let dir = take_dir(&app, &dir)?;
    let title = title.trim();
    let renamed = recorder::update_meta(&dir, |meta| {
        meta.title = (!title.is_empty()).then(|| title.chars().take(120).collect());
        Ok(())
    });
    renamed.map(drop).map_err(|error| format!("{error:#}"))
}

/// Moves a take's folder to the Recycle Bin, so it can still be restored from there.
#[tauri::command]
fn take_trash(app: AppHandle, dir: String) -> Result<(), String> {
    let dir = take_dir(&app, &dir)?;
    trash::delete(&dir).map_err(|error| format!("mover para a Lixeira: {error}"))
}

/// Records the webcam file and its offset in `take.json` after the frontend saved it.
#[tauri::command]
fn take_set_webcam(app: AppHandle, dir: String, file: String, started_hns: i64) -> Result<TakeMeta, String> {
    let dir = take_dir(&app, &dir)?;
    let updated = recorder::update_meta(&dir, |meta| {
        meta.webcam = Some(file);
        meta.webcam_offset_ms = Some((started_hns - meta.start_hns) as f64 / 10_000.0);
        Ok(())
    });
    let mut meta = updated.map_err(|error| format!("{error:#}"))?;
    meta.dir = dir.to_string_lossy().into_owned();
    Ok(meta)
}

/// Writes `mic.enhanced.wav` next to the microphone track: denoised and leveled.
#[tauri::command]
async fn enhance_voice(app: AppHandle, dir: String) -> Result<String, String> {
    let dir = take_dir(&app, &dir)?;
    blocking(move || {
        let output = dir.join("mic.enhanced.wav");
        voice::enhance(&dir.join("mic.wav"), &output).map_err(|error| format!("{error:#}"))?;
        Ok("mic.enhanced.wav".to_string())
    })
    .await
}

/// The edit for a take, or `None` if it was never edited.
#[tauri::command]
fn load_project(app: AppHandle, dir: String) -> Result<Option<String>, String> {
    let path = take_dir(&app, &dir)?.join(PROJECT_FILE);
    match std::fs::read_to_string(path) {
        Ok(json) => Ok(Some(json)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_project(app: AppHandle, dir: String, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|error| format!("projeto inválido: {error}"))?;
    let path = take_dir(&app, &dir)?.join(PROJECT_FILE);
    // Write then rename, so a crash mid-save never leaves a truncated project.
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, json).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

/// Hides a window from every screen capture, or shows it again. Hidden windows also vanish from
/// screen sharing and remote access (AnyDesk, Meet), so only recording-time windows stay hidden.
/// `RECORTE_CAPTURABLE=1` never hides, for screenshots and UI automation during development.
fn set_capture_hidden(window: &tauri::WebviewWindow, hidden: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};

    if hidden && std::env::var_os("RECORTE_CAPTURABLE").is_some_and(|value| value == "1") {
        return;
    }
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = SetWindowDisplayAffinity(HWND(hwnd.0 as _), if hidden { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE });
        }
    }
}

/// Keeps a window out of every recording (the floating recording bar, the overlays).
pub(crate) fn exclude_window(window: &tauri::WebviewWindow) {
    set_capture_hidden(window, true);
}

/// The main window is hidden from captures only while recording, so it stays visible over
/// remote access and screen sharing the rest of the time.
#[tauri::command]
fn main_window_capture(app: AppHandle, hidden: bool) {
    if let Some(window) = app.get_webview_window("main") {
        set_capture_hidden(&window, hidden);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(overlay::on_shortcut).build())
        .manage(AppState::default())
        .manage(export::Exports::default())
        .manage(control::Pending::default())
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            // One at a time: a shortcut another program already owns only loses that shortcut.
            for shortcut in [overlay::draw_shortcut(), overlay::stop_shortcut(), overlay::record_shortcut(), overlay::mark_shortcut()] {
                if let Err(error) = app.global_shortcut().register(shortcut) {
                    eprintln!("atalho global {shortcut} indisponível: {error}");
                }
            }
            if control::enabled(app.handle()) {
                if let Err(error) = control::start(app.handle()) {
                    eprintln!("canal do MCP desligado: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sources,
            start_recording,
            stop_recording,
            recording_status,
            list_takes,
            takes_dir,
            takes_dir_open,
            take_segments_joined,
            load_project,
            save_project,
            export::export_create,
            export::export_write,
            export::export_finish,
            export::export_cancel,
            export::asset_create,
            clock_now,
            take_set_webcam,
            enhance_voice,
            take_rename,
            recording_pause,
            recording_mark,
            main_window_capture,
            overlay::recbar_open,
            overlay::recbar_close,
            take_trash,
            overlay::overlay_open,
            overlay::overlay_close,
            control::agent_reply,
            control::ai_set_enabled,
            ai::ai_status,
            ai::ai_connect,
            meter::audio_levels,
            meter::meter_start,
            meter::meter_stop,
            disk_free,
            takes_search
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                control::stop(app);
            }
        });
}
