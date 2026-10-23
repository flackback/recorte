//! Finds takes by what was said in them, using the `transcript.json` the editor writes. Each
//! transcript is read once and kept, until its file changes.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

const TRANSCRIPT_FILE: &str = "transcript.json";
/// Characters of context kept on each side of the match in the snippet.
const CONTEXT: usize = 32;

#[derive(Deserialize)]
struct Transcript {
    #[serde(default)]
    words: Vec<Word>,
}

#[derive(Deserialize)]
struct Word {
    text: String,
}

/// A transcript as searchable text: the words joined by spaces, and the same text folded
/// (lowercase, no accents) one character for one, so a match in one is the same span in the other.
struct Text {
    modified: SystemTime,
    len: u64,
    original: Vec<char>,
    folded: Vec<char>,
}

static CACHE: Mutex<Option<HashMap<PathBuf, Text>>> = Mutex::new(None);

/// Lowercase without accents, one character in, one out.
fn fold(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' | 'Á' | 'À' | 'Â' | 'Ã' | 'Ä' => 'a',
        'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' | 'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
        'ç' | 'Ç' => 'c',
        'ñ' | 'Ñ' => 'n',
        _ => c.to_lowercase().next().unwrap_or(c),
    }
}

fn load(path: &Path) -> Option<Text> {
    let info = fs::metadata(path).ok()?;
    let transcript: Transcript = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let joined = transcript.words.iter().map(|word| word.text.trim()).filter(|text| !text.is_empty()).collect::<Vec<_>>().join(" ");
    let original: Vec<char> = joined.chars().collect();
    let folded = original.iter().copied().map(fold).collect();
    Some(Text { modified: info.modified().ok()?, len: info.len(), original, folded })
}

fn find(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// The words around `at..end`, cut at word edges, with an ellipsis where text was left out.
fn snippet(text: &[char], at: usize, end: usize) -> String {
    let mut start = at.saturating_sub(CONTEXT);
    let mut stop = (end + CONTEXT).min(text.len());
    if start > 0 {
        start = text[start..at].iter().position(|c| *c == ' ').map_or(start, |space| start + space + 1);
    }
    if stop < text.len() {
        stop = text[end..stop].iter().rposition(|c| *c == ' ').map_or(stop, |space| end + space);
    }
    let body: String = text[start..stop].iter().collect();
    format!("{}{}{}", if start > 0 { "…" } else { "" }, body.trim(), if stop < text.len() { "…" } else { "" })
}

#[derive(Serialize)]
pub struct Hit {
    id: String,
    snippet: String,
}

/// Takes in `root` whose transcript has every word of `query` (any order, ignoring case and
/// accents), with a bit of text around the first word.
pub fn search(root: &Path, query: &str) -> Vec<Hit> {
    let terms: Vec<Vec<char>> = query.split_whitespace().map(|term| term.chars().map(fold).collect()).collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut cache = CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    let mut seen = Vec::new();
    let mut hits = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path().join(TRANSCRIPT_FILE);
        let Ok(info) = fs::metadata(&path) else {
            continue;
        };
        let fresh = cache.get(&path).is_some_and(|text| Some(text.modified) == info.modified().ok() && text.len == info.len());
        if !fresh {
            match load(&path) {
                Some(text) => cache.insert(path.clone(), text),
                None => cache.remove(&path),
            };
        }
        seen.push(path.clone());
        let Some(text) = cache.get(&path) else {
            continue;
        };
        let Some(first) = find(&text.folded, &terms[0]) else {
            continue;
        };
        if terms[1..].iter().all(|term| find(&text.folded, term).is_some()) {
            let id = entry.file_name().to_string_lossy().into_owned();
            hits.push(Hit { id, snippet: snippet(&text.original, first, first + terms[0].len()) });
        }
    }
    // Takes moved to the Recycle Bin no longer take memory.
    cache.retain(|path, _| seen.contains(path));
    hits
}
