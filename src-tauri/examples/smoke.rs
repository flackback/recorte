//! Grava alguns segundos da tela principal sem a interface, para testar a captura:
//! `cargo run --example smoke -- <pasta> [segundos]`

use std::path::PathBuf;
use std::time::Duration;

use recorte_lib::recorder::{Recording, SourceRef, StartOptions};
use recorte_lib::sources;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("pasta de saída"));
    let seconds: u64 = args.next().map(|value| value.parse()).transpose()?.unwrap_or(4);

    let found = sources::list()?;
    let primary = found.monitors.iter().find(|monitor| monitor.primary).expect("monitor principal");
    println!("monitor {} {}x{}; {} janelas", primary.name, primary.width, primary.height, found.windows.len());

    let recording = Recording::start(
        StartOptions {
            source: SourceRef::Monitor { index: primary.index },
            system_audio: true,
            microphone: true,
            show_cursor: true,
            keystrokes: false,
            crop: None,
            fps: 60,
        },
        &root,
    )?;
    for warning in recording.warnings() {
        println!("aviso: {warning}");
    }
    std::thread::sleep(Duration::from_secs(seconds));
    let meta = recording.stop()?;
    println!("{}", serde_json::to_string_pretty(&meta)?);
    Ok(())
}
