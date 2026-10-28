//! Brings a video file from elsewhere on the computer in as a take, edited like a recording. The
//! editor reads H.264 in MP4 or MOV, with AAC sound; anything else is refused before a take
//! folder exists. The file is copied, never moved: the original stays where it was.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::export::{self, Exports};
use crate::recorder::{self, TakeMeta};

/// Videos are copied (or, when dropped on the window, uploaded) here first, next to the takes, so
/// moving one into its take folder is a rename and an interrupted copy never looks like a take.
const UPLOAD_DIR: &str = ".importando";
/// Files there untouched this long belong to an import that never finished.
const STALE: Duration = Duration::from_secs(600);
const COPY_CHUNK: usize = 8 * 1024 * 1024;
/// A `moov` index larger than this is not a video the editor could open anyway.
const MAX_INDEX: u64 = 256 * 1024 * 1024;
/// The thumbnail is taken this far in (or a tenth of a shorter video), past fades from black.
const THUMB_AT_MS: f64 = 2000.0;

const UNSUPPORTED: &str = "Formato não suportado. Use um vídeo MP4 ou MOV em H.264.";

/// One import at a time: they share the disk, and the progress shown is for one file.
static BUSY: AtomicBool = AtomicBool::new(false);
static NEXT_UPLOAD: AtomicU32 = AtomicU32::new(0);

struct Busy;

