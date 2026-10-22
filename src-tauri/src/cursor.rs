use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicIsize, Ordering};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};

use anyhow::anyhow;
use serde::Serialize;
use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MAPVK_VK_TO_CHAR, MapVirtualKeyW, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1,
    VK_F24, VK_HOME, VK_INSERT, VK_LCONTROL, VK_LEFT, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RCONTROL,
    VK_RETURN, VK_RIGHT, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CURSORINFO, CallNextHookEx, GetCursorInfo, GetCursorPos, GetMessageW, HCURSOR, IDC_ARROW, IDC_HAND, IDC_IBEAM, KBDLLHOOKSTRUCT,
    KillTimer, LoadCursorW, MSG, MSLLHOOKSTRUCT, PostThreadMessageW, SetTimer, SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL,
    WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
};

use crate::clock::now_hns;

/// Moves closer together than this (4 ms) are dropped; 250 Hz is plenty for smoothing later.
const MOVE_INTERVAL_HNS: i64 = 40_000;
/// How often the cursor shape is checked.
const SHAPE_POLL_MS: u32 = 16;

#[derive(Clone, Copy, Serialize)]
pub enum Kind {
    #[serde(rename = "m")]
    Move,
    #[serde(rename = "d")]
    Down,
    #[serde(rename = "u")]
    Up,
    #[serde(rename = "w")]
    Wheel,
    /// The cursor changed shape.
    #[serde(rename = "s")]
    Shape,
}

#[derive(Clone, Copy, Serialize)]
pub enum Button {
    #[serde(rename = "l")]
    Left,
    #[serde(rename = "r")]
    Right,
    #[serde(rename = "m")]
    Middle,
}

#[derive(Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Shape {
    Arrow,
    Hand,
    Text,
    Other,
}

/// A mouse event in physical screen pixels, timed on the QPC clock (100 ns).
#[derive(Clone, Copy)]
pub struct RawEvent {
    pub time: i64,
    pub kind: Kind,
    pub button: Option<Button>,
    pub x: i32,
    pub y: i32,
    pub wheel: i16,
    pub shape: Option<Shape>,
}

/// A key press, with the modifiers held at that moment.
#[derive(Clone)]
pub struct KeyPress {
    pub time: i64,
    pub name: String,
    pub modifiers: Vec<&'static str>,
}

static EVENTS: Mutex<Vec<RawEvent>> = Mutex::new(Vec::new());
static KEYS: Mutex<Vec<KeyPress>> = Mutex::new(Vec::new());
static HELD: Mutex<Option<HashSet<u32>>> = Mutex::new(None);
static LAST_MOVE: AtomicI64 = AtomicI64::new(0);
static LAST_SHAPE: AtomicIsize = AtomicIsize::new(-1);

/// Logs the mouse (and optionally the keyboard) through low-level hooks, plus the cursor shape,
/// so the editor can restyle the cursor, suggest zooms and show shortcuts.
pub struct Logger {
    thread_id: u32,
    handle: JoinHandle<()>,
}

impl Logger {
    pub fn start(keyboard: bool) -> anyhow::Result<Self> {
        EVENTS.lock().unwrap().clear();
        KEYS.lock().unwrap().clear();
        *HELD.lock().unwrap() = Some(HashSet::new());
        LAST_MOVE.store(0, Ordering::Relaxed);
        LAST_SHAPE.store(-1, Ordering::Relaxed);

        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
        let handle = thread::Builder::new().name("input-hooks".into()).spawn(move || unsafe {
            // Physical pixels, matching what Windows Graphics Capture records.
            let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

            let mut point = POINT::default();
            if GetCursorPos(&mut point).is_ok() {
                record(RawEvent { time: now_hns(), kind: Kind::Move, button: None, x: point.x, y: point.y, wheel: 0, shape: None });
            }
            poll_shape();

            let mouse = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) {
                Ok(hook) => hook,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };
            let keys = if keyboard { SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_proc), None, 0).ok() } else { None };
            let timer = SetTimer(None, 0, SHAPE_POLL_MS, None);
            let _ = ready_tx.send(Ok(GetCurrentThreadId()));

            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                if message.message == WM_TIMER {
                    poll_shape();
                }
            }
            let _ = KillTimer(None, timer);
            let _ = UnhookWindowsHookEx(mouse);
            if let Some(hook) = keys {
                let _ = UnhookWindowsHookEx(hook);
            }
        })?;

        match ready_rx.recv() {
            Ok(Ok(thread_id)) => Ok(Self { thread_id, handle }),
            Ok(Err(error)) => Err(anyhow!("hook do mouse: {error}")),
            Err(_) => Err(anyhow!("a thread de entrada terminou antes de instalar os hooks")),
        }
    }

    pub fn stop(self) -> (Vec<RawEvent>, Vec<KeyPress>) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        let _ = self.handle.join();
        (std::mem::take(&mut *EVENTS.lock().unwrap()), std::mem::take(&mut *KEYS.lock().unwrap()))
    }
}

fn record(event: RawEvent) {
    EVENTS.lock().unwrap().push(event);
}

