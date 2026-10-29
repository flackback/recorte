use serde::Serialize;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::core::BOOL;
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext};
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetClassNameW, GetWindowRect, IsWindowVisible, MONITORINFOF_PRIMARY};
use windows_capture::monitor::Monitor;
use windows_capture::window::Window;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// One-based position in `Monitor::enumerate`, as `Monitor::from_index` expects.
    pub index: usize,
    pub name: String,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
    /// Top-left on the desktop, to tell monitors of the same model apart by position.
    pub x: i32,
    pub y: i32,
    /// Refresh rate in Hz; recording faster than this gains nothing.
    pub refresh_rate: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// The HWND as a decimal string, since JavaScript numbers can't hold every pointer.
    pub hwnd: String,
    pub title: String,
    pub process: String,
    pub width: i32,
    pub height: i32,
    /// A browser whose page area is known, so it can be recorded without tabs and address bar.
    pub page: bool,
}

#[derive(Serialize)]
pub struct Sources {
    pub monitors: Vec<MonitorInfo>,
    pub windows: Vec<WindowInfo>,
}

/// Rects below are in physical pixels, the same space Windows Graphics Capture records in.
pub fn use_physical_pixels() {
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

pub fn monitor_rect(monitor: &Monitor) -> Option<(RECT, bool)> {
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    let ok = unsafe { GetMonitorInfoW(HMONITOR(monitor.as_raw_hmonitor()), &mut info) };
    ok.as_bool().then_some((info.rcMonitor, info.dwFlags & MONITORINFOF_PRIMARY != 0))
}

/// The visible bounds of a window, without the invisible resize borders `GetWindowRect` includes.
pub fn window_rect(window: &Window) -> Option<RECT> {
    let mut rect = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            HWND(window.as_raw_hwnd()),
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut rect).cast(),
            size_of::<RECT>() as u32,
        )
    }
    .ok()?;
    Some(rect)
}

/// Chromium browsers. Apps built on Chromium (Electron, WebView2) have the same page window but no
/// tabs or address bar to leave out.
const BROWSERS: [&str; 7] = ["chrome.exe", "msedge.exe", "brave.exe", "opera.exe", "opera_gx.exe", "vivaldi.exe", "chromium.exe"];

/// The page area of a Chromium browser window (Chrome, Edge, Brave, Opera…), on the desktop: the
/// largest visible web contents child window. None for other windows, and for Firefox, which draws
/// its pages without one.
pub fn page_rect(window: &Window) -> Option<RECT> {
    let process = window.process_name().ok()?.to_lowercase();
    if !BROWSERS.contains(&process.as_str()) {
        return None;
    }
    unsafe extern "system" fn visit(child: HWND, found: LPARAM) -> BOOL {
        let mut class = [0u16; 64];
        let length = unsafe { GetClassNameW(child, &mut class) } as usize;
        if String::from_utf16_lossy(&class[..length]) == "Chrome_RenderWidgetHostHWND" && unsafe { IsWindowVisible(child) }.as_bool() {
            let mut rect = RECT::default();
            if unsafe { GetWindowRect(child, &mut rect) }.is_ok() {
                let best = unsafe { &mut *(found.0 as *mut Option<RECT>) };
                let area = |rect: &RECT| (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64;
                if best.as_ref().is_none_or(|best| area(&rect) > area(best)) {
                    *best = Some(rect);
                }
            }
        }
        true.into()
    }
    let mut found: Option<RECT> = None;
    unsafe {
        let _ = EnumChildWindows(Some(HWND(window.as_raw_hwnd())), Some(visit), LPARAM(&raw mut found as isize));
    }
    // A sliver (a hidden tab's leftover, a tiny popup) is not the page.
    found.filter(|rect| rect.right - rect.left >= 100 && rect.bottom - rect.top >= 100)
}

pub fn list() -> anyhow::Result<Sources> {
    use_physical_pixels();

    let monitors = Monitor::enumerate()?
        .iter()
        .enumerate()
        .filter_map(|(position, monitor)| {
            let (rect, primary) = monitor_rect(monitor)?;
            let name = monitor.name().unwrap_or_else(|_| format!("Monitor {}", position + 1));
            Some(MonitorInfo {
                index: position + 1,
                name,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
                primary,
                x: rect.left,
                y: rect.top,
                refresh_rate: monitor.refresh_rate().unwrap_or(60),
            })
        })
        .collect();

    let own_process = std::process::id();
    let windows = Window::enumerate()?
        .iter()
        .filter(|window| window.process_id().is_ok_and(|id| id != own_process))
        .filter_map(|window| {
            let title = window.title().ok().filter(|title| !title.trim().is_empty())?;
            let rect = window_rect(window)?;
            Some(WindowInfo {
                hwnd: (window.as_raw_hwnd() as isize).to_string(),
                title,
                process: window.process_name().unwrap_or_default(),
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
                page: page_rect(window).is_some(),
            })
        })
        .filter(|window| window.width > 0 && window.height > 0)
        .collect();

    Ok(Sources { monitors, windows })
}