impl Busy {
    fn take() -> Result<Self, String> {
        if BUSY.swap(true, Ordering::AcqRel) {
            return Err("Já existe uma importação em andamento.".into());
        }
        Ok(Busy)
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

// ---------- reading the MP4 index ----------

type FourCc = [u8; 4];

/// What the take needs to know about a video file.
#[derive(Debug)]
pub struct Probe {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration_ms: f64,
    pub frames: u64,
    /// The sound is AAC, which the editor plays and exports from the video itself.
    pub audio: bool,
    pub warnings: Vec<String>,
}

#[derive(Default)]
struct Track {
    id: u32,
    handler: FourCc,
    codec: FourCc,
    /// avcC for H.264, esds for AAC: the editor's decoders need it.
    config: bool,
    width: u32,
    height: u32,
    rotated: bool,
    timescale: u32,
    samples: u64,
    /// Sum of the sample durations, in `timescale` units.
    length: u64,
    /// mdhd duration, when the sample tables say nothing (fragmented files).
    declared: u64,
}

fn u16_at(data: &[u8], at: usize) -> u16 {
    data.get(at..at + 2).map_or(0, |bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn u32_at(data: &[u8], at: usize) -> u32 {
    data.get(at..at + 4).map_or(0, |bytes| u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    (u32_at(data, at) as u64) << 32 | u32_at(data, at + 4) as u64
}

/// The boxes directly inside `data`, as (type, content).
fn boxes(data: &[u8]) -> Vec<(FourCc, &[u8])> {
    let mut found = Vec::new();
    let mut at = 0;
    while at + 8 <= data.len() {
        let mut size = u32_at(data, at) as u64;
        let kind: FourCc = data[at + 4..at + 8].try_into().unwrap();
        let mut header = 8;
        if size == 1 {
            size = u64_at(data, at + 8);
            header = 16;
        } else if size == 0 {
            size = (data.len() - at) as u64;
        }
        if size < header as u64 || at as u64 + size > data.len() as u64 {
            break;
        }
        found.push((kind, &data[at + header..at + size as usize]));
        at += size as usize;
    }
    found
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data).into_iter().find(|(found, _)| found == kind).map(|(_, content)| content)
}

fn parse_trak(trak: &[u8]) -> Track {
    let mut track = Track::default();
    if let Some(tkhd) = child(trak, b"tkhd") {
        let v1 = tkhd.first() == Some(&1);
        track.id = u32_at(tkhd, if v1 { 20 } else { 12 });
        let matrix = if v1 { 52 } else { 40 };
        let (a, b, c, d) = (u32_at(tkhd, matrix), u32_at(tkhd, matrix + 4), u32_at(tkhd, matrix + 12), u32_at(tkhd, matrix + 16));
        track.rotated = tkhd.len() >= matrix + 20 && (a, b, c, d) != (0x10000, 0, 0, 0x10000);
    }
    let Some(mdia) = child(trak, b"mdia") else {
        return track;
    };
    if let Some(mdhd) = child(mdia, b"mdhd") {
        if mdhd.first() == Some(&1) {
            track.timescale = u32_at(mdhd, 20);
            track.declared = u64_at(mdhd, 24);
        } else {
            track.timescale = u32_at(mdhd, 12);
            track.declared = u32_at(mdhd, 16) as u64;
        }
    }
    if let Some(hdlr) = child(mdia, b"hdlr") {
        track.handler = hdlr.get(8..12).and_then(|bytes| bytes.try_into().ok()).unwrap_or_default();
    }
    let Some(stbl) = child(mdia, b"minf").and_then(|minf| child(minf, b"stbl")) else {
        return track;
    };
    if let Some((codec, entry)) = child(stbl, b"stsd").and_then(|stsd| stsd.get(8..)).and_then(|entries| boxes(entries).into_iter().next()) {
        track.codec = codec;
        if &track.handler == b"vide" {
            track.width = u16_at(entry, 24) as u32;
            track.height = u16_at(entry, 26) as u32;
            track.config = entry.get(78..).is_some_and(|rest| child(rest, b"avcC").is_some());
        } else if &track.handler == b"soun" {
            // As the editor reads it: QuickTime sound descriptions are longer from version 1 on,
            // and may keep the esds inside a "wave" box.
            let version = u16_at(entry, 8);
            let skip = match version {
                0 => 28,
                1 => 44,
                2 => 64,
                _ => usize::MAX,
            };
            let inside = entry.get(skip..).unwrap_or_default();
            track.config = child(inside, b"esds").or_else(|| child(inside, b"wave").and_then(|wave| child(wave, b"esds"))).is_some();
        }
    }
    if let Some(stts) = child(stbl, b"stts") {
        let entries = u32_at(stts, 4) as usize;
        for index in 0..entries {
            let at = 8 + index * 8;
            if at + 8 > stts.len() {
                break;
            }
            let (count, delta) = (u32_at(stts, at) as u64, u32_at(stts, at + 4) as u64);
            track.samples += count;
            track.length += count * delta;
        }
    }
    track
}

/// Adds a fragment's samples (count and durations) to the tracks they belong to.
fn parse_moof(moof: &[u8], tracks: &mut [Track], defaults: &HashMap<u32, u32>) {
    for (_, traf) in boxes(moof).into_iter().filter(|(kind, _)| kind == b"traf") {
        let Some(tfhd) = child(traf, b"tfhd") else {
            continue;
        };
        let flags = u32_at(tfhd, 0) & 0xff_ffff;
        let id = u32_at(tfhd, 4);
        let mut at = 8;
        if flags & 0x1 != 0 {
            at += 8;
        }
        if flags & 0x2 != 0 {
            at += 4;
        }
        let default_duration = if flags & 0x8 != 0 { u32_at(tfhd, at) } else { defaults.get(&id).copied().unwrap_or(0) } as u64;
        let Some(track) = tracks.iter_mut().find(|track| track.id == id) else {
            continue;
        };
        for (_, trun) in boxes(traf).into_iter().filter(|(kind, _)| kind == b"trun") {
            let flags = u32_at(trun, 0) & 0xff_ffff;
            let count = u32_at(trun, 4) as u64;
            track.samples += count;
            if flags & 0x100 == 0 {
                track.length += count * default_duration;
                continue;
            }
            let mut at = 8 + if flags & 0x1 != 0 { 4 } else { 0 } + if flags & 0x4 != 0 { 4 } else { 0 };
            let stride = [0x100, 0x200, 0x400, 0x800].iter().filter(|bit| flags & **bit != 0).count() * 4;
            for _ in 0..count {
                track.length += u32_at(trun, at) as u64;
                at += stride;
            }
        }
    }
}

/// A top-level box of the file: its type, where its content starts and how long it is.
fn top_level(file: &mut File, len: u64) -> io::Result<Vec<(FourCc, u64, u64)>> {
    let mut found = Vec::new();
    let mut at = 0;
    while at + 8 <= len {
        let mut header = [0u8; 16];
        file.seek(SeekFrom::Start(at))?;
        file.read_exact(&mut header[..8])?;
        let mut size = u32_at(&header, 0) as u64;
        let kind: FourCc = header[4..8].try_into().unwrap();
        let mut head = 8;
        if size == 1 {
            file.read_exact(&mut header[8..16])?;
            size = u64_at(&header, 8);
            head = 16;
        } else if size == 0 {
            size = len - at;
        }
        // Not a box: the file is not an MP4, or it is damaged from here on.
        if !kind.iter().all(|byte| byte.is_ascii_graphic() || *byte == b' ') || size < head {
            break;
        }
        found.push((kind, at + head, (size - head).min(len.saturating_sub(at + head))));
        at += size;
    }
    Ok(found)
}

fn codec_name(codec: &FourCc) -> String {
    match codec {
        b"hvc1" | b"hev1" => "HEVC (H.265)".into(),
        b"vp09" => "VP9".into(),
        b"av01" => "AV1".into(),
        b"mp4v" => "MPEG-4 Parte 2".into(),
        b"apcn" | b"apch" | b"apcs" | b"apco" | b"ap4h" | b"ap4x" => "ProRes".into(),
        b"encv" => "protegido (DRM)".into(),
        _ => String::from_utf8_lossy(codec).trim().to_string(),
    }
}

/// Reads a video file's index and says whether the editor can open it.
pub fn probe(path: &Path) -> Result<Probe, String> {
    let mut file = File::open(path).map_err(|error| format!("Não foi possível abrir o arquivo: {error}"))?;
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    let mut magic = [0u8; 12];
    if len < 12 || file.read_exact(&mut magic).is_err() {
        return Err(UNSUPPORTED.into());
    }
    if magic[..4] == [0x1a, 0x45, 0xdf, 0xa3] {
        return Err("Arquivos MKV e WebM não são suportados. Converta para MP4 em H.264.".into());
    }
    if &magic[..4] == b"RIFF" {
        return Err("Arquivos AVI não são suportados. Converta para MP4 em H.264.".into());
    }
    let known: [&[u8; 4]; 10] = [b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"pnot", b"styp", b"sidx", b"uuid"];
    if !known.iter().any(|kind| **kind == magic[4..8]) {
        return Err(UNSUPPORTED.into());
    }

    let top = top_level(&mut file, len).map_err(|error| error.to_string())?;
    let Some(&(_, start, size)) = top.iter().find(|(kind, _, _)| kind == b"moov") else {
        return Err("O vídeo está incompleto (sem índice). Ele pode ainda estar sendo gravado ou ter sido cortado.".into());
    };
    if size > MAX_INDEX {
        return Err(UNSUPPORTED.into());
    }
    let read = |file: &mut File, start: u64, size: u64| -> Result<Vec<u8>, String> {
        let mut data = vec![0u8; size as usize];
        file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut data)).map_err(|error| error.to_string())?;
        Ok(data)
    };
    let moov = read(&mut file, start, size)?;
    let mut tracks: Vec<Track> = boxes(&moov).into_iter().filter(|(kind, _)| kind == b"trak").map(|(_, trak)| parse_trak(trak)).collect();
    let defaults: HashMap<u32, u32> = child(&moov, b"mvex")
        .map(|mvex| boxes(mvex).into_iter().filter(|(kind, _)| kind == b"trex").map(|(_, trex)| (u32_at(trex, 4), u32_at(trex, 12))).collect())
        .unwrap_or_default();
    for &(_, start, size) in top.iter().filter(|(kind, _, _)| kind == b"moof") {
        if size <= MAX_INDEX {
            parse_moof(&read(&mut file, start, size)?, &mut tracks, &defaults);
        }
    }

    let Some(video) = tracks.iter().find(|track| &track.handler == b"vide") else {
        return Err("O arquivo não tem vídeo.".into());
    };
    if !matches!(&video.codec, b"avc1" | b"avc3") || !video.config {
        return Err(format!("Este vídeo usa o codec {}, que o Recorte não edita. Converta para H.264.", codec_name(&video.codec)));
    }
    let length = if video.length > 0 { video.length } else { video.declared };
    if video.samples == 0 || length == 0 || video.timescale == 0 || video.width == 0 || video.height == 0 {
        return Err("O vídeo está vazio ou danificado.".into());
    }
    let seconds = length as f64 / video.timescale as f64;
    let mut warnings = Vec::new();
    if video.rotated {
        warnings.push("Este vídeo tem rotação (por exemplo, gravado com o celular em pé). Ele aparece sem a rotação.".into());
    }
    let sound = tracks.iter().find(|track| &track.handler == b"soun");
    let audio = sound.is_some_and(|track| &track.codec == b"mp4a" && track.config);
    if let Some(track) = sound.filter(|_| !audio) {
        warnings.push(format!("O som deste vídeo ({}) não pode ser lido. O vídeo entra sem som.", codec_name(&track.codec)));
    }
    Ok(Probe {
        width: video.width,
        height: video.height,
        fps: ((video.samples as f64 / seconds).round() as u32).max(1),
        duration_ms: (seconds * 10_000.0).round() / 10.0,
        frames: video.samples,
        audio,
        warnings,
    })
}

// ---------- thumbnail ----------

/// Decodes one frame near `at_ms` with Media Foundation and saves it as a JPEG. The editor's own
/// decoder lives in the WebView; this runs where the take is made, also for the MCP server.
fn save_thumbnail(video: &Path, target: &Path, at_ms: f64, width: u32, height: u32) -> windows::core::Result<()> {
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
    use windows::core::{GUID, HSTRING, Interface};
    use windows_capture::encoder::{ImageEncoder, ImageEncoderPixelFormat, ImageFormat};

    let frame = || -> windows::core::Result<(Vec<u8>, u32, u32)> {
        unsafe {
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 1)?;
            let attributes = attributes.ok_or_else(windows::core::Error::empty)?;
            // Lets the reader convert the decoded frames to RGB.
            attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)?;
            let reader = MFCreateSourceReaderFromURL(&HSTRING::from(video.as_os_str()), &attributes)?;
            let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
            reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
            reader.SetStreamSelection(stream, true)?;
            let wanted = MFCreateMediaType()?;
            wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            wanted.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
            reader.SetCurrentMediaType(stream, None, &wanted)?;
            let current = reader.GetCurrentMediaType(stream)?;
            let size = current.GetUINT64(&MF_MT_FRAME_SIZE)?;
            let (frame_width, frame_height) = ((size >> 32) as u32, size as u32);
            let stride = current.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|stride| stride as i32).unwrap_or(frame_width as i32 * 4);
            if at_ms > 0.0 {
                let _ = reader.SetCurrentPosition(&GUID::zeroed(), &PROPVARIANT::from((at_ms * 10_000.0) as i64));
            }
            let (width, height) = (width.min(frame_width), height.min(frame_height));
            for _ in 0..240 {
                let mut flags = 0u32;
                let mut sample = None;
                reader.ReadSample(stream, 0, None, Some(&mut flags), None, Some(&mut sample))?;
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    break;
                }
                let Some(sample) = sample else {
                    continue;
                };
                let mut pixels = Vec::with_capacity((width * height * 4) as usize);
                let buffer = sample.GetBufferByIndex(0)?;
                if let Ok(planes) = buffer.cast::<IMF2DBuffer>() {
                    // The real row pitch, often wider than the picture; negative when bottom up.
                    let (mut first, mut pitch) = (std::ptr::null_mut(), 0i32);
                    planes.Lock2D(&mut first, &mut pitch)?;
                    for row in 0..height as isize {
                        pixels.extend_from_slice(std::slice::from_raw_parts(first.offset(row * pitch as isize), width as usize * 4));
                    }
                    planes.Unlock2D()?;
                } else {
                    let buffer = sample.ConvertToContiguousBuffer()?;
                    let (mut data, mut length) = (std::ptr::null_mut(), 0u32);
                    buffer.Lock(&mut data, None, Some(&mut length))?;
                    let bytes = std::slice::from_raw_parts(data, length as usize);
                    // The decoder pads the picture to whole 16-pixel blocks, in width or height,
                    // and the stride it reports can leave that out (1080 wide is stored 1088
                    // wide). The buffer's length tells which: it holds whole rows.
                    let line = width as usize * 4;
                    let (pitch, rows) = [frame_height, frame_height.next_multiple_of(16)]
                        .into_iter()
                        .map(|rows| (length as usize / rows as usize, rows as usize))
                        .find(|&(pitch, rows)| pitch * rows == length as usize && pitch >= line && pitch < line + 64 * 4)
                        .unwrap_or((stride.unsigned_abs() as usize, frame_height as usize));
                    for row in 0..height as usize {
                        // A negative stride means the rows are stored bottom up.
                        let source = if stride < 0 { rows - 1 - row } else { row };
                        let Some(line) = bytes.get(source * pitch..source * pitch + line) else {
                            break;
                        };
                        pixels.extend_from_slice(line);
                    }
                    buffer.Unlock()?;
                }
                if pixels.len() < (width * height * 4) as usize {
                    break;
                }
                // RGB32 leaves the fourth byte undefined; JPEG wants it opaque.
                for pixel in pixels.chunks_exact_mut(4) {
                    pixel[3] = 255;
                }
                return Ok((pixels, width, height));
            }
            Err(windows::core::Error::empty())
        }
    };

    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let decoded = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.and_then(|()| {
        let decoded = frame();
        unsafe {
            let _ = MFShutdown();
        }
        decoded
    });
    if com.is_ok() {
        unsafe { CoUninitialize() };
    }
    let (pixels, width, height) = decoded?;
    let bytes = ImageEncoder::new(ImageFormat::Jpeg, ImageEncoderPixelFormat::Bgra8)
        .and_then(|encoder| encoder.encode(&pixels, width, height))
        .map_err(|error| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, error.to_string()))?;
    fs::write(target, bytes).map_err(|error| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, error.to_string()))
}

