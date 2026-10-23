//! What Configurações shows about AI clients: where the bundled MCP server is, whether Node.js,
//! Claude Code and Claude Desktop are on this PC, and whether they know about Recorte. It can
//! register the server with them.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

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
    server_path: String,
    server_found: bool,
    node: Option<String>,
    node_path: Option<String>,
    claude_code: Client,
    claude_desktop: Client,
    /// Command to register the server by hand.
    command: String,
    /// Entry for an MCP client's JSON configuration.
    config: String,
}

/// The MCP server shipped with the app; in development, the one built in the project.
fn server_path(app: &AppHandle) -> PathBuf {
    let bundled = app.path().resource_dir().map(|dir| dir.join("mcp").join("recorte-mcp.mjs"));
    match bundled {
        Ok(path) if path.exists() => path,
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("mcp").join("dist").join("recorte-mcp.mjs"),
    }
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

/// Whether a client's `mcpServers.recorte` runs this server.
fn client_state(installed: bool, config: Option<Value>, server: &str) -> Client {
    let entry = config.as_ref().and_then(|config| config["mcpServers"].get(SERVER_NAME).cloned());
    let path = entry.as_ref().and_then(|entry| entry["args"].as_array()?.iter().rev().find_map(|arg| arg.as_str().filter(|arg| arg.ends_with(".mjs")).map(str::to_string)));
    let connected = path.as_deref().is_some_and(|path| same_path(path, server));
    Client { installed, connected, other_path: if connected { None } else { path } }
}

fn claude_code_config() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".claude.json"))
}

fn claude_desktop_config() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|data| PathBuf::from(data).join("Claude").join("claude_desktop_config.json"))
}

fn node_path() -> Option<String> {
    run(&["where", "node"]).and_then(|found| found.lines().next().map(str::to_string))
}

#[tauri::command]
pub async fn ai_status(app: AppHandle) -> AiStatus {
    let server = clean(&server_path(&app));
    let server_found = Path::new(&server).exists();
    let (node, node_path, code_installed) = tauri::async_runtime::spawn_blocking(|| (run(&["node", "--version"]), node_path(), run(&["claude", "--version"]).is_some()))
        .await
        .unwrap_or((None, None, false));
    let desktop_file = claude_desktop_config();
    let desktop_installed = desktop_file.as_ref().and_then(|file| file.parent()).is_some_and(Path::exists);
    let node_command = node_path.clone().unwrap_or_else(|| "node".into());
    AiStatus {
        enabled: crate::control::enabled(&app),
        port: crate::control::port(&app),
        claude_code: client_state(code_installed, claude_code_config().and_then(|file| read_json(&file)), &server),
        claude_desktop: client_state(desktop_installed, desktop_file.and_then(|file| read_json(&file)), &server),
        command: format!("claude mcp add --scope user {SERVER_NAME} -- \"{node_command}\" \"{server}\""),
        config: serde_json::to_string_pretty(&json!({ SERVER_NAME: { "command": node_command, "args": [server] } })).unwrap(),
        server_path: server,
        server_found,
        node,
        node_path,
    }
}

/// Registers (or with `on` false, removes) the server in Claude Code or Claude Desktop.
#[tauri::command]
pub async fn ai_connect(app: AppHandle, client: String, on: bool) -> Result<(), String> {
    let server = clean(&server_path(&app));
    tauri::async_runtime::spawn_blocking(move || {
        let node = node_path().ok_or("O Node.js não foi encontrado. Instale em nodejs.org e tente de novo.")?;
        match client.as_str() {
            "code" => {
                // Replaces any older registration (another install folder, say).
                let _ = run(&["claude", "mcp", "remove", SERVER_NAME, "-s", "user"]);
                if on {
                    run(&["claude", "mcp", "add", "--scope", "user", SERVER_NAME, "--", &node, &server]).ok_or("O Claude Code não aceitou o registro. Confira se o comando claude funciona no terminal.")?;
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
                    config["mcpServers"][SERVER_NAME] = json!({ "command": node, "args": [server] });
                } else if let Some(servers) = config["mcpServers"].as_object_mut() {
                    servers.remove(SERVER_NAME);
                }
                std::fs::write(&file, serde_json::to_vec_pretty(&config).unwrap()).map_err(|error| error.to_string())
            }
            _ => Err("cliente desconhecido".into()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}
