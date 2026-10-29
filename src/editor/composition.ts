import type { CursorEvent, KeyEvent, Take, Word } from "../types";
import { cameraPath, cursorPath, RawPath, SpringPath, zoomAt } from "./motion";
import { LENS_SHAPES, ANIMATED_BACKGROUNDS, BACKGROUNDS, CLICK_DURATIONS, cardLength, sourceSize, type Cut, type Note, type Project, type TitleCard, type TransitionKind, type ZoomSegment } from "./project";
import type { CursorKind, FrameState } from "./renderer";
import { TimeMap, type Span } from "./timemap";

/** How long the cursor shrinks when it clicks, in ms. */
const PRESS = 160;
const SPOTLIGHT_HOLD = 1400;
const SPOTLIGHT_FADE = 300;
const KEY_HOLD = 1300;
/** A resting cursor fades out over this long, and wakes up this long before it moves again. */
const IDLE_FADE = 250;
const IDLE_WAKE = 120;
/** At most this long at the end is spent gliding the cursor back to where it started. */
const RETURN_HOME = 900;
const CAPTION_WORDS = 7;
const CAPTION_GAP = 700;

/** A take with its edit and everything derived from them. Preview and export share it. */
export type Scene = {
  take: Take;
  project: Project;
  events: CursorEvent[];
  clicks: CursorEvent[];
  shapes: CursorEvent[];
  keys: KeyEvent[];
  words: Word[];
  raw: RawPath;
  cursor: { at(t: number): [number, number] };
  camera: SpringPath;
  time: TimeMap;
  /** Shape changes left after skipping quick ones, for the delay they were computed with. */
  stable?: { delay: number; shapes: CursorEvent[] };
  /** Times of left clicks, for the clicks they were taken from. */
  left?: { clicks: CursorEvent[]; times: number[] };
  /** Cut seams with a transition, for the time map and cuts they were computed with. */
  seams?: { time: TimeMap; cuts: Cut[]; list: Seam[] };
  /** Caption lines, for the words and deleted words they were split from. */
  lines?: { words: Word[]; deleted: number[]; count: number; lines: Word[][]; reach: number[] };
};

/** A cut's seam on the output timeline and the half-length of its transition. */
type Seam = { at: number; half: number; kind: TransitionKind };

/** Index of the last item at or before `t` (items sorted by time), or -1. */
function lastAt(items: ArrayLike<{ t: number }>, t: number) {
  let low = 0;
  let high = items.length - 1;
  let last = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle].t <= t) {
      last = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return last;
}