// ---------- making the take ----------

/// Removes upload and copy leftovers of imports that never finished.
fn remove_leftovers(uploads: &Path) {
    let Ok(entries) = fs::read_dir(uploads) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let stale = entry.metadata().and_then(|meta| meta.modified()).ok().and_then(|modified| modified.elapsed().ok()).is_some_and(|age| age > STALE);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Copies `source` to `target` a piece at a time, reporting (done, total) bytes.
fn copy(source: &Path, target: &Path, progress: &mut impl FnMut(u64, u64)) -> io::Result<()> {
    let mut from = File::open(source)?;
    let total = from.metadata()?.len();
    let mut to = File::create(target)?;
    let mut buffer = vec![0u8; COPY_CHUNK];
    let (mut done, mut told) = (0u64, Instant::now());
    loop {
        let read = from.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        to.write_all(&buffer[..read])?;
        done += read as u64;
        if told.elapsed() >= Duration::from_millis(150) {
            told = Instant::now();
            progress(done, total);
        }
    }
    progress(done, total);
    to.sync_all()
}

/// Makes a take from `source`: checks it, copies it (or moves it, when it was uploaded into the
/// imports folder), then writes the thumbnail and `take.json`. Nothing is left behind on failure.
/// `name` is the original file name, for uploads whose own name means nothing.
pub fn import(root: &Path, source: &Path, name: Option<&str>, mut progress: impl FnMut(u64, u64)) -> Result<TakeMeta, String> {
    let _busy = Busy::take()?;
    let uploads = root.join(UPLOAD_DIR);
    let uploaded = source.parent().and_then(|dir| dir.canonicalize().ok()).is_some_and(|dir| uploads.canonicalize().is_ok_and(|uploads| uploads == dir));
    let probed = probe(source);
    let probe = match probed {
        Ok(probe) => probe,
        Err(error) => {
            if uploaded {
                let _ = fs::remove_file(source);
            }
            return Err(error);
        }
    };
    let file_name = name.map(str::to_string).or_else(|| source.file_name().map(|name| name.to_string_lossy().into_owned())).unwrap_or_default();

    let staged = if uploaded {
        source.to_path_buf()
    } else {
        fs::create_dir_all(&uploads).map_err(|error| error.to_string())?;
        remove_leftovers(&uploads);
        let size = fs::metadata(source).map_err(|error| error.to_string())?.len();
        if recorder::free_space(root).is_some_and(|free| free < size + recorder::DISK_STOP_BYTES) {
            return Err("Não há espaço livre suficiente no disco das gravações para este vídeo.".into());
        }
        let staged = uploads.join(format!("copia-{}-{}.mp4", std::process::id(), NEXT_UPLOAD.fetch_add(1, Ordering::Relaxed)));
        if let Err(error) = copy(source, &staged, &mut progress) {
            let _ = fs::remove_file(&staged);
            return Err(format!("Não foi possível copiar o vídeo: {error}"));
        }
        staged
    };

    let created = chrono::Local::now();
    let (id, dir) = match recorder::create_take_dir(root, &format!("take-{}", created.format("%Y%m%d-%H%M%S"))) {
        Ok(made) => made,
        Err(error) => {
            let _ = fs::remove_file(&staged);
            return Err(format!("{error:#}"));
        }
    };
    let made = (|| -> Result<TakeMeta, String> {
        let video = dir.join(recorder::VIDEO_FILE);
        fs::rename(&staged, &video).map_err(|error| format!("Não foi possível mover o vídeo: {error}"))?;
        recorder::write_json(&dir.join(recorder::CURSOR_FILE), &json!({ "version": 2, "events": [] })).map_err(|error| format!("{error:#}"))?;
        let thumb = dir.join(recorder::THUMB_FILE);
        let at = THUMB_AT_MS.min(probe.duration_ms / 10.0);
        let thumbnail = save_thumbnail(&video, &thumb, at, probe.width, probe.height).is_ok() && thumb.exists();
        let title = Path::new(&file_name).file_stem().map(|stem| stem.to_string_lossy().chars().take(120).collect::<String>()).filter(|title| !title.trim().is_empty());
        let mut meta = TakeMeta {
            version: 1,
            id,
            created_at: created.to_rfc3339(),
            source_kind: "import".into(),
            source_name: file_name.clone(),
            width: probe.width,
            height: probe.height,
            fps: probe.fps,
            origin_x: 0,
            origin_y: 0,
            duration_ms: probe.duration_ms,
            frames: probe.frames,
            video: recorder::VIDEO_FILE.into(),
            system_audio: probe.audio,
            // The sound stays inside the video, as in older takes.
            system_file: None,
            mic: None,
            cursor: recorder::CURSOR_FILE.into(),
            cursor_in_video: true,
            keys: None,
            webcam: None,
            webcam_offset_ms: None,
            thumbnail: thumbnail.then(|| recorder::THUMB_FILE.to_string()),
            title,
            crop: None,
            pauses: Vec::new(),
            markers: Vec::new(),
            start_hns: 0,
            warnings: probe.warnings.clone(),
            segments: Vec::new(),
            dir: String::new(),
        };
        recorder::write_json(&dir.join(recorder::META_FILE), &meta).map_err(|error| format!("{error:#}"))?;
        meta.dir = dir.to_string_lossy().into_owned();
        Ok(meta)
    })();
    if made.is_err() {
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&staged);
    }
    made
}

