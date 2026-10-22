/** A recording as described by its `take.json`. */
export type Take = {
  id: string;
  createdAt: string;
  sourceKind: "monitor" | "window";
  sourceName: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frames: number;
  video: string;
  systemAudio: boolean;
  mic: string | null;
  cursor: string;
  cursorInVideo: boolean;
  /** `keys.json`, when keystrokes were recorded. */
  keys?: string | null;
  /** `webcam.mp4`, when the camera was recorded. */
  webcam?: string | null;
  /** Stretches paused during recording, in ms; they open in the editor already cut. */
  pauses?: { start: number; end: number }[];
  /** Moments marked while recording (Alt+Shift+M), in ms. */
  markers?: number[];
  /** Area picked before recording, in video pixels. */
  crop?: { x: number; y: number; width: number; height: number } | null;
  /** Name the user gave the take. */
  title?: string | null;
  /** First-seconds frame of the recording, for the list. */
  thumbnail?: string | null;
  /** Where the webcam recording starts on the take's timeline, in ms. */
  webcamOffsetMs?: number;
  warnings: string[];
  dir: string;
};

/**
 * One entry of `cursor.json`: `t` in ms from the first frame, `x`/`y` in video pixels. `s` events
 * mark a change of cursor shape (`c`).
 */
export type CursorEvent = {
  t: number;
  k: "m" | "d" | "u" | "w" | "s";
  b?: "l" | "r" | "m";
  x: number;
  y: number;
  w?: number;
  c?: "arrow" | "hand" | "text" | "other";
};

/** One key press from `keys.json`; `n` is the key's display name. */
export type KeyEvent = { t: number; n: string; m: string[] };

/** A recognized word from `transcript.json`, times in ms on the take's timeline. */
export type Word = { i: number; t0: number; t1: number; text: string };

export const joinPath = (dir: string, file: string) => `${dir}\\${file}`;
