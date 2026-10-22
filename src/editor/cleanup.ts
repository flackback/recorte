import type { Word } from "../types";
import type { Span } from "./timemap";

/**
 * Automatic cleanup: silent stretches found in the audio, and filler words found in the
 * transcript. Pure functions, shared by the editor and the MCP server.
 */

/** Hesitations that are never real words. */
const FILLERS = new Set(["hã", "ãh", "ahn", "ã", "ah", "hum", "hm", "hmm", "humm", "uh", "um", "uhm", "umm", "er", "erm", "eh", "éh", "ehh", "éé", "ééé"]);
/** "é" is also the verb "is"; only a drawn-out one counts as a filler. */
const LONG_E_MS = 450;

const bare = (text: string) => text.toLowerCase().replace(/[^\p{L}]/gu, "");

/** Indices of the filler words ("hã", "hum", a long "é"…) that are not cut yet. */
export function fillerWords(words: Word[], deleted: number[] = []): number[] {
  const cut = new Set(deleted);
  return words
    .filter((word) => {
      if (cut.has(word.i)) return false;
      const text = bare(word.text);
      if (FILLERS.has(text) || /^(é|e)\1+h*$/.test(text)) return true;
      return text === "é" && (word.t1 - word.t0 >= LONG_E_MS || /\.\.\.|…/.test(word.text));
    })
    .map((word) => word.i);
}

const FRAME_MS = 20;

/**
 * Silent stretches of at least `minMs` inside `spans` (the kept parts of the take), shrunk by
 * `padMs` on the sides that touch speech so words don't sound clipped. The threshold adapts to the
 * recording: a little above its quietest parts and well below its speech.
 */
export function findSilences(samples: Float32Array, sampleRate: number, spans: Span[], minMs: number, padMs: number): Span[] {
  const size = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frames = Math.floor(samples.length / size);
  if (!frames) return [];
  const levels = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let index = frame * size; index < (frame + 1) * size; index++) sum += samples[index] * samples[index];
    levels[frame] = Math.sqrt(sum / size);
  }

  const inside = (frame: number) => spans.some((span) => frame * FRAME_MS >= span.start && frame * FRAME_MS < span.end);
  const sorted = Array.from(levels.filter((_, frame) => inside(frame))).sort((a, b) => a - b);
  if (!sorted.length) return [];
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const speech = sorted[Math.floor(sorted.length * 0.9)];
  const threshold = Math.max(floor * 2.5, speech * 0.08, 0.002);

  const result: Span[] = [];
  for (const span of spans) {
    let quietFrom: number | null = null;
    const first = Math.ceil(span.start / FRAME_MS);
    const last = Math.min(frames, Math.floor(span.end / FRAME_MS));
    const close = (endFrame: number) => {
      if (quietFrom === null) return;
      const start = Math.max(span.start, quietFrom * FRAME_MS);
      const end = Math.min(span.end, endFrame * FRAME_MS);
      if (end - start >= minMs) {
        const range = { start: start > span.start ? start + padMs : start, end: end < span.end ? end - padMs : end };
        if (range.end - range.start >= 100) result.push({ start: Math.round(range.start), end: Math.round(range.end) });
      }
      quietFrom = null;
    };
    for (let frame = first; frame < last; frame++) {
      if (levels[frame] < threshold) quietFrom ??= frame;
      else close(frame);
    }
    close(last);
  }
  return result;
}