/// Imports for the app and the MCP server, telling the main window how the copy goes.
pub fn run(app: &AppHandle, source: &Path, name: Option<&str>) -> Result<TakeMeta, String> {
    let root = crate::takes_root(app)?;
    let tell = |done: u64, total: u64| {
        let _ = app.emit_to("main", "import-progress", json!({ "done": done, "total": total }));
    };
    let imported = import(&root, source, name, tell);
    // Done or failed, the progress ends; a new take also shows up in the list.
    let _ = app.emit_to("main", "import-progress", json!({ "done": 1, "total": 1 }));
    if let Ok(meta) = &imported {
        let _ = app.emit_to("main", "takes-changed", json!({ "id": meta.id }));
    }
    imported
}

/// Imports the video at `path` as a new take. `name` is the original file name for uploads.
#[tauri::command]
pub async fn take_import(app: AppHandle, path: String, name: Option<String>) -> Result<TakeMeta, String> {
    tauri::async_runtime::spawn_blocking(move || run(&app, Path::new(&path), name.as_deref())).await.map_err(|error| error.to_string())?
}

/// Starts uploading a video dropped on the window (the WebView gives its bytes, not its path).
/// It is written with `export_write` and `export_finish`, then passed to `take_import`.
#[tauri::command]
pub fn import_upload(app: AppHandle, exports: State<'_, Exports>) -> Result<export::Created, String> {
    let uploads: PathBuf = crate::takes_root(&app)?.join(UPLOAD_DIR);
    fs::create_dir_all(&uploads).map_err(|error| error.to_string())?;
    remove_leftovers(&uploads);
    let target = uploads.join(format!("envio-{}-{}.mp4", std::process::id(), NEXT_UPLOAD.fetch_add(1, Ordering::Relaxed)));
    export::open(&exports, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Set RECORTE_IMPORT_TEST to a video file to check the probe and the thumbnail on it.
    #[test]
    fn probes_a_real_file() {
        let Some(path) = std::env::var_os("RECORTE_IMPORT_TEST") else {
            return;
        };
        let path = PathBuf::from(path);
        let started = Instant::now();
        let probe = probe(&path);
        println!("{probe:?} in {:?}", started.elapsed());
        if let Ok(probe) = probe {
            let target = std::env::temp_dir().join("recorte-import-test.jpg");
            let started = Instant::now();
            let saved = save_thumbnail(&path, &target, THUMB_AT_MS.min(probe.duration_ms / 10.0), probe.width, probe.height);
            println!("thumbnail {saved:?} at {} in {:?}", target.display(), started.elapsed());
        }
        // RECORTE_IMPORT_ROOT: a scratch takes folder to make the whole take in.
        if let Some(root) = std::env::var_os("RECORTE_IMPORT_ROOT") {
            let mut steps = 0;
            let imported = import(Path::new(&root), &path, None, |_, _| steps += 1);
            match imported {
                Ok(meta) => println!("take {} ({} progress reports)\n{}", meta.dir, steps, fs::read_to_string(Path::new(&meta.dir).join(recorder::META_FILE)).unwrap()),
                Err(error) => println!("refused: {error}"),
            }
        }
    }
}
