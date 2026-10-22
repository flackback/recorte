/// <reference lib="webworker" />
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

/** Whisper base, multilingual, exported with the attention outputs word timestamps need. */
const MODEL = "onnx-community/whisper-base_timestamped";

env.allowLocalModels = false;

let recognizer: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function load() {
  const gpu = "gpu" in navigator;
  recognizer ??= pipeline("automatic-speech-recognition", MODEL, {
    device: gpu ? "webgpu" : "wasm",
    dtype: gpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
    progress_callback: (progress) => {
      if (progress.status === "progress_total") postMessage({ type: "download", progress: progress.progress });
    },
  }) as Promise<AutomaticSpeechRecognitionPipeline>;
  return recognizer;
}

self.onmessage = async (event: MessageEvent<{ audio: Float32Array; language: string | null }>) => {
  try {
    const asr = await load();
    postMessage({ type: "status", message: "Reconhecendo a fala…" });
    const output = await asr(event.data.audio, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
      language: event.data.language ?? undefined,
      task: "transcribe",
    });
    const result = Array.isArray(output) ? output[0] : output;
    postMessage({ type: "done", chunks: result.chunks ?? [] });
  } catch (error) {
    postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