/** Index of the last time at or before `t` in a sorted list, or -1. */
function lastTimeAt(times: ArrayLike<number>, t: number) {
  let low = 0;
  let high = times.length - 1;
  let last = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (times[middle] <= t) {
      last = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return last;
}

/** Times of the left clicks, in order; built once per scene. */
export function leftClicks(scene: Pick<Scene, "clicks" | "left">): number[] {
  if (scene.left?.clicks === scene.clicks) return scene.left.times;
  const times = scene.clicks.filter((click) => click.b === "l").map((click) => click.t);
  scene.left = { clicks: scene.clicks, times };
  return times;
}

export function createScene(take: Take, project: Project, events: CursorEvent[], keys: KeyEvent[] = [], words: Word[] = []): Scene {
  const moves = events.filter((event) => event.k !== "s");
  const raw = new RawPath(moves);
  const scene: Scene = {
    take,
    project,
    events: moves,
    clicks: moves.filter((event) => event.k === "d"),
    shapes: events.filter((event) => event.k === "s"),
    keys,
    words,
    raw,
    cursor: cursorPath(raw, take.durationMs, project.cursor.smoothing, project.cursor.bounce),
    camera: cameraPath(raw, take.durationMs),
    time: new TimeMap(project),
  };
  return scene;
}

/** Time ranges removed by deleting words in the transcript. */
export function wordCuts(scene: Pick<Scene, "words" | "project">): Span[] {
  const deleted = new Set(scene.project.deletedWords);
  return scene.words.filter((word) => deleted.has(word.i)).map((word) => ({ start: word.t0, end: word.t1 }));
}

/** Rebuilds the time map after cuts, trim or deleted words change. */
export function refreshTime(scene: Scene) {
  scene.time = new TimeMap(scene.project, wordCuts(scene));
}

/** Shape changes that lasted at least the project's delay; shorter ones are skipped. */
function stableShapes(scene: Scene): CursorEvent[] {
  const delay = scene.project.cursor.shapeDelay;
  if (scene.stable?.delay === delay) return scene.stable.shapes;
  const shapes = delay > 0 ? scene.shapes.filter((shape, index) => !scene.shapes[index + 1] || scene.shapes[index + 1].t - shape.t >= delay) : scene.shapes;
  scene.stable = { delay, shapes };
  return shapes;
}

/** 1 while the mouse moves; fades to 0 once it has rested `after` ms, and back just before it moves. */
function idleOpacity(events: CursorEvent[], t: number, after: number) {
  if (after <= 0 || !events.length) return 1;
  const last = lastAt(events, t);
  const resting = last < 0 ? t : t - events[last].t;
  let opacity = resting <= after ? 1 : Math.max(0, 1 - (resting - after) / IDLE_FADE);
  const next = events[last + 1];
  if (opacity < 1 && next && next.t - t < IDLE_WAKE) opacity = Math.max(opacity, 1 - (next.t - t) / IDLE_WAKE);
  return opacity;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * Seams of the cuts (and splits) that carry a transition, in cut order. Every edit rebuilds the
 * time map, so the list is recomputed only when the map or the cuts change.
 */
function seams(scene: Scene): Seam[] {
  const { time, project } = scene;
  if (scene.seams?.time === time && scene.seams.cuts === project.cuts) return scene.seams.list;
  const list: Seam[] = [];
  for (const cut of project.cuts) {
    if (!cut.transition) continue;
    // A split's seam is where it stands; a cut's is where the removed stretch was.
    const at = time.toOutput(cut.start);
    if (at <= 0 || at >= time.duration) continue;
    // Two transitions on one seam (a split dragged onto a cut's edge): the first one plays.
    if (list.some((seam) => Math.abs(seam.at - at) < 1)) continue;
    const half = Math.min(cut.transition.durationMs / 2, at, time.duration - at);
    if (half > 0) list.push({ at, half, kind: cut.transition.kind });
  }
  scene.seams = { time, cuts: project.cuts, list };
  return list;
}

/** The transition playing at source time `t`, if a cut's seam is near. */
function transitionAt(scene: Scene, t: number): FrameState["transition"] {
  const list = seams(scene);
  if (!list.length) return null;
  const output = scene.time.toOutput(t);
  for (const seam of list) {
    const offset = output - seam.at;
    if (Math.abs(offset) >= seam.half) continue;
    return { kind: seam.kind, amount: smooth(1 - Math.abs(offset) / seam.half), phase: offset < 0 ? -1 : 1 };
  }
  return null;
}

function cursorKindAt(shapes: CursorEvent[], t: number): CursorKind {
  const kind = shapes[lastAt(shapes, t)]?.c ?? "arrow";
  return kind === "hand" || kind === "text" ? kind : "arrow";
}

const lensSegments = (segments: ZoomSegment[]) => segments.filter((segment) => segment.mode === "lens");

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
/** Zoom ramps in and out over this long (as in motion.ts `zoomAt`). */
const ZOOM_RAMP = 700;

/** The fixed point a zoom shows at `t` (video pixels), gliding to its second point while held; null follows the cursor. */
function zoomFocusAt(segments: ZoomSegment[], t: number): [number, number] | null {
  const segment = segments.find((candidate) => candidate.mode !== "lens" && candidate.focus && t > candidate.start && t < candidate.end);
  if (!segment?.focus) return null;
  const { focus, to } = segment;
  if (!to) return [focus.x, focus.y];
  const ramp = Math.min(ZOOM_RAMP, (segment.end - segment.start) / 2);
  const hold = segment.end - segment.start - ramp * 2;
  const k = hold > 0 ? easeInOut(Math.max(0, Math.min(1, (t - segment.start - ramp) / hold))) : 0;
  return [focus.x + (to.x - focus.x) * k, focus.y + (to.y - focus.y) * k];
}

/** Lenses closer than this hand over to each other: the glass stays and morphs instead of closing. */
const LENS_LINK = 600;
/** How long a morph between linked lenses lasts, around their meeting point. */
const LENS_MORPH = 400;
const shapeIndex = (segment: ZoomSegment) => Math.max(0, LENS_SHAPES.findIndex((shape) => shape.id === (segment.shape ?? "circle")));

/** The lens at `t`: how far it is open (0–1), its magnification, and its shape (a blend of two while morphing). */
function lensAt(segments: ZoomSegment[], t: number): { amount: number; magnification: number; shape: [number, number, number] } | null {
  const lenses = lensSegments(segments).sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < lenses.length; i++) {
    const [a, b] = [lenses[i], lenses[i + 1]];
    if (b.start - a.end > LENS_LINK) continue;
    const from = a.end - LENS_MORPH / 2;
    const until = b.start + LENS_MORPH / 2;
    if (t < from || t > until) continue;
    const k = smooth((t - from) / (until - from));
    return { amount: 1, magnification: a.scale + (b.scale - a.scale) * k, shape: [shapeIndex(a), shapeIndex(b), k] };
  }
  const index = lenses.findIndex((segment) => t > segment.start && t < segment.end);
  if (index < 0) return null;
  const segment = lenses[index];
  const linkedBefore = index > 0 && segment.start - lenses[index - 1].end <= LENS_LINK;
  const linkedAfter = index + 1 < lenses.length && lenses[index + 1].start - segment.end <= LENS_LINK;
  const ramp = Math.min(ZOOM_RAMP, (segment.end - segment.start) / 2);
  const opening = linkedBefore ? 1 : Math.min(1, (t - segment.start) / ramp);
  const closing = linkedAfter ? 1 : Math.min(1, (segment.end - t) / ramp);
  const shape = shapeIndex(segment);
  return { amount: easeInOut(Math.max(0, Math.min(opening, closing))), magnification: segment.scale, shape: [shape, shape, 0] };
}

/** Cursor travel over the last frame (video pixels); the renderer smears the sprite along it. */
const MOTION_WINDOW = 1000 / 60;

/** 0–1 strength of the click spotlight: rises on a click, holds, then fades. */
function spotlightAt(left: number[], t: number) {
  const index = lastTimeAt(left, t);
  if (index < 0) return 0;
  const age = t - left[index];
  if (age < 150) return age / 150;
  if (age < SPOTLIGHT_HOLD) return 1;
  return Math.max(0, 1 - (age - SPOTLIGHT_HOLD) / SPOTLIGHT_FADE);
}

/** Clicks whose effect (lasting `length` ms) is still playing at `t`, oldest first. */
function recentClicks(clicks: CursorEvent[], t: number, length: number): FrameState["clicks"] {
  let first = lastAt(clicks, t) + 1;
  while (first > 0 && t - clicks[first - 1].t < length) first--;
  const result: FrameState["clicks"] = [];
  for (let i = first; i < clicks.length && clicks[i].t <= t; i++) result.push({ x: clicks[i].x, y: clicks[i].y, age: t - clicks[i].t, at: clicks[i].t });
  return result;
}

/** The cursor leans this far (radians) at full tilt, like a kite pulled by its tip. */
const MAX_LEAN = (25 * Math.PI) / 180;
/** Velocity is averaged over this long (ms), so the lean swings smoothly instead of jittering. */
const LEAN_WINDOW = 120;

/** Lean of the cursor at `t` (radians, positive clockwise) from how fast it moves sideways. */
function cursorLean(scene: Scene, t: number, amount: number) {
  if (amount <= 0) return 0;
  const now = scene.cursor.at(t)[0];
  const before = scene.cursor.at(Math.max(0, t - LEAN_WINDOW))[0];
  // Screen widths per second; about one gives most of the lean.
  const speed = ((now - before) / LEAN_WINDOW) * 1000 / Math.max(1, scene.take.width);
  return MAX_LEAN * Math.tanh(speed * 1.2) * amount;
}

/** How long the screen takes to tilt into a stretch's angle, and back. */
const TILT_EASE = 600;

/**
 * The screen's tilt at `t` (degrees): the video's own tilt, or a stretch's, eased in and out.
 * Stretches that touch go straight from one angle to the next.
 */
function tiltAt(project: Project, t: number) {
  const base = project.tilt;
  const ranges = project.tilts ?? [];
  const index = ranges.findIndex((range) => t >= range.start && t <= range.end);
  if (index < 0) return base;
  const range = ranges[index];
  const before = ranges.find((other) => other !== range && Math.abs(other.end - range.start) < 1);
  const after = ranges.find((other) => other !== range && Math.abs(other.start - range.end) < 1);
  const ease = Math.min(TILT_EASE, (range.end - range.start) / 2);
  if (ease <= 0) return range.angle;
  const into = Math.min(1, (t - range.start) / ease);
  // The next stretch eases in itself, so this one holds its angle to the end.
  const out = after ? 1 : Math.min(1, (range.end - t) / ease);
  if (into <= out) {
    const from = before ? before.angle : base;
    return from + (range.angle - from) * smooth(into);
  }
  return base + (range.angle - base) * smooth(out);
}

/** How long the webcam takes to move between its bubble and another layout. */
const CAMERA_EASE = 400;
/** In "Lado a lado", the screen keeps this share of the width; the camera takes the rest. */
const SIDE_SCREEN = 0.64;

type Box = { x: number; y: number; width: number; height: number };
const mixBox = (a: Box, b: Box, k: number): Box => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, width: a.width + (b.width - a.width) * k, height: a.height + (b.height - a.height) * k });

