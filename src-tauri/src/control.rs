//! Local control channel for the MCP server: an HTTP endpoint on 127.0.0.1 that lets an AI client
//! ask the running app to reload an edit, export or transcribe. Requests carry a random token that
//! only this user can read, from `control.json` in the app's local data folder.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const CONTROL_FILE: &str = "control.json";
const SETTINGS_FILE: &str = "settings.json";
const MAX_BODY: u64 = 1024 * 1024;
/// How long a request waits for the window to answer. Long work (export) answers at once with a
/// job id and is polled.
const REPLY_TIMEOUT: Duration = Duration::from_secs(60);

type Reply = Result<Value, String>;

#[derive(Default)]
pub struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    /// The running endpoint and its port, while the AI is allowed in.
    server: Mutex<Option<(Arc<tiny_http::Server>, u16)>>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(SETTINGS_FILE))
}

/// Whether the user lets AI clients reach the app (on unless turned off in Configurações).
pub fn enabled(app: &AppHandle) -> bool {
    settings_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|settings| settings["aiControl"].as_bool())
        .unwrap_or(true)
}

fn save_enabled(app: &AppHandle, on: bool) -> Result<(), String> {
    let path = settings_path(app).ok_or("sem pasta de configurações")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let mut settings = std::fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).unwrap_or_else(|| json!({}));
    settings["aiControl"] = json!(on);
    std::fs::write(path, serde_json::to_vec_pretty(&settings).unwrap()).map_err(|error| error.to_string())
}

/// The endpoint's port while it runs.
pub fn port(app: &AppHandle) -> Option<u16> {
    app.state::<Pending>().server.lock().unwrap().as_ref().map(|(_, port)| *port)
}

/// Turns the AI channel on or off now, and remembers the choice.
#[tauri::command]
pub fn ai_set_enabled(app: AppHandle, on: bool) -> Result<(), String> {
    save_enabled(&app, on)?;
    if on { start(&app) } else {
        stop(&app);
        Ok(())
    }
}

fn control_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|dir| dir.join(CONTROL_FILE))
}

/// 128 random bits from the standard library's OS-seeded hasher keys.
fn token() -> String {
    (0..2)
        .map(|_| {
            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
            hasher.write_i64(crate::clock::now_hns());
            format!("{:016x}", hasher.finish())
        })
        .collect()
}

/// Starts the endpoint and writes where to find it. Failing here only disables the MCP features.
pub fn start(app: &AppHandle) -> Result<(), String> {
    if port(app).is_some() {
        return Ok(());
    }
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").map_err(|error| error.to_string())?);
    let port = server.server_addr().to_ip().map(|address| address.port()).ok_or("sem porta")?;
    let token = token();
    let path = control_path(app).ok_or("sem pasta de dados")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let takes = crate::takes_root(app).map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
    let info = json!({ "version": 1, "port": port, "token": token, "pid": std::process::id(), "takesDir": takes });
    std::fs::write(&path, serde_json::to_vec_pretty(&info).unwrap()).map_err(|error| error.to_string())?;

    app.state::<Pending>().server.lock().unwrap().replace((server.clone(), port));
    let app = app.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || handle(&app, &token, request));
        }
    });
    Ok(())
}

/// Stops the endpoint and removes `control.json`, so clients know the app is not reachable.
pub fn stop(app: &AppHandle) {
    if let Some((server, _)) = app.state::<Pending>().server.lock().unwrap().take() {
        server.unblock();
    }
    if let Some(path) = control_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

fn respond(request: tiny_http::Request, status: u16, body: Value) {
    let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
    let response = tiny_http::Response::from_string(body.to_string()).with_status_code(status).with_header(header);
    let _ = request.respond(response);
}

fn handle(app: &AppHandle, token: &str, mut request: tiny_http::Request) {
    let authorized = request
        .headers()
        .iter()
        .any(|header| header.field.equiv("Authorization") && header.value.as_str() == format!("Bearer {token}"));
    // Browsers send an Origin; the MCP server never does. Refusing it keeps web pages out.
    let from_browser = request.headers().iter().any(|header| header.field.equiv("Origin"));
    if !authorized || from_browser {
        return respond(request, 403, json!({ "ok": false, "error": "não autorizado" }));
    }
    if request.method() != &tiny_http::Method::Post || request.url() != "/request" {
        return respond(request, 404, json!({ "ok": false, "error": "caminho desconhecido" }));
    }
    let mut body = String::new();
    if request.as_reader().take(MAX_BODY).read_to_string(&mut body).is_err() {
        return respond(request, 400, json!({ "ok": false, "error": "corpo inválido" }));
    }
    let Ok(message) = serde_json::from_str::<Value>(&body) else {
        return respond(request, 400, json!({ "ok": false, "error": "JSON inválido" }));
    };
    let kind = message["kind"].as_str().unwrap_or_default().to_string();
    let payload = message.get("payload").cloned().unwrap_or(Value::Null);

    let reply = match kind.as_str() {
        "ping" => Ok(json!({ "app": "Recorte", "version": env!("CARGO_PKG_VERSION") })),
        "enhance" => enhance(app, &payload),
        _ => ask_window(app, &kind, payload),
    };
    match reply {
        Ok(result) => respond(request, 200, json!({ "ok": true, "result": result })),
        Err(error) => respond(request, 200, json!({ "ok": false, "error": error })),
    }
}

/// Voice enhancement needs no window, so it runs here.
fn enhance(app: &AppHandle, payload: &Value) -> Reply {
    let dir = crate::take_dir(app, payload["dir"].as_str().unwrap_or_default())?;
    let level = crate::voice::Level::parse(payload["level"].as_str().unwrap_or("medium"));
    let file = crate::voice::enhance_take(&dir, level).map_err(|error| format!("{error:#}"))?;
    Ok(json!({ "file": file }))
}

/// Forwards a request to the main window and waits for `agent_reply`.
fn ask_window(app: &AppHandle, kind: &str, payload: Value) -> Reply {
    let pending = app.state::<Pending>();
    let id = pending.next.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel();
    pending.waiting.lock().unwrap().insert(id, sender);
    if let Err(error) = app.emit_to("main", "agent-request", json!({ "id": id, "kind": kind, "payload": payload })) {
        pending.waiting.lock().unwrap().remove(&id);
        return Err(error.to_string());
    }
    let reply = receiver.recv_timeout(REPLY_TIMEOUT);
    pending.waiting.lock().unwrap().remove(&id);
    reply.unwrap_or_else(|_| Err("o Recorte não respondeu a tempo".into()))
}

#[tauri::command]
pub fn agent_reply(app: AppHandle, id: u64, ok: bool, result: Value) {
    let pending = app.state::<Pending>();
    let sender = pending.waiting.lock().unwrap().remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(if ok { Ok(result) } else { Err(result.as_str().map(str::to_string).unwrap_or_else(|| result.to_string())) });
    }
}
