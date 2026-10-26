import type { MediaKey, Range } from "./project";
import type { Span } from "./timemap";

export type TrackKey = "cuts" | "speed" | "zoom" | "notes" | "blurs" | "camera";
/** The cuts drawn on a media lane, selectable and editable like a track's items. */
export type LaneCutKey = `${MediaKey}Cuts`;
/** Anything with items that can be selected: an edit track or a lane's own cuts. */
export type ItemKey = TrackKey | LaneCutKey;
export type Selection = { track: ItemKey; id: string } | null;

export const laneCutKey = (key: MediaKey): LaneCutKey => `${key}Cuts`;
/** The media lane whose cuts `key` names, or null for an edit track. */
export const laneOfCut = (key: ItemKey): MediaKey | null =>
  key === "webcamCuts" ? "webcam" : key === "systemCuts" ? "system" : key === "micCuts" ? "mic" : null;

export type Track = {
  key: TrackKey;
  label: string;
  color: string;
  items: Range[];
  /** Text drawn inside an item, if it fits. */
  text?: (item: Range) => string;
  /** Per-item color override. */
  tint?: (item: Range) => string;
};

export type TimelineState = {
  duration: number;
  time: number;
  trim: { start: number; end: number };
  tracks: Track[];
  /** Removed by deleted transcript words; drawn like cuts on the clip. */
  wordCuts: Span[];
  clicks: number[];
  /** Moments marked while recording; clicking near one on the ruler jumps to it. */
  markers: number[];
  selected: Selection;
  thumbnails: { t: number; image: ImageBitmap }[];
  /** Peak level per bucket over the whole take, 0–1. */
  waveform: Float32Array | null;
  /** A stretch selected by dragging over the clip. */
  range: Span | null;
  /** Read-only rows under the clip: webcam frames and one waveform per audio source. */
  lanes?: MediaLane[];
};

export type MediaLane = {
  label: string;
  kind: "frames" | "wave";
  color?: string;
  /** Frames on the lane's own clock, sorted by time. */
  frames?: { t: number; image: ImageBitmap }[];
  /** Where the lane's clock starts on the take's timeline, in ms. */
  offset?: number;
  /** The part of the lane's clock that has video, in ms; the rest of the lane stays empty. */
  span?: { start: number; end: number };
  /** Peak level per bucket over the whole take, 0–1. */
  wave?: Float32Array | null;
  /** The source plays silent: drawn faded, with a hint. */
  muted?: boolean;
  /** Set on lanes that can be moved and cut on their own. */
  key?: MediaKey;
  /** How far the lane is moved, in ms (positive plays later); its content is drawn moved. */
  shift?: number;
  /** Stretches of the take where only this lane is removed. */
  cuts?: Range[];
  /** The lane can be cut but not moved (its sound plays from the screen's own file). */
  fixed?: boolean;
};

export type TimelineEvents = {
  seek(time: number): void;
  trim(trim: { start: number; end: number }): void;
  change(track: TrackKey, items: Range[]): void;
  select(selection: Selection): void;
  /** A stretch was selected by dragging over the clip (null clears it). */
  range(range: Span | null): void;
  add(track: TrackKey, time: number): void;
  /** A media lane was dragged to `shift` ms; `done` once the drag ends. */
  shiftLane(key: MediaKey, shift: number, done: boolean): void;
  /** A lane's own cuts were moved or resized. */
  laneCuts(key: MediaKey, cuts: Range[]): void;
  /** A drag finished; a good moment to save. */
  commit(): void;
};

/** "+0,25 s" or "−1,10 s": how far a lane is moved. */
export function shiftLabel(shift: number) {
  return `${shift < 0 ? "−" : "+"}${(Math.abs(shift) / 1000).toFixed(2).replace(".", ",")} s`;
}

const LEFT = 88;
const RIGHT = 16;
const RULER = 22;
const CLIP = { top: 28, height: 44 };
const TRACK_TOP = 80;
const TRACK_HEIGHT = 26;
/** Media lanes sit between the clip and the edit tracks; a frames lane is a little taller. */
const FRAMES_HEIGHT = 30;
/** Height of each extra row when items on a track overlap in time (text with an arrow, say). */
const LANE_HEIGHT = 18;
const MAX_LANES = 4;
const TRACK_GAP = 6;
const HANDLE = 9;
const EDGE = 7;
const MIN_TRIM = 500;
const MIN_ITEM = 200;
/** A lane moves only once the pointer travels this far (px); less is a click that seeks. */
const LANE_DRAG = 4;
/** A moved lane snaps back to its original sync within this (ms). */
const SNAP_ZERO = 80;
/** The grabbed point of a lane snaps to the playhead within this (px). */
const SNAP_PLAYHEAD = 6;

