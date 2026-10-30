// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // AI clients start `recorte.exe --mcp` for the MCP server; it opens no window.
    if std::env::args().any(|arg| arg == "--mcp") {
        std::process::exit(recorte_lib::mcp::run());
    }
    recorte_lib::run()
}