/** The webcam bubble in the output when it is not moving: its size, and its spot or corner. */
export function webcamBubble(project: Pick<Project, "webcam">, out: { width: number; height: number }) {
  const short = Math.min(out.width, out.height);
  const size = project.webcam.size * short;
  const margin = short * 0.04;
  const { position, corner } = project.webcam;
  const center = position
    ? { x: position.x * out.width, y: position.y * out.height }
    : { x: corner.endsWith("l") ? margin + size / 2 : out.width - margin - size / 2, y: corner.startsWith("t") ? margin + size / 2 : out.height - margin - size / 2 };
  // Always fully inside the frame.
  const x = Math.min(Math.max(center.x - size / 2, 0), out.width - size);
  const y = Math.min(Math.max(center.y - size / 2, 0), out.height - size);
  const shape = project.webcam.shape;
  const radius = shape === "circle" ? size / 2 : shape === "rounded" ? size * 0.14 : size * 0.03;
  return { rect: { x, y, width: size, height: size }, radius };
}

/** The camera layout at `t`, with how far it has moved from the bubble (0–1). */
function cameraLayoutAt(project: Project, t: number) {
  for (const range of project.cameras ?? []) {
    if (t < range.start || t > range.end) continue;
    const k = Math.max(0, Math.min(1, (t - range.start) / CAMERA_EASE, (range.end - t) / CAMERA_EASE));
    return { layout: range.layout, k: smooth(k) };
  }
  return null;
}

