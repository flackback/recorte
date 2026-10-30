//! What Configurações shows about AI clients: the MCP server (this app, run as `recorte.exe --mcp`),
//! whether Claude Code and Claude Desktop are on this PC, and whether they know about Recorte. It
//! can register the server with them.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

const SERVER_NAME: &str = "recorte";
/// Hides the console window a command would otherwise flash.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    installed: bool,
    connected: bool,
    /// The server file the client runs, when it is connected to another copy (an older install).
    other_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    enabled: bool,
    port: Option<u16>,
    /// The program clients start, with `--mcp`.
    server_path: String,
    server_found: bool,
    claude_code: Client,
    claude_desktop: Client,
    /// Command to register the server by hand.
    command: String,
    /// Entry for an MCP client's JSON configuration.
    config: String,
}

const SERVER_ARG: &str = "--mcp";

/// This app's program: clients start it with `--mcp` for the MCP server.
fn server_command() -> String {
    std::env::current_exe().map(|exe| clean(&exe)).unwrap_or_default()
}

/// Runs a command through `cmd` (so `.cmd` shims like `claude` work) without a console window.
fn run(args: &[&str]) -> Option<String> {
    let output = Command::new("cmd").arg("/C").args(args).creation_flags(CREATE_NO_WINDOW).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn clean(path: &Path) -> String {
    let text = path.to_string_lossy().replace("\\\\?\\", "");
    PathBuf::from(text).components().collect::<PathBuf>().to_string_lossy().into_owned()
}

/// Same file, whatever the slashes or case.
fn same_path(a: &str, b: &str) -> bool {
    let normal = |path: &str| path.replace('/', "\\").to_lowercase();
    normal(a) == normal(b)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// The program a client's `mcpServers.recorte` runs: the script for the Node.js server of older
/// versions, else the command.
fn registered(config: &Value) -> Option<(String, bool)> {
    let entry = config["mcpServers"].get(SERVER_NAME)?;
    let args = entry["args"].as_array().map(Vec::as_slice).unwrap_or_default();
    if let Some(script) = args.iter().rev().find_map(|arg| arg.as_str().filter(|arg| arg.ends_with(".mjs"))) {
        return Some((script.to_string(), false));
    }
    let ours = args.iter().any(|arg| arg.as_str() == Some(SERVER_ARG));
    Some((entry["command"].as_str()?.to_string(), ours))
}

/// Whether a client's `mcpServers.recorte` runs this server.
fn client_state(installed: bool, config: Option<Value>, server: &str) -> Client {
    let found = config.as_ref().and_then(registered);
    let connected = found.as_ref().is_some_and(|(path, ours)| *ours && same_path(path, server));
    Client { installed, connected, other_path: if connected { None } else { found.map(|(path, _)| path) } }
}

fn claude_code_config() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".claude.json"))
}

fn claude_desktop_config() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|data| PathBuf::from(data).join("Claude").join("claude_desktop_config.json"))
}

#[tauri::command]
pub async fn ai_status(app: AppHandle) -> AiStatus {
    let server = server_command();
    let code_installed = tauri::async_runtime::spawn_blocking(|| run(&["claude", "--version"]).is_some()).await.unwrap_or(false);
    let desktop_file = claude_desktop_config();
    let desktop_installed = desktop_file.as_ref().and_then(|file| file.parent()).is_some_and(Path::exists);
    AiStatus {
        enabled: crate::control::enabled(&app),
        port: crate::control::port(&app),
        claude_code: client_state(code_installed, claude_code_config().and_then(|file| read_json(&file)), &server),
        claude_desktop: client_state(desktop_installed, desktop_file.and_then(|file| read_json(&file)), &server),
        command: format!("claude mcp add --scope user {SERVER_NAME} -- \"{server}\" {SERVER_ARG}"),
        config: serde_json::to_string_pretty(&json!({ SERVER_NAME: { "command": server, "args": [SERVER_ARG] } })).unwrap(),
        server_path: server,
        server_found: crate::mcp::script_path().is_some(),
    }
}

/// Registers (or with `on` false, removes) the server in Claude Code or Claude Desktop.
#[tauri::command]
pub async fn ai_connect(client: String, on: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || connect(&client, on)).await.map_err(|error| error.to_string())?
}

fn connect(client: &str, on: bool) -> Result<(), String> {
    let server = server_command();
    match client {
        "code" => {
            // Replaces any older registration (another install folder, say).
            let _ = run(&["claude", "mcp", "remove", SERVER_NAME, "-s", "user"]);
            if on {
                run(&["claude", "mcp", "add", "--scope", "user", SERVER_NAME, "--", &server, SERVER_ARG]).ok_or("O Claude Code não aceitou o registro. Confira se o comando claude funciona no terminal.")?;
            }
            Ok(())
        }
        "desktop" => {
            let file = claude_desktop_config().ok_or("Pasta do Claude Desktop não encontrada.")?;
            let dir = file.parent().ok_or("Pasta do Claude Desktop não encontrada.")?;
            if !dir.exists() {
                return Err("O Claude Desktop não está instalado neste computador.".into());
            }
            let mut config = read_json(&file).unwrap_or_else(|| json!({}));
            if file.exists() {
                // A copy of the user's file before changing it.
                std::fs::copy(&file, file.with_extension("json.bak")).map_err(|error| error.to_string())?;
            }
            if !config["mcpServers"].is_object() {
                config["mcpServers"] = json!({});
            }
            if on {
                config["mcpServers"][SERVER_NAME] = json!({ "command": server, "args": [SERVER_ARG] });
            } else if let Some(servers) = config["mcpServers"].as_object_mut() {
                servers.remove(SERVER_NAME);
            }
            std::fs::write(&file, serde_json::to_vec_pretty(&config).unwrap()).map_err(|error| error.to_string())
        }
        _ => Err("cliente desconhecido".into()),
    }
}

/// Versions before 0.1.19 registered `node recorte-mcp.mjs`; that script now only runs inside
/// the app, so those registrations are moved to `recorte.exe --mcp`. Runs once per start, off the
/// main thread, and only touches a client already registered that way.
pub fn migrate() {
    // A development build would register itself in place of the installed app.
    if cfg!(debug_assertions) {
        return;
    }
    std::thread::spawn(|| {
        let old = |config: Option<Value>| config.as_ref().and_then(registered).is_some_and(|(path, _)| path.ends_with("recorte-mcp.mjs"));
        if old(claude_desktop_config().and_then(|file| read_json(&file)))
            && let Err(error) = connect("desktop", true)
        {
            eprintln!("registro do Claude Desktop não atualizado: {error}");
        }
        if old(claude_code_config().and_then(|file| read_json(&file)))
            && let Err(error) = connect("code", true)
        {
            eprintln!("registro do Claude Code não atualizado: {error}");
        }
    });
}
