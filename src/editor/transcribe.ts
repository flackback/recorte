import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import { joinPath, type Take, type Word } from "../types";
import { openAudio, readMono } from "./audio-source";
import type { Chunk, Segment } from "./transcribe.worker";

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

/** Loudness is judged over frames this long (samples at 16 kHz: 30 ms). */
const FRAME = 480;
/** Speech is at least this much louder than the quietest part of the take… */
const ABOVE_ROOM_DB = 10;
/** …and never quieter than this (dBFS), so typing and breathing in a silent room are not speech… */
const QUIETEST_DB = -45;
/** …nor this far under the voice's loud parts, where only noise and far-off voices are. */
const UNDER_VOICE_DB = 15;
/** Pauses shorter than this stay inside one stretch of speech (ms). */
const BRIDGE_MS = 600;
/** Louder bursts shorter than this are clicks and taps, not words (ms). */
const SHORTEST_MS = 250;
/** Each stretch keeps this much around it, so first and last syllables are whole (ms). */
const PAD_MS = 300;
/** Stretches closer than this are heard together, up to the longest piece (ms). */
const JOIN_MS = 2000;
const LONGEST_MS = 25_000;
/** Quiet speech is raised to this peak, at most by GAIN_LIMIT. */
const PEAK = 0.9;
const GAIN_LIMIT = 20;

/**
 * The stretches of the take with speech, each raised to a clear level. Whisper only hears these:
 * fed seconds of silence, it makes up phrases ("O que é isso?") and repeats them.
 */
export function speechSegments(audio: Float32Array): Segment[] {
  const frames = Math.floor(audio.length / FRAME);
  if (!frames) return [];
  const levels = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += audio[i] * audio[i];
    levels[f] = 10 * Math.log10(sum / FRAME + 1e-12);
  }
  // The room's level is the quietest tenth of the take; the voice's, its loudest fiftieth.
  const sorted = [...levels].sort((a, b) => a - b);
  const room = sorted[Math.floor(frames * 0.1)];
  const voice = sorted[Math.floor(frames * 0.98)];
  const threshold = Math.max(room + ABOVE_ROOM_DB, QUIETEST_DB, voice - UNDER_VOICE_DB);
  const ms = (frame: number) => (frame * FRAME * 1000) / SAMPLE_RATE;
  const frameOf = (time: number) => Math.round((time * SAMPLE_RATE) / 1000 / FRAME);

  // Loud frames, with short pauses bridged and short bursts dropped.
  const spans: [number, number][] = [];
  for (let f = 0; f < frames; f++) {
    if (levels[f] < threshold) continue;
    const last = spans[spans.length - 1];
    if (last && ms(f - last[1]) <= BRIDGE_MS) last[1] = f + 1;
    else spans.push([f, f + 1]);
  }
  const voiced = spans.filter(([start, end]) => ms(end - start) >= SHORTEST_MS);

  // Padded, then joined into pieces Whisper hears at once.
  const pad = frameOf(PAD_MS);
  const pieces: [number, number][] = [];
  for (const [start, end] of voiced) {
    const from = Math.max(0, start - pad);
    const to = Math.min(frames, end + pad);
    const last = pieces[pieces.length - 1];
    if (last && ms(from - last[1]) <= JOIN_MS && ms(to - last[0]) <= LONGEST_MS) last[1] = Math.max(last[1], to);
    else pieces.push([from, to]);
  }

  return pieces.map(([from, to]) => {
    const piece = audio.slice(from * FRAME, to * FRAME);
    let peak = 0;
    for (const sample of piece) peak = Math.max(peak, Math.abs(sample));
    const gain = peak > 0 ? Math.min(GAIN_LIMIT, PEAK / peak) : 1;
    if (gain > 1) for (let i = 0; i < piece.length; i++) piece[i] *= gain;
    return { audio: piece, offset: (from * FRAME) / SAMPLE_RATE };
  });
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
  const segments = speechSegments(await speech(take));
  if (!segments.length) {
    await save(take.dir, []);
    return [];
  }
  worker ??= new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
  const active = worker;

  const chunks = await new Promise<Chunk[]>((resolve, reject) => {
    active.onmessage = (event) => {
      const message = event.data;
      if (message.type === "download") onStatus(`Baixando o modelo de fala… ${Math.round(message.progress)}%`);
      else if (message.type === "status") onStatus(message.message);
      else if (message.type === "done") resolve(message.chunks);
      else if (message.type === "error") reject(new Error(message.message));
    };
    active.onerror = (event) => reject(new Error(event.message || "falha no reconhecimento"));
    onStatus("Carregando o modelo de fala…");
    active.postMessage({ segments, language }, segments.map((segment) => segment.audio.buffer));
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