type Drag =
  | { kind: "seek" }
  | { kind: "range"; anchor: number; x0: number; moved: boolean }
  | { kind: "trim"; side: "start" | "end" }
  | { kind: "move"; track: ItemKey; id: string; offset: number; length: number }
  | { kind: "edge"; track: ItemKey; id: string; side: "start" | "end" }
  /** Moving a media lane in time: `time0` is the take time grabbed, `x` the pointer now. */
  | { kind: "lane"; key: MediaKey; x0: number; x: number; time0: number; shift0: number; shift: number; moved: boolean };

/** Reads theme colors; one style lookup serves every color of a draw. */
const palette = () => {
  const style = getComputedStyle(document.documentElement);
  return (name: string) => style.getPropertyValue(name).trim();
};

/** The thumbnail closest in time to `t` (sorted by time; the earlier one on a tie). */
function nearestThumb(thumbs: TimelineState["thumbnails"], t: number) {
  let low = 0;
  let high = thumbs.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (thumbs[middle].t < t) low = middle + 1;
    else high = middle;
  }
  const after = thumbs[low];
  const before = thumbs[low - 1];
  if (!after) return before;
  if (!before) return after;
  return Math.abs(after.t - t) < Math.abs(before.t - t) ? after : before;
}

/** Rows inside a track, so items that overlap in time sit one above the other. */
function laneLayout(items: Range[]) {
  const ends: number[] = [];
  const lane = new Map<string, number>();
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    let row = ends.findIndex((end) => end <= item.start);
    if (row < 0) row = ends.length < MAX_LANES ? ends.push(item.end) - 1 : ends.indexOf(Math.min(...ends));
    ends[row] = Math.max(ends[row], item.end);
    lane.set(item.id, row);
  }
  return { lane, count: Math.max(1, ends.length) };
}

