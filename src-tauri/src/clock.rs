use std::sync::OnceLock;

use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

/// Ticks of 100 ns in one second, the unit used by Windows Graphics Capture and WASAPI timestamps.
pub const HNS_PER_SEC: i64 = 10_000_000;

/// Current time on the QPC clock, in 100 ns units.
///
/// This is the same clock as `Frame::timestamp` (SystemRelativeTime) and the QPC position WASAPI
/// reports for each audio packet, so video, audio and input events can be lined up exactly.
pub fn now_hns() -> i64 {
    static FREQUENCY: OnceLock<i64> = OnceLock::new();
    let frequency = *FREQUENCY.get_or_init(|| {
        let mut frequency = 0;
        let _ = unsafe { QueryPerformanceFrequency(&mut frequency) };
        frequency.max(1)
    });
    let mut counter = 0;
    let _ = unsafe { QueryPerformanceCounter(&mut counter) };
    (counter as i128 * HNS_PER_SEC as i128 / frequency as i128) as i64
}
