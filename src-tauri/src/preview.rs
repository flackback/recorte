//! A small, live picture of what is about to be recorded, for the app's start screen.

use anyhow::{anyhow, bail};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleBitmap, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, HALFTONE, ReleaseDC,
    HDC, SRCCOPY, SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
use windows_capture::monitor::Monitor;
use windows_capture::window::Window;

use crate::sources;

pub enum Target {
    Monitor(usize),
    Window(isize),
}

/// The target's area of the screen, shrunk to at most `max_width` pixels wide: width and height
/// (little-endian u32) followed by RGBA pixels, ready for a canvas.
pub fn grab(target: Target, max_width: u32) -> anyhow::Result<Vec<u8>> {
    sources::use_physical_pixels();
    let window = match target {
        Target::Window(hwnd) => Some(HWND(hwnd as *mut _)),
        Target::Monitor(_) => None,
    };
    let rect: RECT = match target {
        Target::Monitor(index) => {
            let monitor = Monitor::from_index(index).map_err(|error| anyhow!("monitor {index}: {error}"))?;
            sources::monitor_rect(&monitor).ok_or_else(|| anyhow!("monitor não encontrado"))?.0
        }
        Target::Window(hwnd) => {
            let window = Window::from_raw_hwnd(hwnd as *mut _);
            if !window.is_valid() {
                bail!("a janela não está mais disponível");
            }
            sources::window_rect(&window).ok_or_else(|| anyhow!("janela sem área"))?
        }
    };
    let (source_width, source_height) = (rect.right - rect.left, rect.bottom - rect.top);
    if source_width < 2 || source_height < 2 {
        bail!("área vazia");
    }
    let scale = (max_width as f64 / source_width as f64).min(1.0);
    let width = ((source_width as f64 * scale).round() as i32).max(1);
    let height = ((source_height as f64 * scale).round() as i32).max(1);

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    unsafe {
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, bitmap.into());
        // Averages pixels while shrinking, so text stays readable.
        SetStretchBltMode(memory, HALFTONE);
        let _ = SetBrushOrgEx(memory, 0, 0, None);
        let copied = match window {
            // A window is drawn by itself, so other windows on top of it do not show.
            Some(hwnd) => shrink_window(hwnd, screen, memory, &rect, width, height),
            None => StretchBlt(memory, 0, 0, width, height, Some(screen), rect.left, rect.top, source_width, source_height, SRCCOPY).as_bool(),
        };
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative height: rows top to bottom, like a canvas.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let rows = GetDIBits(memory, bitmap, 0, height as u32, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        SelectObject(memory, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        if !copied || rows == 0 {
            bail!("não foi possível ler a tela");
        }
    }
    // BGRA from GDI to opaque RGBA.
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    let mut out = Vec::with_capacity(8 + pixels.len());
    out.extend_from_slice(&(width as u32).to_le_bytes());
    out.extend_from_slice(&(height as u32).to_le_bytes());
    out.extend_from_slice(&pixels);
    Ok(out)
}

/// Asks the window to draw itself at full size, then shrinks its visible frame (`rect`, without the
/// invisible resize borders) into `target`.
unsafe fn shrink_window(hwnd: HWND, screen: HDC, target: HDC, rect: &RECT, width: i32, height: i32) -> bool {
    let mut outer = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut outer) }.is_err() {
        return false;
    }
    let (full_width, full_height) = (outer.right - outer.left, outer.bottom - outer.top);
    if full_width < 2 || full_height < 2 {
        return false;
    }
    unsafe {
        let full = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, full_width, full_height);
        let previous = SelectObject(full, bitmap.into());
        // PW_RENDERFULLCONTENT: also works for windows drawn by the GPU (browsers, WebView, games).
        let drawn = PrintWindow(hwnd, full, PRINT_WINDOW_FLAGS(2)).as_bool();
        let copied = drawn
            && StretchBlt(target, 0, 0, width, height, Some(full), rect.left - outer.left, rect.top - outer.top, rect.right - rect.left, rect.bottom - rect.top, SRCCOPY).as_bool();
        SelectObject(full, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(full);
        copied
    }
}