/** How long the webcam takes to fade out at the start of one of its own cuts (and back in at the end), in ms. */
const WEBCAM_CUT_FADE = 120;

/**
 * How far the webcam has faded out at `t`: inside its own cuts, and where a moved webcam has no
 * picture (before it starts or after it ends). 0 while shown, 1 once gone.
 */
function webcamCutAt(take: Take, project: Pick<Project, "media">, t: number) {
  const shift = project.media?.webcam.shift ?? 0;
  const start = (take.webcamOffsetMs ?? 0) + shift;
  const end = take.durationMs + shift;
  if (t < start || t > end) return smooth(Math.min(1, Math.max(start - t, t - end) / WEBCAM_CUT_FADE));
  for (const cut of project.media?.webcam.cuts ?? []) {
    if (t < cut.start || t > cut.end) continue;
    return smooth(Math.max(0, Math.min(1, (t - cut.start) / WEBCAM_CUT_FADE, (cut.end - t) / WEBCAM_CUT_FADE)));
  }
  return 0;
}

/** The webcam at `t` (bubble, full frame, beside the screen or hidden) and the area left for the screen. */
function webcamAt(scene: Scene, t: number, out: { width: number; height: number }): { webcam: FrameState["webcam"]; area: FrameState["area"] } {
  const { take, project } = scene;
  if (!take.webcam || !project.webcam.visible) return { webcam: null, area: null };
  const bubble = webcamBubble(project, out);
  let rect: Box = bubble.rect;
  let radius = bubble.radius;
  let opacity = 1;
  let area: FrameState["area"] = null;
  let full = 0;
  const camera = cameraLayoutAt(project, t);
  if (camera && camera.k > 0) {
    const { layout, k } = camera;
    const short = Math.min(out.width, out.height);
    const margin = short * 0.04;
    if (layout === "full") {
      rect = mixBox(rect, { x: 0, y: 0, width: out.width, height: out.height }, k);
      radius *= 1 - k;
      full = k;
    } else if (layout === "side") {
      const panel = { x: out.width * SIDE_SCREEN, y: margin, width: out.width * (1 - SIDE_SCREEN) - margin, height: out.height - margin * 2 };
      rect = mixBox(rect, panel, k);
      radius += (short * 0.03 - radius) * k;
      area = mixBox({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: SIDE_SCREEN, height: 1 }, k);
    } else {
      // Hidden: shrinks a little as it fades.
      const scale = 1 - 0.35 * k;
      rect = { x: rect.x + (rect.width * (1 - scale)) / 2, y: rect.y + (rect.height * (1 - scale)) / 2, width: rect.width * scale, height: rect.height * scale };
      radius *= scale;
      opacity = 1 - k;
    }
  }
  // Cut on its own: the webcam fades out, and the screen takes back the room it left.
  const gone = webcamCutAt(take, project, t);
  if (gone > 0) {
    opacity *= 1 - gone;
    if (area) area = mixBox(area, { x: 0, y: 0, width: 1, height: 1 }, gone);
  }
  const { mirror, border, borderColor, shadow, zoom, background, light, warmth } = project.webcam;
  return {
    webcam: { rect, radius, opacity, mirror, border: border * Math.min(bubble.rect.width, bubble.rect.height), borderColor, shadow, zoom, background, light, warmth, full },
    area,
  };
}

