import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import { joinPath, type Take, type Word } from "../types";
import { openAudio, readMono } from "./audio-source";

export const SAMPLE_RATE = 16_000;
const TRANSCRIPT_FILE = "transcript.json";

/**
 * Speech as 16 kHz mono: the microphone if there is one, otherwise the system sound. Read a
 * minute at a time, so long recordings don't have to fit in memory as a whole file.
 */
export async function speech(take: Take): Promise<Float32Array> {
  const file = take.mic ?? take.systemFile ?? (take.systemAudio ? take.video : null);
  if (!file) throw new Error("Esta gravação não tem áudio.");
  const audio = await openAudio(convertFileSrc(joinPath(take.dir, file)));
  if (!audio) throw new Error("Esta gravação não tem áudio.");
  return readMono(audio, SAMPLE_RATE, take.durationMs);
}

async function save(dir: string, words: Word[]) {
  const created = await invoke<{ id: number }>("asset_create", { dir, name: TRANSCRIPT_FILE });
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, words }));
  await invoke("export_write", bytes, { headers: { "x-export-id": String(created.id), "x-position": "0" } });
  await invoke("export_finish", { id: created.id });
}

/** Languages offered for transcription. Whisper needs one: without it, it assumes English. */
export const LANGUAGES: [code: string, name: string][] = [
  ["pt", "Português"],
  ["en", "Inglês"],
  ["es", "Espanhol"],
  ["fr", "Francês"],
  ["de", "Alemão"],
  ["it", "Italiano"],
];

const LANGUAGE_KEY = "recorte.language";

/** The language picked last, or the system's. */
export function preferredLanguage(): string {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LANGUAGE_KEY);
  } catch {
    // Storage blocked: use the system language.
  }
  const code = saved ?? navigator.language.slice(0, 2).toLowerCase();
  return LANGUAGES.some(([candidate]) => candidate === code) ? code : "en";
}

export function rememberLanguage(code: string) {
  try {
    localStorage.setItem(LANGUAGE_KEY, code);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

let worker: Worker | null = null;

/**
 * Transcribes the take with Whisper running in a worker (WebGPU when available). The model is
 * downloaded from Hugging Face the first time and cached afterwards.
 */
export async function transcribe(take: Take, onStatus: (message: string) => void, language = preferredLanguage()): Promise<Word[]> {
  onStatus("Preparando o áudio…");
  const audio = await speech(take);
  worker ??= new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
  const active = worker;

  const chunks = await new Promise<{ text: string; timestamp: [number, number | null] }[]>((resolve, reject) => {
    active.onmessage = (event) => {
      const message = event.data;
      if (message.type === "download") onStatus(`Baixando o modelo de fala… ${Math.round(message.progress)}%`);
      else if (message.type === "status") onStatus(message.message);
      else if (message.type === "done") resolve(message.chunks);
      else if (message.type === "error") reject(new Error(message.message));
    };
    active.onerror = (event) => reject(new Error(event.message || "falha no reconhecimento"));
    onStatus("Carregando o modelo de fala…");
    active.postMessage({ audio, language }, [audio.buffer]);
  });

  const words: Word[] = chunks
    .filter((chunk) => chunk.text.trim())
    .map((chunk, i) => {
      const t0 = chunk.timestamp[0] * 1000;
      const t1 = (chunk.timestamp[1] ?? chunk.timestamp[0] + 0.3) * 1000;
      return { i, t0: Math.round(t0), t1: Math.round(Math.max(t1, t0 + 60)), text: chunk.text.trim() };
    });
  await save(take.dir, words);
  return words;
}
