//! HEVC export through Windows' own encoder (Media Foundation, via windows-capture's VideoEncoder),
//! for when the WebView can't encode HEVC itself. The page renders each frame and sends its pixels
//! and the mixed sound; the encoder compresses and writes the MP4 on a thread of its own.
//!
//! Pixels travel over a local HTTP endpoint rather than the IPC channel: WebView2 hands request
//! bodies to the app at about 60 MB/s (130 ms per 1080p frame), the network stack many times faster.

use std::collections::HashMap;
use std::io::Read;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};

use serde::Serialize;
use tauri::AppHandle;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows_capture::encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType};

use crate::export::export_target;

/// The encoder writes here until it finishes, then the file takes its final name.
const PARTIAL: &str = "encoding";
/// Frames waiting for the encoder thread; the page waits when this many are queued.
const QUEUE: usize = 4;

enum Message {
    Frame(Vec<u8>, i64),
    Audio(Vec<u8>),
    Finish(SyncSender<Result<(), String>>),
}

struct Session {
    sender: SyncSender<Message>,
    thread: Option<JoinHandle<()>>,
    partial: PathBuf,
    target: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
}

static NEXT: AtomicU32 = AtomicU32::new(1);
static SESSIONS: OnceLock<Mutex<HashMap<u32, Session>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<u32, Session>> {
    SESSIONS.get_or_init(Default::default)
}

fn partial_of(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_owned();
    name.push(format!(".{PARTIAL}"));
    PathBuf::from(name)
}

/// Runs an encoder on its own thread (it is not Send) until told to finish. Returns once it is open.
fn spawn_encoder(partial: PathBuf, width: u32, height: u32, fps: u32, bitrate: u32, audio: bool) -> Result<(SyncSender<Message>, JoinHandle<()>), String> {
    let (sender, receiver) = mpsc::sync_channel::<Message>(QUEUE);
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let thread = thread::Builder::new()
        .name("hevc-export".into())
        .spawn(move || {
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let opened = VideoEncoder::new(
                VideoSettingsBuilder::new(width, height).sub_type(VideoSettingsSubType::HEVC).frame_rate(fps).bitrate(bitrate),
                AudioSettingsBuilder::new().disabled(!audio),
                ContainerSettingsBuilder::new(),
                &partial,
            );
            match opened {
                Ok(encoder) => {
                    let _ = ready_tx.send(Ok(()));
                    run(encoder, receiver);
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(format!("{error}")));
                }
            }
        })
        .map_err(|error| error.to_string())?;
    match ready_rx.recv() {
        Ok(Ok(())) => Ok((sender, thread)),
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(format!("o codificador HEVC do Windows não abriu: {error}"))
        }
        Err(_) => Err("o codificador HEVC do Windows parou ao abrir".into()),
    }
}

fn run(mut encoder: VideoEncoder, receiver: Receiver<Message>) {
    let mut failure: Option<String> = None;
    for message in receiver {
        match message {
            Message::Frame(pixels, timestamp) if failure.is_none() => {
                if let Err(error) = encoder.send_frame_buffer(&pixels, timestamp) {
                    failure = Some(format!("{error}"));
                }
            }
            Message::Audio(pcm) if failure.is_none() => {
                if let Err(error) = encoder.send_audio_buffer(&pcm, 0) {
                    failure = Some(format!("{error}"));
                }
            }
            Message::Finish(reply) => {
                let finished = encoder.finish().map_err(|error| format!("{error}"));
                let _ = reply.send(match failure {
                    Some(error) => Err(error),
                    None => finished,
                });
                return;
            }
            _ => {}
        }
    }
    // The page went away without finishing: close the file anyway.
    let _ = encoder.finish();
}

/// Whether Windows can encode HEVC here: a tiny file is encoded once and checked. Cached.
#[tauri::command]
pub async fn hevc_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    if let Some(known) = AVAILABLE.get() {
        return *known;
    }
    let result = tauri::async_runtime::spawn_blocking(probe).await.unwrap_or(false);
    *AVAILABLE.get_or_init(|| result)
}

