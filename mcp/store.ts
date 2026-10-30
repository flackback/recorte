import { defaultProject, normalizeProject, type Project } from "../src/editor/project";
import { TimeMap } from "../src/editor/timemap";
import { takeName, type CursorEvent, type KeyEvent, type Take, type Word } from "../src/types";
import { env, extname, files, homeDir, join, videosDir } from "./host";

/** Reads and writes takes on disk, the same files the app uses. */

const META_FILE = "take.json";
const PROJECT_FILE = "project.json";
const TRANSCRIPT_FILE = "transcript.json";
/** Edits made through the MCP server, oldest first, so the last one can be undone. */
const HISTORY_DIR = ".mcp-history";
const HISTORY_LIMIT = 50;

export const CONTROL_FILE = join(env("LOCALAPPDATA") ?? join(homeDir(), "AppData", "Local"), "dev.recorte.app", "control.json");

let root: string | null = null;

export async function takesRoot(): Promise<string> {
  if (root) return root;
  const custom = env("RECORTE_TAKES_DIR");
  if (custom) return (root = custom);
  try {
    const control = JSON.parse(await files.readText(CONTROL_FILE));
    if (typeof control.takesDir === "string" && control.takesDir) return (root = control.takesDir as string);
  } catch {
    // The app is not running; use the Videos folder.
  }
  return (root = join(videosDir(), "Recorte"));
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await files.readText(file)) as T;
  } catch {
    return null;
  }
}

/** Write then rename, so a crash mid-save never leaves a truncated file. */
async function writeAtomic(file: string, text: string) {
  const temporary = `${file}.tmp`;
  await files.writeText(temporary, text);
  await files.rename(temporary, file);
}

export async function listTakes(): Promise<Take[]> {
  const base = await takesRoot();
  let entries: string[];
  try {
    entries = await files.list(base);
  } catch {
    return [];
  }
  const takes: Take[] = [];
  for (const name of entries) {
    const dir = join(base, name);
    const meta = await readJson<Take>(join(dir, META_FILE));
    if (meta) takes.push({ ...meta, dir });
  }
  return takes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export { takeName };

/** Finds a take by id, by "latest", or by a unique part of its name. */
export async function findTake(ref: string): Promise<Take> {
  const takes = await listTakes();
  if (!takes.length) throw new Error(`Nenhuma gravação encontrada em ${await takesRoot()}.`);
  const wanted = ref.trim().toLowerCase();
  if (!wanted || ["latest", "last", "última", "ultima", "recente"].includes(wanted)) return takes[0];
  const exact = takes.find((take) => take.id.toLowerCase() === wanted);
  if (exact) return exact;
  const named = takes.filter((take) => takeName(take).toLowerCase().includes(wanted) || take.id.toLowerCase().includes(wanted));
  if (named.length === 1) return named[0];
  const options = (named.length ? named : takes).slice(0, 10).map((take) => `${take.id} (${takeName(take)})`).join(", ");
  throw new Error(named.length ? `Mais de uma gravação corresponde a "${ref}": ${options}.` : `Gravação "${ref}" não encontrada. Gravações: ${options}.`);
}

export async function loadCursor(take: Take): Promise<CursorEvent[]> {
  return (await readJson<{ events: CursorEvent[] }>(join(take.dir, take.cursor)))?.events ?? [];
}

export async function loadKeys(take: Take): Promise<KeyEvent[]> {
  if (!take.keys) return [];
  return (await readJson<{ events: KeyEvent[] }>(join(take.dir, take.keys)))?.events ?? [];
}

export async function loadWords(take: Take): Promise<Word[] | null> {
  return (await readJson<{ words: Word[] }>(join(take.dir, TRANSCRIPT_FILE)))?.words ?? null;
}

/** The take's edit, or the default the editor would start from when it was never edited. */
export async function loadProject(take: Take): Promise<{ project: Project; saved: boolean }> {
  const fallback = defaultProject(take, await loadCursor(take));
  const raw = await readJson<unknown>(join(take.dir, PROJECT_FILE));
  return raw ? { project: normalizeProject(raw, fallback), saved: true } : { project: fallback, saved: false };
}

async function readText(file: string) {
  try {
    return await files.readText(file);
  } catch {
    return null;
  }
}

type HistoryEntry = { label: string; at: string; before: string | null; after: string };

/** Saves the edit and records the previous one, so `undoLastEdit` can bring it back. */
export async function saveProject(take: Take, project: Project, label: string) {
  const file = join(take.dir, PROJECT_FILE);
  const before = await readText(file);
  const after = JSON.stringify(project, null, 2);
  if (before === after) return false;
  const history = join(take.dir, HISTORY_DIR);
  await files.makeDir(history);
  const entry: HistoryEntry = { label, at: new Date().toISOString(), before, after };
  await files.writeText(join(history, `${Date.now().toString().padStart(15, "0")}.json`), JSON.stringify(entry));
  const saved = (await files.list(history)).sort();
  for (const old of saved.slice(0, Math.max(0, saved.length - HISTORY_LIMIT))) await files.remove(join(history, old));
  await writeAtomic(file, after);
  return true;
}

/**
 * Restores the edit from before the last MCP change. Refuses when the project changed since then
 * (in the editor, for example), so nothing the user did is lost.
 */
export async function undoLastEdit(take: Take): Promise<string> {
  const history = join(take.dir, HISTORY_DIR);
  const saved = files.exists(history) ? (await files.list(history)).sort() : [];
  const last = saved.pop();
  if (!last) throw new Error("Não há edição da IA para desfazer nesta gravação.");
  const entry = JSON.parse(await files.readText(join(history, last))) as HistoryEntry;
  const file = join(take.dir, PROJECT_FILE);
  const current = await readText(file);
  if (current !== entry.after) {
    throw new Error("A edição mudou depois da última alteração da IA (talvez no editor). Use Ctrl+Z no editor ou faça a correção com as outras ferramentas.");
  }
  if (entry.before === null) await files.remove(file);
  else await writeAtomic(file, entry.before);
  await files.remove(join(history, last));
  return entry.label;
}

export async function renameTake(take: Take, title: string) {
  const file = join(take.dir, META_FILE);
  const meta = JSON.parse(await files.readText(file)) as Record<string, unknown>;
  const clean = title.trim().slice(0, 120);
  meta.title = clean || null;
  await writeAtomic(file, JSON.stringify(meta, null, 2));
}

/** Copies a file into the take folder under `name` plus the source's extension; returns that file name. */
export async function importAsset(take: Take, source: string, name: string, extensions: string[]): Promise<string> {
  const extension = extname(source).toLowerCase();
  if (!extensions.includes(extension)) throw new Error(`Formato não aceito: ${extension || "sem extensão"}. Use ${extensions.join(", ")}.`);
  const stat = files.stat(source);
  if (!stat?.file) throw new Error(`Arquivo não encontrado: ${source}`);
  const target = `${name}${extension}`;
  await files.copy(source, join(take.dir, target));
  return target;
}

export const fileExists = (take: Take, name: string) => files.exists(join(take.dir, name));

/** Time ranges removed by deleting words. */
export function wordCuts(project: Project, words: Word[] | null) {
  const deleted = new Set(project.deletedWords);
  return (words ?? []).filter((word) => deleted.has(word.i)).map((word) => ({ start: word.t0, end: word.t1 }));
}

export function timeMap(project: Project, words: Word[] | null) {
  return new TimeMap(project, wordCuts(project, words));
}
