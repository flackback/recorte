/**
 * Finds the person in the webcam picture, so the renderer can blur or remove what is behind them
 * without a green screen. A worker runs MediaPipe's selfie segmenter on a small copy of each
 * frame (see matte.worker.ts), so the preview never waits for it.
 */

import type { MatteReply, MatteRequest } from "./matte.worker";

/** Width of the copy the segmenter sees (its height follows the camera); the model works at 256 × 144. */
const MATTE_WIDTH = 256;

/**
 * One frame's matte: person confidence (0–255, row by row) and, for blurring, a blurred copy of
 * the camera. The bitmap can be closed once the renderer has it.
 */
export type Matte = { mask: Uint8Array; width: number; height: number; blurred: ImageBitmap | null };

type Source = HTMLVideoElement | VideoFrame;

/**
 * Turns webcam frames into mattes, one at a time. Each preview or export has its own: the worker
 * smooths the mask a little over time, so its edge does not flicker.
 */
export class WebcamMatte {
  private worker = new Worker(new URL("./matte.worker.ts", import.meta.url), { type: "module" });
  private waiting = new Map<number, { resolve: (matte: Matte) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private loading: Promise<void>;
  /** The segmenter has loaded, so mattes come back. */
  loaded = false;
  /** A matte is being made. */
  busy = false;

  constructor() {
    this.loading = new Promise((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<MatteReply>) => {
        const reply = event.data;
        if (reply.type === "ready") {
          this.loaded = true;
          resolve();
        } else if (reply.type === "matte") {
          this.waiting.get(reply.id)?.resolve(reply);
          this.waiting.delete(reply.id);
        } else if (reply.id === null) {
          reject(new Error(reply.message));
        } else {
          this.waiting.get(reply.id)?.reject(new Error(reply.message));
          this.waiting.delete(reply.id);
        }
      };
      this.worker.onerror = (event) => {
        const error = new Error(event.message || "O recorte da webcam falhou.");
        reject(error);
        for (const pending of this.waiting.values()) pending.reject(error);
        this.waiting.clear();
      };
    });
    this.loading.catch(() => {});
    this.post({ type: "load" });
  }

  private post(request: MatteRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(request, transfer);
  }

  /** Settles once the segmenter is loaded; rejects if it cannot run here. */
  ready() {
    return this.loading;
  }

  /** The matte for `source` at `time` (ms on the camera's own clock); `blur` also makes the blurred copy. */
  async segment(source: Source, time: number, blur: boolean): Promise<Matte> {
    this.busy = true;
    try {
      await this.loading;
      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.displayWidth;
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.displayHeight;
      const picture = await createImageBitmap(source, {
        resizeWidth: MATTE_WIDTH,
        resizeHeight: Math.max(2, Math.round((MATTE_WIDTH * height) / Math.max(1, width))),
        resizeQuality: "medium",
      });
      const id = this.nextId++;
      return await new Promise<Matte>((resolve, reject) => {
        this.waiting.set(id, { resolve, reject });
        this.post({ type: "segment", id, picture, time, blur }, [picture]);
      });
    } finally {
      this.busy = false;
    }
  }

  close() {
    this.worker.terminate();
    for (const pending of this.waiting.values()) pending.reject(new Error("O recorte da webcam foi fechado."));
    this.waiting.clear();
  }
}
