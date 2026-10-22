import type { CursorEvent } from "../types";
import type { ZoomSegment } from "./project";

/** Samples per second of the precomputed paths; positions between samples are interpolated. */
const RATE = 120;
const SUBSTEPS = 4;

/** Linear interpolation of the logged mouse positions. */
export class RawPath {
  private times: Float64Array;
  private xs: Float32Array;
  private ys: Float32Array;

  constructor(events: CursorEvent[]) {
    this.times = Float64Array.from(events, (event) => event.t);
    this.xs = Float32Array.from(events, (event) => event.x);
    this.ys = Float32Array.from(events, (event) => event.y);
  }

  get empty() {
    return this.times.length === 0;
  }

  at(t: number): [number, number] {
    const { times, xs, ys } = this;
    const last = times.length - 1;
    if (last < 0) return [0, 0];
    if (t <= times[0]) return [xs[0], ys[0]];
    if (t >= times[last]) return [xs[last], ys[last]];
    let low = 0;
    let high = last;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (times[middle] <= t) low = middle;
      else high = middle;
    }
    const k = (t - times[low]) / (times[high] - times[low] || 1);
    return [xs[low] + (xs[high] - xs[low]) * k, ys[low] + (ys[high] - ys[low]) * k];
  }
}

/**
 * A critically damped spring chasing the raw path, run once over the whole take so any time can
 * be looked up instantly while scrubbing. `omega` (rad/s) sets how tightly it follows.
 */
export class SpringPath {
  private xs: Float32Array;
  private ys: Float32Array;

  constructor(raw: RawPath, durationMs: number, omega: number) {
    const count = Math.max(2, Math.ceil((durationMs / 1000) * RATE) + 2);
    this.xs = new Float32Array(count);
    this.ys = new Float32Array(count);
    let [x, y] = raw.at(0);
    let vx = 0;
    let vy = 0;
    const dt = 1 / RATE / SUBSTEPS;
    for (let i = 0; i < count; i++) {
      this.xs[i] = x;
      this.ys[i] = y;
      for (let step = 1; step <= SUBSTEPS; step++) {
        const [tx, ty] = raw.at(((i + step / SUBSTEPS) / RATE) * 1000);
        vx += (omega * omega * (tx - x) - 2 * omega * vx) * dt;
        vy += (omega * omega * (ty - y) - 2 * omega * vy) * dt;
        x += vx * dt;
        y += vy * dt;
      }
    }
  }

  at(t: number): [number, number] {
    const position = Math.max(0, (t / 1000) * RATE);
    const index = Math.min(Math.floor(position), this.xs.length - 2);
    const k = Math.min(1, position - index);
    return [
      this.xs[index] + (this.xs[index + 1] - this.xs[index]) * k,
      this.ys[index] + (this.ys[index + 1] - this.ys[index]) * k,
    ];
  }
}

/** Maps the smoothing slider (0–1) to spring stiffness; 0 returns the raw path untouched. */
export function cursorPath(raw: RawPath, durationMs: number, smoothing: number): { at(t: number): [number, number] } {
  if (smoothing <= 0.001) return raw;
  const omega = 70 * Math.pow(10 / 70, smoothing);
  return new SpringPath(raw, durationMs, omega);
}

/** The camera drifts after the cursor much more lazily than the cursor itself. */
export const cameraPath = (raw: RawPath, durationMs: number) => new SpringPath(raw, durationMs, 3.2);

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** Zoom level at `t`: 1 outside every segment, easing in and out at the segment edges. */
export function zoomAt(segments: ZoomSegment[], t: number): number {
  let level = 1;
  for (const segment of segments) {
    if (t <= segment.start || t >= segment.end) continue;
    const ramp = Math.min(700, (segment.end - segment.start) / 2);
    const progress = Math.min(1, (t - segment.start) / ramp, (segment.end - t) / ramp);
    level = Math.max(level, 1 + (segment.scale - 1) * easeInOut(progress));
  }
  return level;
}