function formatRuler(ms: number) {
  const seconds = ms / 1000;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(rest % 1 ? 1 : 0).padStart(rest % 1 ? 4 : 2, "0")}`;
}

function withAlpha(hex: string, alpha: number) {
  const value = hex.startsWith("#") ? hex.slice(1) : "";
  if (value.length !== 6) return hex;
  const n = parseInt(value, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** A removed stretch: dimmed, with diagonal hatching. */
function hatch(context: CanvasRenderingContext2D, x0: number, x1: number, top: number, height: number, color: string) {
  context.fillStyle = "rgba(0, 0, 0, 0.6)";
  context.fillRect(x0, top, x1 - x0, height);
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.beginPath();
  for (let x = x0 - height; x < x1; x += 8) {
    context.moveTo(Math.max(x, x0), top + height - Math.max(0, x0 - x));
    context.lineTo(Math.min(x + height, x1), top + Math.max(0, x + height - x1));
  }
  context.stroke();
  context.lineWidth = 1;
}

/** The timeline below the preview: ruler, clip with thumbnails and waveform, and edit tracks. */
export class Timeline {
  private state: TimelineState | null = null;
  private drag: Drag | null = null;
  /** Visible part of the take, in ms; zoomed with Ctrl + wheel. */
  private view = { start: 0, end: 0 };
  /** Rows per track, recomputed with each state. */
  private lanes: ReturnType<typeof laneLayout>[] = [];
  /** Media lanes of the current state. */
  private media: MediaLane[] = [];
  /**
   * Everything but the playhead, drawn when the state, view or size changes; while playing, each
   * frame copies it and adds the playhead.
   */
  private layer = document.createElement("canvas");
  private layerDirty = true;
  /** CSS size and pixel ratio of the last full draw. */
  private size = { width: 0, height: 0, ratio: 0 };
  private resize = new ResizeObserver(() => {
    this.layerDirty = true;
    this.draw();
  });

  constructor(private canvas: HTMLCanvasElement, private events: TimelineEvents) {
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
    canvas.addEventListener("dblclick", (event) => this.doubleClick(event));
    canvas.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    this.resize.observe(canvas);
    // Colors come from the theme, which follows the system's light or dark mode.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.layerDirty = true;
      this.draw();
    });
  }

  set(state: TimelineState) {
    if (!this.state || this.state.duration !== state.duration) this.view = { start: 0, end: state.duration };
    this.lanes = state.tracks.map((track) => laneLayout(track.items));
    this.media = state.lanes ?? [];
    // Grows with the tracks and their rows, so nothing is cut off.
    const height = `${this.trackTop(state.tracks.length) + 2}px`;
    if (this.canvas.style.height !== height) this.canvas.style.height = height;
    this.state = state;
    this.followPlayhead();
    this.layerDirty = true;
    this.draw();
  }

  /** Moves the playhead; the rest is redrawn only if the view had to scroll to follow it. */
  setTime(time: number) {
    const state = this.state;
    if (!state || state.time === time) return;
    state.time = time;
    const { start, end } = this.view;
    this.followPlayhead();
    if (this.view.start !== start || this.view.end !== end) this.layerDirty = true;
    this.draw();
  }

  private get width() {
    return this.layerDirty || !this.size.width ? this.canvas.clientWidth : this.size.width;
  }

  private get span() {
    return Math.max(1, this.view.end - this.view.start);
  }

  private toX(t: number) {
    return LEFT + ((t - this.view.start) / this.span) * (this.width - LEFT - RIGHT);
  }

  private toTime(x: number) {
    const duration = this.state?.duration || 1;
    return Math.min(duration, Math.max(0, this.rawTime(x)));
  }

  /** Like `toTime`, without keeping the result inside the take. */
  private rawTime(x: number) {
    return this.view.start + ((x - LEFT) / (this.width - LEFT - RIGHT)) * this.span;
  }

  private trackHeight(index: number) {
    const count = this.lanes[index]?.count ?? 1;
    return count > 1 ? 4 + count * LANE_HEIGHT : TRACK_HEIGHT;
  }

  private trackTop(index: number) {
    let top = this.mediaTop(this.media.length);
    for (let i = 0; i < index; i++) top += this.trackHeight(i) + TRACK_GAP;
    return top;
  }

  private mediaHeight(index: number) {
    return this.media[index]?.kind === "frames" ? FRAMES_HEIGHT : TRACK_HEIGHT;
  }

  private mediaTop(index: number) {
    let top = TRACK_TOP;
    for (let i = 0; i < index; i++) top += this.mediaHeight(i) + TRACK_GAP;
    return top;
  }

  /** The media lane under a height, if any. */
  private mediaAt(y: number) {
    return this.media.findIndex((_, i) => y >= this.mediaTop(i) && y <= this.mediaTop(i) + this.mediaHeight(i));
  }

  /** The track under a height, if any. */
  private trackAt(y: number) {
    return this.state?.tracks.findIndex((_, i) => y >= this.trackTop(i) && y <= this.trackTop(i) + this.trackHeight(i)) ?? -1;
  }

  /** Top and height of an item's bar, in its row. */
  private itemBox(index: number, item: Range) {
    const layout = this.lanes[index];
    const top = this.trackTop(index);
    if (!layout || layout.count === 1) return { top: top + 2, height: TRACK_HEIGHT - 4 };
    return { top: top + 2 + (layout.lane.get(item.id) ?? 0) * LANE_HEIGHT, height: LANE_HEIGHT - 2 };
  }

  /** Keeps the playhead visible while playing a zoomed-in timeline. */
  private followPlayhead() {
    const state = this.state;
    if (!state || this.drag || this.span >= state.duration) return;
    if (state.time < this.view.start || state.time > this.view.end) {
      const span = this.span;
      const start = Math.min(Math.max(0, state.time - span * 0.1), state.duration - span);
      this.view = { start, end: start + span };
    }
  }

  private wheel(event: WheelEvent) {
    const state = this.state;
    if (!state) return;
    event.preventDefault();
    const duration = state.duration;
    if (event.ctrlKey) {
      const anchor = this.toTime(event.offsetX);
      const factor = Math.exp(event.deltaY * 0.0015);
      const span = Math.min(duration, Math.max(1000, this.span * factor));
      const ratio = (anchor - this.view.start) / this.span;
      const start = Math.min(Math.max(0, anchor - ratio * span), duration - span);
      this.view = { start, end: start + span };
    } else {
      const shift = ((event.deltaX || event.deltaY) / (this.width - LEFT - RIGHT)) * this.span;
      const start = Math.min(Math.max(0, this.view.start + shift), duration - this.span);
      this.view = { start, end: start + this.span };
    }
    this.layerDirty = true;
    this.draw();
  }

  /** What a right-click at a point refers to, for the context menu. */
  contextAt(x: number, y: number):
    | { kind: "range"; time: number }
    | { kind: "item"; track: TrackKey; id: string; time: number }
    | { kind: "track"; track: TrackKey; time: number }
    | { kind: "lane"; key: MediaKey; time: number; cut?: string }
    | { kind: "clip"; time: number }
    | null {
    const state = this.state;
    if (!state || x < LEFT - HANDLE) return null;
    const time = this.toTime(x);
    if (state.range && time >= state.range.start && time <= state.range.end && y >= CLIP.top && y <= CLIP.top + CLIP.height) return { kind: "range", time };
    const hit = this.hit(x, y);
    if (hit && (hit.kind === "move" || hit.kind === "edge")) {
      const lane = laneOfCut(hit.track);
      if (lane) return { kind: "lane", key: lane, time, cut: hit.id };
      return { kind: "item", track: hit.track as TrackKey, id: hit.id, time };
    }
    const key = this.media[this.mediaAt(y)]?.key;
    if (key) return { kind: "lane", key, time };
    const index = this.trackAt(y);
    if (index >= 0) return { kind: "track", track: state.tracks[index].key, time };
    return { kind: "clip", time };
  }

  private hit(x: number, y: number): Drag | null {
    const state = this.state;
    if (!state) return null;
    if (y >= CLIP.top && y <= CLIP.top + CLIP.height) {
      if (Math.abs(x - this.toX(state.trim.start)) <= HANDLE) return { kind: "trim", side: "start" };
      if (Math.abs(x - this.toX(state.trim.end)) <= HANDLE) return { kind: "trim", side: "end" };
      // Click to go there; drag to select a stretch.
      return { kind: "range", anchor: this.toTime(x), x0: x, moved: false };
    }
    const laneIndex = this.mediaAt(y);
    if (laneIndex >= 0) {
      const lane = this.media[laneIndex];
      // A lane without a key can't be edited: clicking it goes there, like the ruler.
      if (!lane.key) return { kind: "seek" };
      // Its own cuts come first; the rest of the lane moves it in time (a click still seeks).
      const cut = this.itemHit(laneCutKey(lane.key), lane.cuts ?? [], x);
      if (cut) return cut;
      if (lane.fixed) return { kind: "seek" };
      const shift = lane.shift ?? 0;
      return { kind: "lane", key: lane.key, x0: x, x, time0: this.rawTime(x), shift0: shift, shift, moved: false };
    }
    const index = this.trackAt(y);
    if (index >= 0) {
      const track = state.tracks[index];
      // Only the row under the pointer.
      return this.itemHit(track.key, track.items.filter((item) => {
        const box = this.itemBox(index, item);
        return y >= box.top - 2 && y <= box.top + box.height + 2;
      }), x);
    }
    return y < CLIP.top ? { kind: "seek" } : null;
  }

  /** The item edge or body under `x` among `items`, the selected one first so overlaps stay reachable. */
  private itemHit(track: ItemKey, items: Range[], x: number): Drag | null {
    const selected = this.state?.selected;
    const selectedId = selected?.track === track ? selected.id : null;
    const ordered = [...items].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId));
    for (const item of ordered) {
      const start = this.toX(item.start);
      const end = this.toX(item.end);
      if (x < start - EDGE || x > end + EDGE) continue;
      // A split has no length to resize: its handle only moves.
      if (item.end <= item.start) return { kind: "move", track, id: item.id, offset: this.toTime(x) - item.start, length: 0 };
      if (Math.abs(x - start) <= EDGE) return { kind: "edge", track, id: item.id, side: "start" };
      if (Math.abs(x - end) <= EDGE) return { kind: "edge", track, id: item.id, side: "end" };
      if (x >= start && x <= end) return { kind: "move", track, id: item.id, offset: this.toTime(x) - item.start, length: item.end - item.start };
    }
    return null;
  }

  private pointerDown(event: PointerEvent) {
    if (!this.state || event.button !== 0 || event.offsetX < LEFT - HANDLE) return;
    const drag = this.hit(event.offsetX, event.offsetY);
    if (!drag) {
      this.events.select(null);
      return;
    }
    this.drag = drag;
    this.canvas.setPointerCapture(event.pointerId);
    if (drag.kind === "range" && this.state.range) this.events.range(null);
    if (drag.kind === "move" || drag.kind === "edge") this.events.select({ track: drag.track, id: drag.id });
    this.apply(event.offsetX);
  }

  private pointerMove(event: PointerEvent) {
    if (this.drag) {
      this.apply(event.offsetX);
      return;
    }
    const hit = this.hit(event.offsetX, event.offsetY);
    this.canvas.style.cursor =
      hit?.kind === "trim" || hit?.kind === "edge" ? "ew-resize" : hit?.kind === "move" || hit?.kind === "lane" ? "grab" : hit?.kind === "range" ? "text" : hit ? "pointer" : "default";
  }

  private pointerUp(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (drag.kind === "lane" && this.state) {
      // The badge goes with the drag.
      this.layerDirty = true;
      if (drag.moved) this.events.shiftLane(drag.key, drag.shift, true);
      else this.events.seek(Math.min(this.state.trim.end, Math.max(this.state.trim.start, this.toTime(drag.x0))));
      this.draw();
    }
    this.events.commit();
  }

  private apply(x: number) {
    const state = this.state;
    const drag = this.drag;
    if (!state || !drag) return;
    const t = this.toTime(x);

    if (drag.kind === "seek") {
      const marker = state.markers.find((m) => Math.abs(this.toX(m) - x) <= 6);
      this.events.seek(Math.min(state.trim.end, Math.max(state.trim.start, marker ?? t)));
    } else if (drag.kind === "range") {
      if (!drag.moved && Math.abs(x - drag.x0) < 5) {
        this.events.seek(Math.min(state.trim.end, Math.max(state.trim.start, t)));
        return;
      }
      drag.moved = true;
      const start = Math.max(state.trim.start, Math.min(drag.anchor, t));
      const end = Math.min(state.trim.end, Math.max(drag.anchor, t));
      if (end - start > 50) this.events.range({ start, end });
    } else if (drag.kind === "trim") {
      const trim = { ...state.trim };
      if (drag.side === "start") trim.start = Math.max(0, Math.min(t, trim.end - MIN_TRIM));
      else trim.end = Math.min(state.duration, Math.max(t, trim.start + MIN_TRIM));
      this.events.trim(trim);
      this.events.seek(drag.side === "start" ? trim.start : trim.end);
    } else if (drag.kind === "lane") {
      drag.x = x;
      if (!drag.moved && Math.abs(x - drag.x0) < LANE_DRAG) return;
      drag.moved = true;
      // The grabbed moment follows the pointer; it lands on the playhead when close to it.
      const at = Math.abs(x - this.toX(state.time)) <= SNAP_PLAYHEAD ? state.time : this.rawTime(x);
      let shift = drag.shift0 + at - drag.time0;
      if (Math.abs(shift) <= SNAP_ZERO) shift = 0;
      shift = Math.round(Math.max(-state.duration, Math.min(state.duration, shift)));
      if (shift === drag.shift) {
        // Nothing moved, but the badge follows the pointer.
        this.layerDirty = true;
        this.draw();
        return;
      }
      drag.shift = shift;
      this.events.shiftLane(drag.key, shift, false);
    } else {
      const lane = laneOfCut(drag.track);
      const current = lane ? this.media.find((candidate) => candidate.key === lane)?.cuts : state.tracks.find((candidate) => candidate.key === drag.track)?.items;
      if (!current) return;
      const items = current.map((item) => {
        if (item.id !== drag.id) return item;
        if (drag.kind === "move") {
          const start = Math.min(Math.max(0, t - drag.offset), state.duration - drag.length);
          return { ...item, start, end: start + drag.length };
        }
        if (drag.side === "start") return { ...item, start: Math.max(0, Math.min(t, item.end - MIN_ITEM)) };
        return { ...item, end: Math.min(state.duration, Math.max(t, item.start + MIN_ITEM)) };
      });
      if (lane) this.events.laneCuts(lane, items);
      else this.events.change(drag.track as TrackKey, items);
      if (drag.kind === "edge") this.events.seek(drag.side === "start" ? items.find((i) => i.id === drag.id)!.start : items.find((i) => i.id === drag.id)!.end);
    }
  }

  private doubleClick(event: MouseEvent) {
    const state = this.state;
    if (!state) return;
    const index = this.trackAt(event.offsetY);
    if (index < 0 || this.hit(event.offsetX, event.offsetY)) return;
    this.events.add(state.tracks[index].key, this.toTime(event.offsetX));
  }

  draw() {
    const ratio = window.devicePixelRatio || 1;
    if (this.layerDirty || this.size.ratio !== ratio) this.drawLayer(ratio);
    const canvas = this.canvas;
    const context = canvas.getContext("2d")!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (this.layer.width && this.layer.height) context.drawImage(this.layer, 0, 0);
    const state = this.state;
    if (!state || !state.duration) return;

    // Playhead, clipped like the rest past the gutter.
    const { width, height } = this.size;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.save();
    context.beginPath();
    context.rect(LEFT - 2, 0, width - LEFT + 2, height);
    context.clip();
    const playhead = Math.round(this.toX(state.time)) + 0.5;
    const bottom = this.trackTop(state.tracks.length) - TRACK_GAP;
    context.strokeStyle = "#ff3b30";
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(playhead, 2);
    context.lineTo(playhead, bottom);
    context.stroke();
    context.fillStyle = "#ff3b30";
    context.beginPath();
    context.moveTo(playhead - 5, 0);
    context.lineTo(playhead + 5, 0);
    context.lineTo(playhead, 7);
    context.closePath();
    context.fill();
    context.restore();
  }

  /** Draws everything except the playhead into the layer, at the canvas's current size. */
  private drawLayer(ratio: number) {
    const canvas = this.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    this.size = { width, height, ratio };
    this.layerDirty = false;
    for (const target of [canvas, this.layer]) {
      if (target.width !== Math.round(width * ratio) || target.height !== Math.round(height * ratio)) {
        target.width = Math.round(width * ratio);
        target.height = Math.round(height * ratio);
      }
    }
    const context = this.layer.getContext("2d")!;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const state = this.state;
    if (!state || !state.duration) return;

    const color = palette();
    const muted = color("--muted");
    const border = color("--border");
    const accent = color("--accent");
    const text = color("--text");
    const surface = color("--surface-2");
    const cutColor = color("--cut") || "#ff453a";

    context.font = "11px 'Segoe UI', system-ui, sans-serif";
    context.textBaseline = "middle";

    // Everything past the gutter is clipped so zoomed-in content doesn't spill onto the labels.
    context.save();
    context.beginPath();
    context.rect(LEFT - 2, 0, width - LEFT + 2, height);
    context.clip();

    // Ruler with a tick spacing that keeps labels apart.
    const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
    const pxPerMs = (width - LEFT - RIGHT) / this.span;
    const step = steps.find((candidate) => candidate * pxPerMs >= 70) ?? steps[steps.length - 1];
    const firstTick = Math.floor(this.view.start / (step / 5)) * (step / 5);
    for (let t = firstTick; t <= this.view.end; t += step / 5) {
      if (t < 0) continue;
      const x = Math.round(this.toX(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      context.strokeStyle = border;
      context.beginPath();
      context.moveTo(x, major ? 12 : 17);
      context.lineTo(x, RULER);
      context.stroke();
      if (major) {
        context.fillStyle = muted;
        context.fillText(formatRuler(t), x + 3, 7);
      }
    }

    // Marked moments: a small flag on the ruler.
    context.fillStyle = color("--record") || "#ff3b30";
    for (const t of state.markers) {
      const x = Math.round(this.toX(t)) + 0.5;
      context.fillRect(x - 0.5, 4, 1.5, RULER - 4);
      context.beginPath();
      context.moveTo(x + 1, 4);
      context.lineTo(x + 9, 7.5);
      context.lineTo(x + 1, 11);
      context.fill();
    }

    // Clip: thumbnails, waveform, trimmed and cut ranges.
    const clipLeft = this.toX(0);
    const clipRight = this.toX(state.duration);
    context.save();
    context.beginPath();
    context.roundRect(clipLeft, CLIP.top, clipRight - clipLeft, CLIP.height, 7);
    context.clip();
    context.fillStyle = surface;
    context.fillRect(clipLeft, CLIP.top, clipRight - clipLeft, CLIP.height);
    // A closed bitmap (the take was just switched) has no size; it is skipped until the new state.
    if (state.thumbnails.length && state.thumbnails[0].image.width && state.thumbnails[0].image.height) {
      const first = state.thumbnails[0].image;
      const thumbWidth = (CLIP.height * first.width) / first.height;
      for (let x = clipLeft; x < clipRight; x += thumbWidth) {
        if (x + thumbWidth < LEFT || x > width) continue;
        const best = nearestThumb(state.thumbnails, this.toTime(x + thumbWidth / 2));
        if (best.image.width) context.drawImage(best.image, x, CLIP.top, thumbWidth, CLIP.height);
      }
    }
    // With a lane per source, the mixed waveform on the clip would only repeat them.
    if (state.waveform && !this.media.some((lane) => lane.kind === "wave")) {
      const wave = state.waveform;
      context.fillStyle = "rgba(255, 255, 255, 0.55)";
      const bottom = CLIP.top + CLIP.height;
      for (let x = Math.max(clipLeft, LEFT); x < Math.min(clipRight, width); x += 2) {
        const index = Math.floor((this.toTime(x) / state.duration) * (wave.length - 1));
        const level = wave[index] ?? 0;
        const h = Math.max(1, level * CLIP.height * 0.45);
        context.fillRect(x, bottom - h - 2, 1.5, h);
      }
    }
    // Outside the trim: dim.
    context.fillStyle = "rgba(0, 0, 0, 0.6)";
    const keepLeft = this.toX(state.trim.start);
    const keepRight = this.toX(state.trim.end);
    context.fillRect(clipLeft, CLIP.top, keepLeft - clipLeft, CLIP.height);
    context.fillRect(keepRight, CLIP.top, clipRight - keepRight, CLIP.height);
    // Cuts: dim and hatch in red.
    const cutTrack = state.tracks.find((track) => track.key === "cuts");
    for (const cut of [...(cutTrack?.items ?? []), ...state.wordCuts]) {
      if (cut.end <= cut.start) continue;
      hatch(context, this.toX(cut.start), this.toX(cut.end), CLIP.top, CLIP.height, withAlpha(cutColor, 0.7));
    }
    // Splits: a white line across the clip, outlined so it shows on light frames too.
    for (const split of cutTrack?.items ?? []) {
      if (split.end > split.start) continue;
      const x = Math.round(this.toX(split.start)) + 0.5;
      const selected = state.selected?.track === "cuts" && state.selected.id === split.id;
      context.fillStyle = "rgba(0, 0, 0, 0.55)";
      context.fillRect(x - 2.5, CLIP.top, 5, CLIP.height);
      context.fillStyle = selected ? accent : "#ffffff";
      context.fillRect(x - 1, CLIP.top, 2, CLIP.height);
    }
    context.restore();

    // A transition on a cut's (or split's) seam: a small diamond at the bottom of the clip.
    for (const cut of cutTrack?.items ?? []) {
      if (!(cut as Range & { transition?: unknown }).transition) continue;
      const x = (this.toX(cut.start) + this.toX(cut.end)) / 2;
      const y = CLIP.top + CLIP.height - 8;
      context.save();
      context.translate(x, y);
      context.rotate(Math.PI / 4);
      context.fillStyle = accent;
      context.strokeStyle = "#ffffff";
      context.lineWidth = 1.5;
      context.beginPath();
      context.roundRect(-5, -5, 10, 10, 2);
      context.fill();
      context.stroke();
      context.restore();
    }

    context.strokeStyle = accent;
    context.lineWidth = 1.5;
    context.beginPath();
    context.roundRect(keepLeft, CLIP.top, keepRight - keepLeft, CLIP.height, 7);
    context.stroke();
    context.lineWidth = 1;

    context.fillStyle = "#ffffff";
    for (const t of state.clicks) {
      const x = this.toX(t);
      // Off-screen dots would be clipped anyway.
      if (x < LEFT - 6 || x > width + 3) continue;
      context.beginPath();
      context.arc(x, CLIP.top + 7, 2.2, 0, Math.PI * 2);
      context.fill();
    }

    for (const side of [keepLeft, keepRight]) {
      context.fillStyle = accent;
      context.beginPath();
      context.roundRect(side - 4, CLIP.top + 4, 8, CLIP.height - 8, 3);
      context.fill();
      context.fillStyle = "#fff";
      context.fillRect(side - 0.75, CLIP.top + CLIP.height / 2 - 7, 1.5, 14);
    }

    // Media lanes: webcam frames and waveforms, dimmed where the clip is.
    const cuts = [...(cutTrack?.items ?? []), ...state.wordCuts].filter((cut) => cut.end > cut.start);
    this.media.forEach((lane, index) => {
      const top = this.mediaTop(index);
      const laneHeight = this.mediaHeight(index);
      context.save();
      context.beginPath();
      context.roundRect(clipLeft, top, clipRight - clipLeft, laneHeight, 6);
      context.clip();
      context.fillStyle = withAlpha(surface, 0.6) || surface;
      context.fillRect(clipLeft, top, clipRight - clipLeft, laneHeight);
      const frames = lane.frames ?? [];
      const shift = lane.shift ?? 0;
      if (lane.kind === "frames" && frames.length && frames[0].image.width && frames[0].image.height) {
        const offset = (lane.offset ?? 0) + shift;
        const span = lane.span ?? { start: frames[0].t, end: frames[frames.length - 1].t };
        const left = Math.max(clipLeft, this.toX(span.start + offset));
        const right = Math.min(clipRight, this.toX(span.end + offset));
        const thumbWidth = (laneHeight * frames[0].image.width) / frames[0].image.height;
        context.save();
        context.beginPath();
        context.rect(left, top, right - left, laneHeight);
        context.clip();
        for (let x = left; x < right; x += thumbWidth) {
          if (x + thumbWidth < LEFT || x > width) continue;
          const best = nearestThumb(frames, this.toTime(x + thumbWidth / 2) - offset);
          if (best.image.width) context.drawImage(best.image, x, top, thumbWidth, laneHeight);
        }
        context.restore();
      } else if (lane.kind === "wave" && lane.wave) {
        const wave = lane.wave;
        const middle = top + laneHeight / 2;
        context.fillStyle = withAlpha(lane.color ?? accent, lane.muted ? 0.3 : 0.9);
        for (let x = Math.max(clipLeft, LEFT); x < Math.min(clipRight, width); x += 2) {
          // The waveform is on the source's own clock; a moved lane draws it moved.
          const at = this.rawTime(x) - shift;
          if (at < 0 || at > state.duration) continue;
          const level = wave[Math.floor((at / state.duration) * (wave.length - 1))] ?? 0;
          const h = Math.max(1, level * (laneHeight - 6));
          context.fillRect(x, middle - h / 2, 1.5, h);
        }
      }
      // Outside the trim and inside cuts: dim, like the clip.
      context.fillStyle = "rgba(0, 0, 0, 0.5)";
      context.fillRect(clipLeft, top, keepLeft - clipLeft, laneHeight);
      context.fillRect(keepRight, top, clipRight - keepRight, laneHeight);
      for (const cut of cuts) context.fillRect(this.toX(cut.start), top, this.toX(cut.end) - this.toX(cut.start), laneHeight);
      // The lane's own cuts: hatched gaps, outlined when selected.
      const cutKey = lane.key ? laneCutKey(lane.key) : null;
      for (const cut of lane.cuts ?? []) {
        const x0 = this.toX(cut.start);
        const x1 = Math.max(x0 + 2, this.toX(cut.end));
        hatch(context, x0, x1, top, laneHeight, withAlpha(lane.color ?? cutColor, 0.8));
        if (state.selected?.track === cutKey && state.selected.id === cut.id) {
          context.strokeStyle = text;
          context.lineWidth = 1.5;
          context.strokeRect(x0 + 0.75, top + 0.75, x1 - x0 - 1.5, laneHeight - 1.5);
          context.lineWidth = 1;
        }
      }
      context.restore();
      const pill = (label: string, x: number, fill: string, ink: string) => {
        const pillWidth = context.measureText(label).width + 10;
        context.fillStyle = fill;
        context.beginPath();
        context.roundRect(x, top + laneHeight / 2 - 7, pillWidth, 14, 7);
        context.fill();
        context.fillStyle = ink;
        context.fillText(label, x + 5, top + laneHeight / 2);
        return pillWidth;
      };
      let hintRight = Math.max(clipLeft, LEFT) + 8;
      if (lane.muted) hintRight += pill("mudo", hintRight, surface, muted) + 6;
      const drag = this.drag;
      if (drag?.kind === "lane" && drag.key === lane.key && drag.moved) {
        // While dragging: how far, next to the pointer.
        const label = shiftLabel(drag.shift);
        const pillWidth = context.measureText(label).width + 10;
        pill(label, Math.min(width - RIGHT - pillWidth, Math.max(LEFT, drag.x + 10)), accent, "#ffffff");
      } else if (shift) {
        // A moved lane says so, so an accidental drag doesn't go unnoticed.
        pill(shiftLabel(shift), hintRight, surface, text);
      }
    });

    // Selected stretch: bright on the clip, a light column across the tracks.
    if (state.range) {
      const x0 = this.toX(state.range.start);
      const x1 = this.toX(state.range.end);
      const bottom = this.trackTop(state.tracks.length) - TRACK_GAP;
      context.fillStyle = withAlpha(accent, 0.1);
      context.fillRect(x0, CLIP.top, x1 - x0, bottom - CLIP.top);
      context.fillStyle = "rgba(255, 255, 255, 0.22)";
      context.fillRect(x0, CLIP.top, x1 - x0, CLIP.height);
      context.strokeStyle = accent;
      context.lineWidth = 2;
      context.strokeRect(x0, CLIP.top + 1, x1 - x0, CLIP.height - 2);
      context.lineWidth = 1;
      const seconds = `${((state.range.end - state.range.start) / 1000).toFixed(1).replace(".", ",")} s`;
      const width = context.measureText(seconds).width + 12;
      context.fillStyle = accent;
      context.beginPath();
      context.roundRect((x0 + x1) / 2 - width / 2, CLIP.top - 9, width, 16, 8);
      context.fill();
      context.fillStyle = "#fff";
      context.textAlign = "center";
      context.fillText(seconds, (x0 + x1) / 2, CLIP.top - 1);
      context.textAlign = "start";
    }

    // Edit tracks.
    state.tracks.forEach((track, index) => {
      const top = this.trackTop(index);
      context.fillStyle = withAlpha(surface, 0.6) || surface;
      context.beginPath();
      context.roundRect(clipLeft, top, clipRight - clipLeft, this.trackHeight(index), 6);
      context.fill();
      if (!track.items.length) {
        context.fillStyle = muted;
        context.fillText("Clique duplo para adicionar", Math.max(clipLeft, LEFT) + 10, top + TRACK_HEIGHT / 2);
      }
      for (const item of track.items) {
        const x = this.toX(item.start);
        const w = Math.max(4, this.toX(item.end) - x);
        const box = this.itemBox(index, item);
        const selected = state.selected?.track === track.key && state.selected.id === item.id;
        const tint = track.tint?.(item) ?? track.color;
        if (item.end <= item.start) {
          // A split: a small handle centered on it, with a light notch.
          context.fillStyle = selected ? tint : withAlpha(tint, 0.75);
          context.beginPath();
          context.roundRect(x - 4, box.top, 8, box.height, 3);
          context.fill();
          if (selected) {
            context.strokeStyle = text;
            context.lineWidth = 1.5;
            context.stroke();
            context.lineWidth = 1;
          }
          context.fillStyle = "#ffffff";
          context.fillRect(x - 0.75, box.top + 4, 1.5, box.height - 8);
          continue;
        }
        context.fillStyle = selected ? tint : withAlpha(tint, 0.6);
        context.beginPath();
        context.roundRect(x, box.top, w, box.height, 5);
        context.fill();
        if (selected) {
          context.strokeStyle = text;
          context.lineWidth = 1.5;
          context.stroke();
          context.lineWidth = 1;
        }
        const label = track.text?.(item);
        if (label && w > 30) {
          context.fillStyle = "#111114";
          context.fillText(label, x + 7, box.top + box.height / 2, w - 10);
        }
      }
    });

    // The playhead goes on top, in draw().
    context.restore();

    // Gutter labels.
    context.fillStyle = muted;
    context.fillText("Vídeo", 14, CLIP.top + CLIP.height / 2);
    this.media.forEach((lane, index) => {
      const middle = this.mediaTop(index) + this.mediaHeight(index) / 2;
      context.fillStyle = withAlpha(lane.color ?? muted, lane.muted ? 0.35 : 1);
      context.beginPath();
      context.arc(18, middle, 3.5, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = muted;
      context.fillText(lane.label, 28, middle, LEFT - 32);
    });
    state.tracks.forEach((track, index) => {
      const top = this.trackTop(index);
      context.fillStyle = track.color;
      context.beginPath();
      context.arc(18, top + TRACK_HEIGHT / 2, 3.5, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = muted;
      context.fillText(track.label, 28, top + TRACK_HEIGHT / 2);
    });
    if (this.span < state.duration) {
      // Scroll indicator when zoomed in.
      const barLeft = LEFT + (this.view.start / state.duration) * (width - LEFT - RIGHT);
      const barWidth = Math.max(20, (this.span / state.duration) * (width - LEFT - RIGHT));
      context.fillStyle = withAlpha("#888888", 0.5);
      context.beginPath();
      context.roundRect(barLeft, height - 4, barWidth, 3, 2);
      context.fill();
    }
  }
}
