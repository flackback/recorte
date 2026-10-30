//! `recorte.exe --mcp`: runs the bundled MCP server in QuickJS, so AI clients need no Node.js.
//! The server speaks JSON-RPC over stdin and stdout, one message per line. This file gives it
//! files, timers and the app's control channel; everything else is the server's own JavaScript.

use std::cell::{Cell, RefCell};
use std::collections::BinaryHeap;
use std::cmp::Reverse;
use std::io::{BufRead, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use rquickjs::{CatchResultExt, Context, Ctx, Function, Module, Object, Runtime};
use serde_json::{json, Value};

/// The server bundle next to the app; in development, the one `npm run build:mcp` builds (the copy
/// next to a debug build is only refreshed by a full Tauri build).
pub fn script_path() -> Option<PathBuf> {
    let built = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("mcp").join("dist").join("recorte-mcp.mjs");
    let bundled = std::env::current_exe().ok()?.parent()?.join("mcp").join("recorte-mcp.mjs");
    let order = if cfg!(debug_assertions) { [built, bundled] } else { [bundled, built] };
    order.into_iter().find(|path| path.exists())
}

/// Timers waiting to fire: (when, id), soonest first.
type Timers = Rc<RefCell<BinaryHeap<Reverse<(Instant, u32)>>>>;

enum Event {
    Line(String),
    Closed,
    /// An HTTP request finished: its id, whether it worked, and the body or the error.
    Done(u32, bool, String),
}

/// Runs the server until the client closes stdin. Returns the process exit code.
pub fn run() -> i32 {
    let Some(script) = script_path() else {
        eprintln!("recorte-mcp: arquivo do servidor não encontrado; reinstale o Recorte");
        return 1;
    };
    let source = match std::fs::read_to_string(&script) {
        Ok(source) => source,
        Err(error) => {
            eprintln!("recorte-mcp: {}: {error}", script.display());
            return 1;
        }
    };
    let (events, inbox) = mpsc::channel();
    let lines = events.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(line) if line.trim().is_empty() => {}
                Ok(line) => {
                    if lines.send(Event::Line(line)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = lines.send(Event::Closed);
    });

    let runtime = match Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("recorte-mcp: {error}");
            return 1;
        }
    };
    // The server parses whole transcripts and cursor logs; QuickJS's default stack is small.
    runtime.set_max_stack_size(8 * 1024 * 1024);
    let context = Context::full(&runtime).expect("contexto do QuickJS");
    let timers: Timers = Rc::default();
    let next_id = Rc::new(Cell::new(1u32));

    let started = context.with(|ctx| {
        install(&ctx, &events, &timers, &next_id).catch(&ctx).map_err(|error| error.to_string())?;
        let promise = Module::evaluate(ctx.clone(), "recorte-mcp", source).catch(&ctx).map_err(|error| error.to_string())?;
        drain(&ctx);
        match promise.result::<()>() {
            Some(Err(error)) => Err(Err::<(), _>(error).catch(&ctx).unwrap_err().to_string()),
            _ => Ok(()),
        }
    });
    if let Err(error) = started {
        eprintln!("recorte-mcp: {error}");
        return 1;
    }

    loop {
        let soonest = timers.borrow().peek().map(|Reverse((when, _))| *when);
        let event = match soonest {
            Some(when) => match inbox.recv_timeout(when.saturating_duration_since(Instant::now())) {
                Ok(event) => Some(event),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return 0,
            },
            None => match inbox.recv() {
                Ok(event) => Some(event),
                Err(_) => return 0,
            },
        };
        context.with(|ctx| {
            let call = |name: &str, args: (u32, bool, String)| {
                let result = ctx.globals().get::<_, Function>(name).and_then(|function| function.call::<_, ()>(args));
                if let Err(error) = result.catch(&ctx) {
                    eprintln!("recorte-mcp: {error}");
                }
            };
            match event {
                Some(Event::Line(line)) => call("__recorteLine", (0, true, line)),
                Some(Event::Closed) => std::process::exit(0),
                Some(Event::Done(id, ok, text)) => call("__recorteDone", (id, ok, text)),
                None => {
                    // Fires every timer that is due.
                    let now = Instant::now();
                    loop {
                        let due = timers.borrow().peek().is_some_and(|Reverse((when, _))| *when <= now);
                        let Some(Reverse((_, id))) = due.then(|| timers.borrow_mut().pop()).flatten() else { break };
                        call("__recorteDone", (id, true, String::new()));
                    }
                }
            }
            drain(&ctx);
        });
    }
}