/** How far the drawn cursor moved over the last frame, in video pixels; null when it barely moved. */
function cursorMotion(scene: Scene, t: number, now: { x: number; y: number }): [number, number] | null {
  const before = scene.cursor.at(Math.max(0, t - MOTION_WINDOW));
  const dx = now.x - before[0];
  const dy = now.y - before[1];
  return Math.hypot(dx, dy) > 6 ? [dx, dy] : null;
}

/** One slow cycle of an animated background at speed 1. */
const BACKGROUND_CYCLE = 12000;

/**
 * Where an animated background is at source time `t`, from the output time so preview and export
 * agree: `phase` is the fraction of one cycle, with a whole number of cycles over the edit so a
 * looping video wraps around seamlessly; `tick` counts frames for grain.
 */
function backgroundPhase(scene: Pick<Scene, "time">, t: number, speed: number) {
  const duration = Math.max(1, scene.time.duration);
  const output = Math.min(Math.max(scene.time.toOutput(t), 0), duration);
  const cycles = Math.max(1, Math.round((duration * speed) / BACKGROUND_CYCLE));
  const turns = (output / duration) * cycles;
  return { phase: turns - Math.floor(turns), tick: Math.floor(output / (1000 / 30)) };
}

/** Everything the renderer needs for the frame at source time `t` (ms). */
export function frameState(scene: Scene, t: number, output: FrameState["output"], overlay = false): FrameState {
  const { take, project, raw, cursor, camera, clicks } = scene;
  const preset = BACKGROUNDS.find((candidate) => candidate.id === project.background.preset) ?? BACKGROUNDS[0];
  const animated = project.background.kind === "animated" ? ANIMATED_BACKGROUNDS.find((candidate) => candidate.id === project.background.animation) : undefined;
  const video = { width: take.width, height: take.height };
  const crop = project.crop;
  const zoom = zoomAt(project.zoom.segments.filter((segment) => segment.mode !== "lens"), t);
  const lens = lensAt(project.zoom.segments, t);
  const center: [number, number] = crop ? [crop.x + crop.width / 2, crop.y + crop.height / 2] : [video.width / 2, video.height / 2];
  const bounds = crop ?? { x: 0, y: 0, width: video.width, height: video.height };
  // The camera follows the cursor (or holds a zoom's own point), but never past the edge of what was recorded.
  const followed = zoomFocusAt(project.zoom.segments, t) ?? (raw.empty ? center : camera.at(t));
  const focus: [number, number] = [
    Math.min(Math.max(followed[0], bounds.x), bounds.x + bounds.width),
    Math.min(Math.max(followed[1], bounds.y), bounds.y + bounds.height),
  ];

  let cursorState: FrameState["cursor"] = null;
  let tip: [number, number] | null = null;
  if (!raw.empty) tip = cursor.at(t);
  // For videos that loop: glide back to where the cursor was at the start.
  let returning = false;
  if (tip && project.cursor.returnHome) {
    const total = scene.time.duration;
    const span = Math.min(RETURN_HOME, total / 3);
    const progress = (scene.time.toOutput(t) - (total - span)) / span;
    if (progress > 0) {
      const home = cursor.at(scene.time.toSource(0));
      const k = smooth(Math.min(1, progress));
      tip = [tip[0] + (home[0] - tip[0]) * k, tip[1] + (home[1] - tip[1]) * k];
      returning = true;
    }
  }
  if (project.cursor.visible && !take.cursorInVideo && tip) {
    const [rawX, rawY] = returning ? tip : raw.at(t);
    // Off the captured area (outside a recorded window or the crop): hide instead of pinning to the edge.
    const inside = rawX >= bounds.x - 4 && rawY >= bounds.y - 4 && rawX <= bounds.x + bounds.width + 4 && rawY <= bounds.y + bounds.height + 4;
    const opacity = returning ? 1 : idleOpacity(scene.events, t, project.cursor.hideIdle);
    if (inside && opacity > 0) {
      // The earliest click still pressing: walk back from the last one at or before `t`.
      let press: CursorEvent | undefined;
      for (let i = lastAt(clicks, t); i >= 0 && t - clicks[i].t < PRESS; i--) press = clicks[i];
      const squeeze = press ? 1 - 0.18 * Math.sin((Math.PI * (t - press.t)) / PRESS) : 1;
      cursorState = {
        x: tip[0],
        y: tip[1],
        scale: project.cursor.size * squeeze,
        kind: returning ? "arrow" : cursorKindAt(stableShapes(scene), t),
        style: project.cursor.style,
        opacity,
        angle: returning ? 0 : cursorLean(scene, t, project.cursor.tilt),
      };
    }
  }

  const out = { width: output.width, height: output.height };
  const { webcam, area } = webcamAt(scene, t, out);

  return {
    output: out,
    video,
    crop,
    background: {
      kind: animated ? "animated" : project.background.kind === "image" ? "image" : "gradient",
      from: (animated ?? preset).from,
      to: (animated ?? preset).to,
      angle: (animated ?? preset).angle,
      animation: animated ? { style: animated.style, accent: animated.accent, ...backgroundPhase(scene, t, project.background.speed) } : null,
      padding: project.background.padding,
      radius: project.background.radius,
      shadow: project.background.shadow,
    },
    frame: project.frame,
    tilt: tiltAt(project, t),
    zoom,
    focus,
    cursor: cursorState,
    clicks: project.cursor.clickEffect ? recentClicks(clicks, t, CLICK_DURATIONS[project.cursor.clickStyle]) : [],
    clickStyle: project.cursor.clickStyle,
    clickSize: project.cursor.clickSize,
    transition: transitionAt(scene, t),
    spotlight: project.cursor.spotlight && !raw.empty ? spotlightAt(leftClicks(scene), t) * 0.85 : 0,
    // Focus follows the cursor, so it fades out with it when it hides.
    focusMode: project.cursor.focus && cursorState ? cursorState.opacity : 0,
    lens: lens && tip ? { x: tip[0], y: tip[1], magnification: lens.magnification, amount: lens.amount, shape: lens.shape } : null,
    motion: cursorState && project.cursor.motionBlur ? cursorMotion(scene, t, cursorState) : null,
    blurs: project.blurs.filter((blur) => t >= blur.start && t <= blur.end),
    webcam,
    area,
    overlay,
  };
}