/// Records a shape event when the system cursor changes between arrow, hand and text beam.
unsafe fn poll_shape() {
    let mut info = CURSORINFO { cbSize: size_of::<CURSORINFO>() as u32, ..Default::default() };
    if unsafe { GetCursorInfo(&mut info) }.is_err() {
        return;
    }
    let handle = info.hCursor.0 as isize;
    if LAST_SHAPE.swap(handle, Ordering::Relaxed) == handle {
        return;
    }
    let system = |id| unsafe { LoadCursorW(None, id) }.unwrap_or(HCURSOR::default()).0 as isize;
    let shape = if handle == system(IDC_HAND) {
        Shape::Hand
    } else if handle == system(IDC_IBEAM) {
        Shape::Text
    } else if handle == system(IDC_ARROW) {
        Shape::Arrow
    } else {
        Shape::Other
    };
    record(RawEvent { time: now_hns(), kind: Kind::Shape, button: None, x: info.ptScreenPos.x, y: info.ptScreenPos.y, wheel: 0, shape: Some(shape) });
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        let time = now_hns();
        let (kind, button) = match wparam.0 as u32 {
            WM_MOUSEMOVE => (Some(Kind::Move), None),
            WM_LBUTTONDOWN => (Some(Kind::Down), Some(Button::Left)),
            WM_LBUTTONUP => (Some(Kind::Up), Some(Button::Left)),
            WM_RBUTTONDOWN => (Some(Kind::Down), Some(Button::Right)),
            WM_RBUTTONUP => (Some(Kind::Up), Some(Button::Right)),
            WM_MBUTTONDOWN => (Some(Kind::Down), Some(Button::Middle)),
            WM_MBUTTONUP => (Some(Kind::Up), Some(Button::Middle)),
            WM_MOUSEWHEEL => (Some(Kind::Wheel), None),
            _ => (None, None),
        };
        let keep = match kind {
            Some(Kind::Move) => {
                let last = LAST_MOVE.load(Ordering::Relaxed);
                let due = time - last >= MOVE_INTERVAL_HNS;
                if due {
                    LAST_MOVE.store(time, Ordering::Relaxed);
                }
                due
            }
            Some(_) => true,
            None => false,
        };
        if let (true, Some(kind)) = (keep, kind) {
            let wheel = if matches!(kind, Kind::Wheel) { (info.mouseData >> 16) as i16 } else { 0 };
            record(RawEvent { time, kind, button, x: info.pt.x, y: info.pt.y, wheel, shape: None });
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn is_modifier(vk: u32) -> bool {
    [VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_CONTROL, VK_LCONTROL, VK_RCONTROL, VK_MENU, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN]
        .iter()
        .any(|key| key.0 as u32 == vk)
}

fn key_name(vk: u32) -> String {
    let named = [
        (VK_RETURN, "Enter"),
        (VK_ESCAPE, "Esc"),
        (VK_TAB, "Tab"),
        (VK_SPACE, "Espaço"),
        (VK_BACK, "⌫"),
        (VK_DELETE, "Delete"),
        (VK_INSERT, "Insert"),
        (VK_LEFT, "←"),
        (VK_RIGHT, "→"),
        (VK_UP, "↑"),
        (VK_DOWN, "↓"),
        (VK_HOME, "Home"),
        (VK_END, "End"),
        (VK_PRIOR, "PgUp"),
        (VK_NEXT, "PgDn"),
    ];
    if let Some((_, name)) = named.iter().find(|(key, _)| key.0 as u32 == vk) {
        return (*name).to_string();
    }
    if (VK_F1.0 as u32..=VK_F24.0 as u32).contains(&vk) {
        return format!("F{}", vk - VK_F1.0 as u32 + 1);
    }
    let character = unsafe { MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR) } & 0x7fff_ffff;
    char::from_u32(character).filter(|c| !c.is_control()).map(|c| c.to_uppercase().to_string()).unwrap_or_else(|| format!("#{vk}"))
}

fn held_modifiers() -> Vec<&'static str> {
    let down = |vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY| unsafe { GetAsyncKeyState(vk.0 as i32) } < 0;
    let mut modifiers = Vec::new();
    if down(VK_CONTROL) {
        modifiers.push("Ctrl");
    }
    if down(VK_MENU) {
        modifiers.push("Alt");
    }
    if down(VK_SHIFT) {
        modifiers.push("Shift");
    }
    if down(VK_LWIN) || down(VK_RWIN) {
        modifiers.push("Win");
    }
    modifiers
}

unsafe extern "system" fn key_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let vk = info.vkCode;
        let message = wparam.0 as u32;
        let mut held = HELD.lock().unwrap();
        let held = held.get_or_insert_with(HashSet::new);
        if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
            // Auto-repeat sends more downs while held; only the first press counts.
            if held.insert(vk) && !is_modifier(vk) {
                KEYS.lock().unwrap().push(KeyPress { time: now_hns(), name: key_name(vk), modifiers: held_modifiers() });
            }
        } else if message == WM_KEYUP || message == WM_SYSKEYUP {
            held.remove(&vk);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