/// Runs the promise jobs the last call queued. A job that throws is the server's own error,
/// already answered to the client, so it is only dropped.
fn drain(ctx: &Ctx) {
    while ctx.execute_pending_job() {}
}

/// Defines `__recorte`, the functions the server's `host.ts` calls.
fn install<'js>(ctx: &Ctx<'js>, events: &Sender<Event>, timers: &Timers, next_id: &Rc<Cell<u32>>) -> rquickjs::Result<()> {
    let host = Object::new(ctx.clone())?;
    host.set("fs", Function::new(ctx.clone(), |op: String, a: String, b: String| file_op(&op, &a, &b).to_string())?)?;
    host.set("env", Function::new(ctx.clone(), |name: String| std::env::var(name).ok())?)?;
    host.set("home", Function::new(ctx.clone(), || dirs::home_dir().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default())?)?;
    host.set("videos", Function::new(ctx.clone(), || dirs::video_dir().map(|path| path.to_string_lossy().into_owned()))?)?;
    host.set("cwd", Function::new(ctx.clone(), || std::env::current_dir().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default())?)?;
    host.set(
        "write",
        Function::new(ctx.clone(), |line: String| {
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(line.as_bytes()).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush());
        })?,
    )?;
    host.set("log", Function::new(ctx.clone(), |text: String| eprintln!("{text}"))?)?;
    let (heap, ids) = (timers.clone(), next_id.clone());
    host.set(
        "timer",
        Function::new(ctx.clone(), move |ms: f64| {
            let id = ids.get();
            ids.set(id.wrapping_add(1).max(1));
            heap.borrow_mut().push(Reverse((Instant::now() + Duration::from_millis(ms.max(0.0) as u64), id)));
            id
        })?,
    )?;
    let (sender, ids) = (events.clone(), next_id.clone());
    host.set(
        "post",
        Function::new(ctx.clone(), move |port: u16, token: String, body: String, timeout_ms: f64| {
            let id = ids.get();
            ids.set(id.wrapping_add(1).max(1));
            let sender = sender.clone();
            std::thread::spawn(move || {
                let (ok, text) = match post(port, &token, &body, Duration::from_millis(timeout_ms.max(1.0) as u64)) {
                    Ok(text) => (true, text),
                    Err(error) => (false, error),
                };
                let _ = sender.send(Event::Done(id, ok, text));
            });
            id
        })?,
    )?;
    ctx.globals().set("__recorte", host)
}

/// One file operation, answered as `{ ok, value }` or `{ ok: false, error, code }`.
fn file_op(op: &str, a: &str, b: &str) -> Value {
    let path = Path::new(a);
    let result: std::io::Result<Value> = match op {
        "read" => std::fs::read_to_string(path).map(Value::from),
        "write" => std::fs::write(path, b).map(|_| Value::Null),
        "rename" => std::fs::rename(path, b).map(|_| Value::Null),
        "copy" => std::fs::copy(path, b).map(|_| Value::Null),
        "mkdir" => std::fs::create_dir_all(path).map(|_| Value::Null),
        "rm" => match std::fs::remove_file(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            other => other.map(|_| Value::Null),
        },
        "list" => std::fs::read_dir(path).map(|entries| entries.flatten().map(|entry| Value::from(entry.file_name().to_string_lossy().into_owned())).collect()),
        "stat" => Ok(std::fs::metadata(path).map_or(Value::Null, |meta| json!({ "size": meta.len(), "file": meta.is_file(), "dir": meta.is_dir() }))),
        _ => Err(std::io::Error::other(format!("operação desconhecida: {op}"))),
    };
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => {
            let code = if error.kind() == std::io::ErrorKind::NotFound { "ENOENT" } else { "EIO" };
            json!({ "ok": false, "error": format!("{error}: {a}"), "code": code })
        }
    }
}

/// POSTs to the app's control channel. "refused" means the app is not listening.
fn post(port: u16, token: &str, body: &str, timeout: Duration) -> Result<String, String> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::ConnectionRefused { "refused".to_string() } else { error.to_string() }
    })?;
    stream.set_read_timeout(Some(timeout)).map_err(|error| error.to_string())?;
    let request = format!(
        "POST /request HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).map_err(|error| error.to_string())?;
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).map_err(|error| match error.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => "o Recorte não respondeu a tempo".to_string(),
        _ => error.to_string(),
    })?;
    let split = reply.windows(4).position(|window| window == b"\r\n\r\n").ok_or("resposta inválida do Recorte")?;
    Ok(String::from_utf8_lossy(&reply[split + 4..]).into_owned())
}
