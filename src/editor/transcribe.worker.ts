/// <reference lib="webworker" />
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

/**
 * Whisper large-v3-turbo, multilingual, exported with the attention outputs word timestamps need.
 * Much closer to what was said than the small models, above all in Portuguese.
 */
const MODEL = "onnx-community/whisper-large-v3-turbo_timestamped";

env.allowLocalModels = false;

let recognizer: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

/** 4-bit weights, computed in 16-bit where the graphics card can (smaller and faster). */
async function weights(): Promise<"q4" | "q4f16" | "q8"> {
  if (!("gpu" in navigator)) return "q8";
  const adapter = await navigator.gpu.requestAdapter().catch(() => null);
  return adapter?.features.has("shader-f16") ? "q4f16" : "q4";
}

/** Drops downloaded model files this app no longer uses (an older model, or the other weights). */
async function dropUnused(dtype: string) {
  try {
    const cache = await caches.open(env.cacheKey);
    for (const request of await cache.keys()) {
      const url = request.url;
      if (!url.includes("/onnx-community/whisper-")) continue;
      const ours = url.includes(`/${MODEL}/`);
      const file = url.split("/").pop() ?? "";
      const otherWeights = ours && file.endsWith(".onnx") && !file.endsWith(`_${dtype}.onnx`);
      if (!ours || otherWeights) await cache.delete(request);
    }
  } catch {
    // The files stay; nothing depends on removing them.
  }
}

function load() {
  recognizer ??= weights().then((dtype) => {
    void dropUnused(dtype);
    return pipeline("automatic-speech-recognition", MODEL, {
      device: dtype === "q8" ? "wasm" : "webgpu",
      dtype,
      progress_callback: (progress) => {
        if (progress.status === "progress_total") postMessage({ type: "download", progress: progress.progress });
      },
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
  });
  return recognizer;
}

export type Chunk = { text: string; timestamp: [number, number | null] };
/** A stretch with speech and where it starts in the take (seconds). */
export type Segment = { audio: Float32Array; offset: number };

/**
 * Word timestamps decode each token alone, so a letter split over two tokens (é, ç, ã) comes out
 * as "�". The whole text decodes right: when it has as many words, its words are used.
 */
function mendWords(chunks: Chunk[], text: string): Chunk[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const kept = chunks.filter((chunk) => chunk.text.trim());
  if (words.length !== kept.length) return kept.filter((chunk) => !chunk.text.includes("�"));
  return kept.map((chunk, index) => ({ ...chunk, text: words[index] }));
}

self.onmessage = async (event: MessageEvent<{ segments: Segment[]; language: string | null }>) => {
  try {
    const asr = await load();
    const { segments, language } = event.data;
    const all: Chunk[] = [];
    for (const [index, segment] of segments.entries()) {
      postMessage({ type: "status", message: segments.length > 1 ? `Reconhecendo a fala… ${index + 1} de ${segments.length}` : "Reconhecendo a fala…" });
      const output = await asr(segment.audio, {
        return_timestamps: "word",
        chunk_length_s: 30,
        stride_length_s: 5,
        language: language ?? undefined,
        task: "transcribe",
      });
      const result = Array.isArray(output) ? output[0] : output;
      const length = segment.audio.length / 16_000;
      for (const chunk of mendWords((result.chunks ?? []) as Chunk[], result.text)) {
        // Times past the end of the stretch are the model guessing; they are kept inside it.
        const start = Math.min(chunk.timestamp[0], length);
        const end = chunk.timestamp[1] === null ? null : Math.min(Math.max(chunk.timestamp[1], start), length);
        all.push({ text: chunk.text, timestamp: [segment.offset + start, end === null ? null : segment.offset + end] });
      }
    }
    postMessage({ type: "done", chunks: all });
  } catch (error) {
    postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
