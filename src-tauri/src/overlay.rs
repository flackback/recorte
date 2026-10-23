//! A transparent window over a monitor: to pick an area before recording, and to draw on the
//! screen while recording.

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutEvent, ShortcutState};
use windows_capture::monitor::Monitor;

use crate::sources;

pub const LABEL: &str = "overlay";

/// Opens the overlay over monitor `monitor` (one-based) in `mode` ("area" or "draw").
#[tauri::command]
pub async fn overlay_open(app: AppHandle, mode: String, monitor: usize, area: Option<String>) -> Result<(), String> {
    if !matches!(mode.as_str(), "area" | "draw" | "countdown") {
        return Err("modo inválido".into());
    }
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.close();
    }
    sources::use_physical_pixels();
    let monitor = Monitor::from_index(monitor).map_err(|error| error.to_string())?;
    let (rect, _) = sources::monitor_rect(&monitor).ok_or("monitor não encontrado")?;

    // The area picker starts from the current area ("x,y,width,height" in physical pixels).
    let area = area.filter(|value| value.split(',').all(|part| part.trim().parse::<i32>().is_ok())).map(|value| format!("&area={value}")).unwrap_or_default();
    let page = if mode == "countdown" { "countdown.html".to_string() } else { format!("overlay.html?mode={mode}{area}") };
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(page.into()))
        .title("Recorte")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
    window.set_position(PhysicalPosition::new(rect.left, rect.top)).map_err(|error| error.to_string())?;
    window
        .set_size(PhysicalSize::new((rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32))
        .map_err(|error| error.to_string())?;
    let recbar = if mode == "draw" { app.get_webview_window(RECBAR) } else { None };
    if mode == "draw" {
        // Lets clicks through while the page loads; the page takes them once a tool is chosen.
        let _ = window.set_ignore_cursor_events(true);
        // The drawing layer covers the whole monitor; the floating bar must stay above it to be
        // clickable, even when the layer takes the focus to draw. Linked before the layer shows,
        // so it never appears on top of the bar.
        if let Some(recbar) = &recbar {
            keep_above(&window, recbar);
        }
    }
    window.show().map_err(|error| error.to_string())?;
    match &recbar {
        Some(recbar) => bring_to_top(recbar),
        None if mode != "draw" => {
            let _ = window.set_focus();
        }
        None => {}
    }
    Ok(())
}

/// Makes `owner` own `owned`: Windows always keeps an owned window above its owner. The owned
/// window closes with the owner, which here happens only when the recording stops.
fn keep_above(owner: &tauri::WebviewWindow, owned: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_HWNDPARENT};

    if let (Ok(owner), Ok(owned)) = (owner.hwnd(), owned.hwnd()) {
        unsafe {
            SetWindowLongPtrW(HWND(owned.0 as _), GWLP_HWNDPARENT, owner.0 as isize);
        }
    }
}

/// Puts a window at the top of the always-on-top windows without taking the focus.
fn bring_to_top(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = SetWindowPos(HWND(hwnd.0 as _), Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

pub const RECBAR: &str = "recbar";
/// Starting size; the bar then fits itself to its content (and to the drawing tray).
const RECBAR_SIZE: (u32, u32) = (576, 68);

/// The small floating bar shown while recording (time, pause, mark, drawing tools, stop), at the top of the
/// recorded monitor. It is kept out of the recording.
#[tauri::command]
pub async fn recbar_open(app: AppHandle, monitor: usize) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(RECBAR) {
        let _ = existing.close();
    }
    sources::use_physical_pixels();
    let monitor = Monitor::from_index(monitor).map_err(|error| error.to_string())?;
    let (rect, _) = sources::monitor_rect(&monitor).ok_or("monitor não encontrado")?;
    let window = WebviewWindowBuilder::new(&app, RECBAR, WebviewUrl::App("recbar.html".into()))
        .title("Recorte · gravando")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = (RECBAR_SIZE.0 as f64 * scale) as u32;
    let height = (RECBAR_SIZE.1 as f64 * scale) as u32;
    let left = rect.left + ((rect.right - rect.left) as u32).saturating_sub(width) as i32 / 2;
    window.set_size(PhysicalSize::new(width, height)).map_err(|error| error.to_string())?;
    window.set_position(PhysicalPosition::new(left, rect.top + (8.0 * scale) as i32)).map_err(|error| error.to_string())?;
    crate::exclude_window(&window);
    window.show().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn recbar_close(app: AppHandle) {
    if let Some(window) = app.get_webview_window(RECBAR) {
        let _ = window.close();
    }
}

#[tauri::command]
pub fn overlay_close(app: AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
}

pub fn draw_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD)
}

pub fn stop_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyX)
}

/// Starts or stops recording from any program. Alt+Shift, because Ctrl+Shift+R reloads pages in
/// browsers.
pub fn record_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyR)
}

/// Marks a moment while recording.
pub fn mark_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyM)
}

/// Forwards the global shortcuts to the main window, which knows whether it is recording.
pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    let action = if *shortcut == draw_shortcut() {
        "draw"
    } else if *shortcut == stop_shortcut() {
        "stop"
    } else if *shortcut == record_shortcut() {
        "record"
    } else if *shortcut == mark_shortcut() {
        "mark"
    } else {
        return;
    };
    let _ = app.emit_to("main", "hotkey", action);
}