/** Keys and caption shown at source time `t`. */
/** Cross-fade between a title card and the video. */
export const CARD_FADE = 350;

export { cardLength };

/** Length of the finished video: opening, the edit, closing. */
export function totalDuration(scene: Pick<Scene, "project" | "time">) {
  return cardLength(scene.project.cards.intro) + scene.time.duration + cardLength(scene.project.cards.outro);
}

export type CardView = { card: TitleCard; opacity: number };

/**
 * What a moment of the finished video shows: the source time under it, and a title card on top
 * (the first or last frame stays under the card, so the fade reveals the video).
 */
export function outputMoment(scene: Pick<Scene, "project" | "time">, output: number): { t: number; card: CardView | null } {
  const { intro, outro } = scene.project.cards;
  const before = cardLength(intro);
  const body = scene.time.duration;
  if (output < before) return { t: scene.time.toSource(0), card: { card: intro, opacity: Math.min(1, (before - output) / CARD_FADE) } };
  const inside = output - before;
  if (inside >= body && cardLength(outro)) return { t: scene.time.toSource(Math.max(0, body - 1)), card: { card: outro, opacity: Math.min(1, (inside - body) / CARD_FADE) } };
  return { t: scene.time.toSource(Math.min(inside, body)), card: null };
}

/** Notes fade in and out over this long. */
const NOTE_FADE = 200;

