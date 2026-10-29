//! Writes an exported MP4 to disk as the muxer produces it, so long videos never sit in memory.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

pub const EXPORT_DIR: &str = "Exportados";

struct Export {
    file: File,
    partial: PathBuf,
    target: PathBuf,
}

#[derive(Default)]
pub struct Exports {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Export>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    id: u32,
    path: String,
}

/// Starts an export of `take_id` into `<takes>/Exportados`, writing to a `.part` file until done.
/// The files of one batch (several aspects) share `stamp` and differ by `suffix`, such as `-9x16`.
#[tauri::command]
pub fn export_create(
    app: AppHandle,
    exports: State<'_, Exports>,
    take_id: String,
    extension: String,
    stamp: Option<String>,
    suffix: Option<String>,
) -> Result<Created, String> {
    let target = export_target(&app, &take_id, &extension, stamp, suffix)?;
    remove_leftovers(target.parent().unwrap_or(std::path::Path::new(".")), &exports);
    open(&exports, target)
}

/// Where an export of `take_id` goes: `<takes>/Exportados/<take>-<stamp><suffix>.<extension>`.
pub(crate) fn export_target(app: &AppHandle, take_id: &str, extension: &str, stamp: Option<String>, suffix: Option<String>) -> Result<PathBuf, String> {
    // png: a still of the current frame ("Imagem" in the editor).
    if !matches!(extension, "mp4" | "gif" | "png") {
        return Err("formato inválido".into());
    }
    if take_id.is_empty() || !take_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("identificador de gravação inválido".into());
    }
    let stamp = stamp.unwrap_or_else(|| chrono::Local::now().format("%H%M%S").to_string());
    if stamp.is_empty() || stamp.len() > 16 || !stamp.chars().all(|c| c.is_ascii_digit()) {
        return Err("horário inválido".into());
    }
    let suffix = suffix.unwrap_or_default();
    if suffix.len() > 16 || !suffix.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("sufixo inválido".into());
    }
    let dir = crate::takes_root(app)?.join(EXPORT_DIR);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(format!("{take_id}-{stamp}{suffix}.{extension}")))
}

/// Starts writing `name` into a take's folder (webcam recording, background image, music).
#[tauri::command]
pub fn asset_create(app: AppHandle, exports: State<'_, Exports>, dir: String, name: String) -> Result<Created, String> {
    let valid = !name.is_empty() && name.len() < 120 && name.chars().all(|c| c.is_alphanumeric() || "._- ".contains(c)) && !name.starts_with('.');
    // The take's own metadata and edit are written by their dedicated commands only.
    if !valid || name == "take.json" || name == "project.json" || name == "cursor.json" || name == "keys.json" {
        return Err("nome de arquivo inválido".into());
    }
    let dir = crate::take_dir(&app, &dir)?;
    open(&exports, dir.join(name))
}

pub(crate) fn open(exports: &Exports, target: PathBuf) -> Result<Created, String> {
    let mut partial = target.clone().into_os_string();
    partial.push(".part");
    let partial = PathBuf::from(partial);
    let file = File::create(&partial).map_err(|error| format!("criar {}: {error}", partial.display()))?;
    let id = exports.next.fetch_add(1, Ordering::Relaxed);
    let path = target.to_string_lossy().into_owned();
    exports.open.lock().unwrap().insert(id, Export { file, partial, target });
    Ok(Created { id, path })
}

/// Deletes `.part` files left by exports that never finished (app closed or crashed mid-export).
fn remove_leftovers(dir: &std::path::Path, exports: &Exports) {
    let open: Vec<PathBuf> = exports.open.lock().unwrap().values().map(|export| export.partial.clone()).collect();
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        let name = path.to_string_lossy();
        let partial = name.ends_with(".mp4.part") || name.ends_with(".gif.part") || name.ends_with(".png.part");
        if partial && !open.contains(&path) {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Runs file work on a blocking thread, so a slow disk never stalls the main thread.
async fn on_disk<T: Send + 'static>(app: AppHandle, work: impl FnOnce(&Exports) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<Exports>())).await.map_err(|error| error.to_string())?
}

/// Writes the raw request body at the byte offset in `x-position`. The muxer seeks back once at
/// the end to patch sizes, so writes are positioned rather than appended.
#[tauri::command]
pub async fn export_write(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("corpo da requisição deveria ser binário".into());
    };
    let header = |name: &str| -> Result<u64, String> {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| format!("cabeçalho {name} ausente"))
    };
    let id = header("x-export-id")? as u32;
    let position = header("x-position")?;
    // The body belongs to the request; the blocking thread needs its own copy.
    let data = data.clone();

    on_disk(app, move |exports| {
        let mut open = exports.open.lock().unwrap();
        let export = open.get_mut(&id).ok_or("exportação desconhecida")?;
        export.file.seek(SeekFrom::Start(position)).map_err(|error| error.to_string())?;
        export.file.write_all(&data).map_err(|error| error.to_string())
    })
    .await
}

/// Closes the file and gives it its final name.
#[tauri::command]
pub async fn export_finish(app: AppHandle, id: u32) -> Result<String, String> {
    on_disk(app, move |exports| {
        let export = exports.open.lock().unwrap().remove(&id).ok_or("exportação desconhecida")?;
        export.file.sync_all().map_err(|error| error.to_string())?;
        drop(export.file);
        let _ = fs::remove_file(&export.target);
        fs::rename(&export.partial, &export.target).map_err(|error| error.to_string())?;
        Ok(export.target.to_string_lossy().into_owned())
    })
    .await
}

/// Drops an unfinished export and its partial file.
#[tauri::command]
pub fn export_cancel(exports: State<'_, Exports>, id: u32) -> Result<(), String> {
    if let Some(export) = exports.open.lock().unwrap().remove(&id) {
        drop(export.file);
        let _ = fs::remove_file(&export.partial);
    }
    Ok(())
}
