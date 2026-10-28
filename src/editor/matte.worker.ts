/**
 * Finds the person in webcam pictures with MediaPipe's selfie segmenter, off the main thread:
 * reading the mask back from the GPU waits for the whole inference. The runtime and the model
 * ship with the app, so this works offline.
 */

import { ImageSegmenter } from "@mediapipe/tasks-vision";
// A module worker loads the ES module build of the runtime.
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_module_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url";
import modelPath from "./models/selfie_segmenter_landscape.tflite?url";

/** Blur of the background, in pixels of the small picture (about 2.5% of its width). */
const BLUR_RADIUS = 6;
/** A jump of more than this (ms) between pictures starts the smoothing over, as after a seek. */
const SMOOTH_RESET = 250;

export type MatteRequest = { type: "load" } | { type: "segment"; id: number; picture: ImageBitmap; time: number; blur: boolean };
export type MatteReply =
  | { type: "ready" }
  | { type: "matte"; id: number; mask: Uint8Array; width: number; height: number; blurred: ImageBitmap | null }
  | { type: "error"; id: number | null; message: string };

let segmenter: Promise<ImageSegmenter> | null = null;

/** The segmenter, created once: the GPU delegate, or the CPU where WebGL fails. */
function load(): Promise<ImageSegmenter> {
  segmenter ??= (async () => {
    const create = (delegate: "GPU" | "CPU") =>
      ImageSegmenter.createFromOptions(
        { wasmLoaderPath, wasmBinaryPath },
        { baseOptions: { modelAssetPath: modelPath, delegate }, runningMode: "IMAGE", outputConfidenceMasks: true, outputCategoryMask: false },
      );
    try {
      return await create("GPU");
    } catch {
      return await create("CPU");
    }
  })();
  return segmenter;
}

let smooth = new Float32Array(0);
let last = -Infinity;
let blurCanvas: OffscreenCanvas | null = null;

function segment(model: ImageSegmenter, picture: ImageBitmap, time: number, blur: boolean): Extract<MatteReply, { type: "matte" }> | null {
  const { width, height } = picture;
  let values: Float32Array | null = null;
  model.segment(picture, (result) => {
    const mask = result.confidenceMasks?.[0];
    if (mask && mask.width === width && mask.height === height) values = mask.getAsFloat32Array();
  });
  const confidence = values as Float32Array | null;
  if (!confidence) return null;

  // Follow large changes (movement) at once, and average out small ones (flicker).
  const count = width * height;
  const restart = smooth.length !== count || Math.abs(time - last) > SMOOTH_RESET;
  if (smooth.length !== count) smooth = new Float32Array(count);
  last = time;
  const mask = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const value = confidence[i];
    const previous = smooth[i];
    const next = restart ? value : previous + (value - previous) * Math.min(1, 0.45 + Math.abs(value - previous) * 1.5);
    smooth[i] = next;
    mask[i] = next * 255;
  }

  let blurred: ImageBitmap | null = null;
  if (blur) {
    if (!blurCanvas || blurCanvas.width !== width || blurCanvas.height !== height) blurCanvas = new OffscreenCanvas(width, height);
    const context = blurCanvas.getContext("2d")!;
    // The sharp picture underneath keeps the edges opaque where the blur runs out of picture.
    context.filter = "none";
    context.drawImage(picture, 0, 0);
    context.filter = `blur(${BLUR_RADIUS}px)`;
    context.drawImage(picture, 0, 0);
    blurred = blurCanvas.transferToImageBitmap();
  }
  return { type: "matte", id: 0, mask, width, height, blurred };
}

const reply = (message: MatteReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = async (event: MessageEvent<MatteRequest>) => {
  const request = event.data;
  try {
    const model = await load();
    if (request.type === "load") {
      reply({ type: "ready" });
      return;
    }
    const matte = segment(model, request.picture, request.time, request.blur);
    request.picture.close();
    if (!matte) throw new Error("O segmentador não devolveu máscara.");
    matte.id = request.id;
    reply(matte, matte.blurred ? [matte.mask.buffer, matte.blurred] : [matte.mask.buffer]);
  } catch (error) {
    if (request.type === "segment") request.picture.close();
    reply({ type: "error", id: request.type === "segment" ? request.id : null, message: error instanceof Error ? error.message : String(error) });
  }
};