fn probe() -> bool {
    let path = std::env::temp_dir().join(format!("recorte-hevc-{}.mp4", std::process::id()));
    let (width, height, fps) = (320u32, 192u32, 30u32);
    let Ok((sender, thread)) = spawn_encoder(path.clone(), width, height, fps, 1_000_000, false) else {
        let _ = fs::remove_file(&path);
        return false;
    };
    let frame = vec![128u8; (width * height * 4) as usize];
    for index in 0..fps as i64 {
        if sender.send(Message::Frame(frame.clone(), index * 10_000_000 / fps as i64)).is_err() {
            break;
        }
    }
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    let finished = sender.send(Message::Finish(reply_tx)).is_ok() && matches!(reply_rx.recv(), Ok(Ok(())));
    let _ = thread.join();
    // The file must really hold HEVC, not a stream the transcoder quietly made into something else.
    let written = fs::read(&path).unwrap_or_default();
    let _ = fs::remove_file(&path);
    let hevc = written.windows(4).any(|box_type| box_type == b"hvc1" || box_type == b"hev1");
    finished && written.len() > 1000 && hevc
}

#[derive(Serialize)]
pub struct Opened {
    id: u32,
    path: String,
    /// Where to POST `frame` and `audio`.
    url: String,
}

/// Starts an HEVC export of `take_id` (same naming as `export_create`). `bitrate` in bits per second.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn hevc_open(
    app: AppHandle,
    take_id: String,
    stamp: Option<String>,
    suffix: Option<String>,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    audio: bool,
) -> Result<Opened, String> {
    if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 || width > 7680 || height > 7680 || fps == 0 || fps > 240 {
        return Err("tamanho ou fps inválido".into());
    }
    let target = export_target(&app, &take_id, "mp4", stamp, suffix)?;
    remove_leftovers(target.parent().unwrap_or(Path::new(".")));
    let partial = partial_of(&target);
    let (port, secret) = endpoint()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (sender, thread) = spawn_encoder(partial.clone(), width, height, fps, bitrate, audio)?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = target.to_string_lossy().into_owned();
        sessions().lock().unwrap().insert(id, Session { sender, thread: Some(thread), partial, target, width, height, fps });
        Ok(Opened { id, path, url: format!("http://127.0.0.1:{port}/{secret}") })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Deletes partial files of HEVC exports that never finished (app closed mid-export).
fn remove_leftovers(dir: &Path) {
    let open: Vec<PathBuf> = sessions().lock().unwrap().values().map(|session| session.partial.clone()).collect();
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        if path.to_string_lossy().ends_with(&format!(".mp4.{PARTIAL}")) && !open.contains(&path) {
            let _ = fs::remove_file(&path);
        }
    }
}

/// The endpoint the page sends pixels and sound to: its port and the secret every URL starts with.
static ENDPOINT: OnceLock<Result<(u16, String), String>> = OnceLock::new();

fn endpoint() -> Result<(u16, String), String> {
    ENDPOINT
        .get_or_init(|| {
            let server = tiny_http::Server::http("127.0.0.1:0").map_err(|error| error.to_string())?;
            let port = server.server_addr().to_ip().map(|address| address.port()).ok_or("sem porta")?;
            let token = crate::control::token();
            let secret = token.clone();
            thread::Builder::new()
                .name("hevc-endpoint".into())
                .spawn(move || {
                    for request in server.incoming_requests() {
                        let secret = secret.clone();
                        thread::spawn(move || handle(request, &secret));
                    }
                })
                .map_err(|error| error.to_string())?;
            Ok((port, token))
        })
        .clone()
}

fn reply(request: tiny_http::Request, status: u16, text: &str) {
    let mut response = tiny_http::Response::from_string(text).with_status_code(status);
    for (name, value) in [("Access-Control-Allow-Origin", "*"), ("Access-Control-Allow-Methods", "POST"), ("Content-Type", "text/plain; charset=utf-8")] {
        response.add_header(tiny_http::Header::from_bytes(name, value).unwrap());
    }
    let _ = request.respond(response);
}