export type OverlayContent = {
  keys: string | null;
  caption: { words: Word[]; current: number } | null;
  notes: { note: Note; opacity: number }[];
};

export function overlayText(scene: Scene, t: number): OverlayContent {
  const { project } = scene;
  const notes = project.notes
    .filter((note) => t >= note.start && t <= note.end)
    .map((note) => ({ note, opacity: Math.max(0, Math.min(1, (t - note.start) / NOTE_FADE, (note.end - t) / NOTE_FADE)) }));
  let keys: string | null = null;
  if (project.keys.visible && scene.keys.length) {
    const last = lastAt(scene.keys, t);
    let first = last + 1;
    while (first > 0 && t - scene.keys[first - 1].t < KEY_HOLD) first--;
    const recent = scene.keys.slice(first, last + 1);
    if (project.keys.mode === "shortcuts") {
      const shortcut = [...recent].reverse().find((key) => key.m.length > 0);
      if (shortcut) keys = [...shortcut.m, shortcut.n].join(" + ");
    } else if (recent.length) {
      // Typing: the keys pressed in the last moments, in order.
      keys = recent
        .slice(-12)
        .map((key) => (key.m.length ? [...key.m, key.n].join("+") : key.n))
        .join(" ");
    }
  }

  let caption: { words: Word[]; current: number } | null = null;
  if (project.captions.visible && scene.words.length) {
    // The first line showing at `t`: lines before `index` all ended (with their linger) earlier.
    const { lines, reach } = captionLines(scene);
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (t <= reach[middle]) high = middle;
      else low = middle + 1;
    }
    const line = lines[low];
    if (line && t >= line[0].t0 && t <= line[line.length - 1].t1 + CAPTION_LINGER) {
      caption = { words: line, current: line.findIndex((word) => t >= word.t0 && t <= word.t1) };
    }
  }
  return { keys, caption, notes };
}

/** A caption line stays up this long after its last word. */
const CAPTION_LINGER = 400;

/**
 * Caption lines of the words left after deleting: up to CAPTION_WORDS words, broken at pauses.
 * `reach[i]` is the latest moment any of the first i + 1 lines is still showing, for searching.
 * Deleting or restoring words replaces the list, so the lines are rebuilt only then.
 */
function captionLines(scene: Scene) {
  const deletedWords = scene.project.deletedWords;
  const cached = scene.lines;
  if (cached && cached.words === scene.words && cached.deleted === deletedWords && cached.count === deletedWords.length) return cached;
  const deleted = new Set(deletedWords);
  const lines: Word[][] = [];
  const reach: number[] = [];
  let line: Word[] = [];
  const close = () => {
    lines.push(line);
    reach.push(Math.max(reach[reach.length - 1] ?? -Infinity, line[line.length - 1].t1 + CAPTION_LINGER));
  };
  for (const word of scene.words) {
    if (deleted.has(word.i)) continue;
    const previous = line[line.length - 1];
    if (line.length && (line.length >= CAPTION_WORDS || word.t0 - previous.t1 > CAPTION_GAP)) {
      close();
      line = [];
    }
    line.push(word);
  }
  if (line.length) close();
  scene.lines = { words: scene.words, deleted: deletedWords, count: deletedWords.length, lines, reach };
  return scene.lines;
}

/** Output size helper that accounts for the crop. */
export const sceneSource = (scene: Scene) => sourceSize(scene.project, scene.take);