/// `POST /<secret>/frame?id&index&stride&format` with the pixels, or `/<secret>/audio?id` with PCM.
fn handle(mut request: tiny_http::Request, secret: &str) {
    if request.method() == &tiny_http::Method::Options {
        return reply(request, 204, "");
    }
    let url = request.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let Some(kind) = path.strip_prefix(&format!("/{secret}/")) else {
        return reply(request, 403, "não autorizado");
    };
    let field = |name: &str| query.split('&').find_map(|pair| pair.strip_prefix(name).and_then(|rest| rest.strip_prefix('=')));
    let number = |name: &str| field(name).and_then(|value| value.parse::<i64>().ok());
    let session = number("id").and_then(|id| {
        let open = sessions().lock().unwrap();
        open.get(&(id as u32)).map(|session| (session.sender.clone(), session.width as usize, session.height as usize, session.fps as i64))
    });
    let Some((sender, width, height, fps)) = session else {
        return reply(request, 404, "exportação desconhecida");
    };
    let limit = (width * height * 4) as u64 + 64 * 1024 * 1024;
    let mut body = Vec::with_capacity(request.body_length().unwrap_or(0).min(limit as usize));
    if request.as_reader().take(limit).read_to_end(&mut body).is_err() {
        return reply(request, 400, "corpo inválido");
    }
    let result = match kind {
        "frame" => match (number("index"), number("stride"), field("format")) {
            (Some(index), Some(stride), Some(format)) => frame(&sender, &body, width, height, index * 10_000_000 / fps, stride as usize, format),
            _ => Err("quadro sem índice, largura de linha ou formato".into()),
        },
        // 48 kHz stereo 16-bit PCM, interleaved, in order.
        "audio" => sender.send(Message::Audio(body)).map_err(|_| "o codificador HEVC parou".into()),
        _ => Err("caminho desconhecido".into()),
    };
    match result {
        Ok(()) => reply(request, 200, "ok"),
        Err(error) => reply(request, 500, &error),
    }
}

/// One frame, top row first, `stride` bytes per row, in BGRA, BGRX, RGBA or RGBX. Waits while the
/// encoder is busy, so the page never runs far ahead of it.
fn frame(sender: &SyncSender<Message>, data: &[u8], width: usize, height: usize, timestamp: i64, stride: usize, format: &str) -> Result<(), String> {
    if height == 0 || stride < width * 4 || data.len() < stride * (height - 1) + width * 4 {
        return Err("quadro com tamanho errado".into());
    }
    // Windows takes BGRA with the bottom row first.
    let row = width * 4;
    let swap = format.starts_with("RGB");
    let mut pixels = vec![0u8; row * height];
    for y in 0..height {
        let target = &mut pixels[(height - 1 - y) * row..(height - y) * row];
        target.copy_from_slice(&data[y * stride..y * stride + row]);
        if swap {
            for pixel in target.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
        }
    }
    sender.send(Message::Frame(pixels, timestamp)).map_err(|_| "o codificador HEVC parou".into())
}

/// Lets the encoder write out what it holds, then gives the file its final name.
#[tauri::command]
pub async fn hevc_finish(id: u32) -> Result<String, String> {
    let session = sessions().lock().unwrap().remove(&id).ok_or("exportação desconhecida")?;
    tauri::async_runtime::spawn_blocking(move || {
        let Session { sender, mut thread, partial, target, .. } = session;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let sent = sender.send(Message::Finish(reply_tx)).is_ok();
        let result = if sent { reply_rx.recv().unwrap_or_else(|_| Err("o codificador HEVC parou".into())) } else { Err("o codificador HEVC parou".into()) };
        drop(sender);
        if let Some(thread) = thread.take() {
            let _ = thread.join();
        }
        if let Err(error) = result {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
        let _ = fs::remove_file(&target);
        fs::rename(&partial, &target).map_err(|error| error.to_string())?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Stops an export and deletes its partial file.
#[tauri::command]
pub async fn hevc_cancel(id: u32) -> Result<(), String> {
    let Some(session) = sessions().lock().unwrap().remove(&id) else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Session { sender, mut thread, partial, .. } = session;
        // Dropping the channel ends the thread, which closes the file before it is deleted.
        drop(sender);
        if let Some(thread) = thread.take() {
            let _ = thread.join();
        }
        let _ = fs::remove_file(&partial);
    })
    .await
    .map_err(|error| error.to_string())
}
