import type { CursorEvent, KeyEvent, Take, Word } from "../types";
import { cameraPath, cursorPath, RawPath, SpringPath, zoomAt } from "./motion";
import { BACKGROUNDS, cardLength, sourceSize, type Note, type Project, type TitleCard, type ZoomSegment } from "./project";
import type { CursorKind, FrameState } from "./renderer";
import { TimeMap, type Span } from "./timemap";

/** How long the cursor shrinks when it clicks, in ms. */
const PRESS = 160;
const CLICK_EFFECT = 450;
const SPOTLIGHT_HOLD = 1400;
const SPOTLIGHT_FADE = 300;
const KEY_HOLD = 1300;
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
};

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
    cursor: cursorPath(raw, take.durationMs, project.cursor.smoothing),
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

function cursorKindAt(shapes: CursorEvent[], t: number): CursorKind {
  let kind: CursorEvent["c"] = "arrow";
  for (const shape of shapes) {
    if (shape.t > t) break;
    kind = shape.c;
  }
  return kind === "hand" || kind === "text" ? kind : "arrow";
}

const lensSegments = (segments: ZoomSegment[]) => segments.filter((segment) => segment.mode === "lens");

/** 0–1 strength of the click spotlight: rises on a click, holds, then fades. */
function spotlightAt(clicks: CursorEvent[], t: number) {
  let last: CursorEvent | null = null;
  for (const click of clicks) {
    if (click.t > t) break;
    if (click.b === "l") last = click;
  }
  if (!last) return 0;
  const age = t - last.t;
  if (age < 150) return age / 150;
  if (age < SPOTLIGHT_HOLD) return 1;
  return Math.max(0, 1 - (age - SPOTLIGHT_HOLD) / SPOTLIGHT_FADE);
}

/** Everything the renderer needs for the frame at source time `t` (ms). */
export function frameState(scene: Scene, t: number, output: FrameState["output"], overlay = false): FrameState {
  const { take, project, raw, cursor, camera, clicks } = scene;
  const preset = BACKGROUNDS.find((candidate) => candidate.id === project.background.preset) ?? BACKGROUNDS[0];
  const video = { width: take.width, height: take.height };
  const crop = project.crop;
  const zoom = zoomAt(project.zoom.segments.filter((segment) => segment.mode !== "lens"), t);
  const lensLevel = zoomAt(lensSegments(project.zoom.segments), t);
  const lensSegment = lensSegments(project.zoom.segments).find((segment) => t > segment.start && t < segment.end);
  const center: [number, number] = crop ? [crop.x + crop.width / 2, crop.y + crop.height / 2] : [video.width / 2, video.height / 2];
  const bounds = crop ?? { x: 0, y: 0, width: video.width, height: video.height };
  // The camera follows the cursor, but never past the edge of what was recorded.
  const followed = raw.empty ? center : camera.at(t);
  const focus: [number, number] = [
    Math.min(Math.max(followed[0], bounds.x), bounds.x + bounds.width),
    Math.min(Math.max(followed[1], bounds.y), bounds.y + bounds.height),
  ];

  let cursorState: FrameState["cursor"] = null;
  let tip: [number, number] | null = null;
  if (!raw.empty) tip = cursor.at(t);
  if (project.cursor.visible && !take.cursorInVideo && tip) {
    const [rawX, rawY] = raw.at(t);
    // Off the captured area (outside a recorded window or the crop): hide instead of pinning to the edge.
    const inside = rawX >= bounds.x - 4 && rawY >= bounds.y - 4 && rawX <= bounds.x + bounds.width + 4 && rawY <= bounds.y + bounds.height + 4;
    if (inside) {
      const press = clicks.find((click) => t - click.t >= 0 && t - click.t < PRESS);
      const squeeze = press ? 1 - 0.18 * Math.sin((Math.PI * (t - press.t)) / PRESS) : 1;
      cursorState = { x: tip[0], y: tip[1], scale: project.cursor.size * squeeze, kind: cursorKindAt(scene.shapes, t) };
    }
  }

  const out = { width: output.width, height: output.height };
  let webcam: FrameState["webcam"] = null;
  if (take.webcam && project.webcam.visible) {
    const short = Math.min(out.width, out.height);
    const size = project.webcam.size * short;
    const margin = short * 0.04;
    const corner = project.webcam.corner;
    webcam = {
      shape: project.webcam.shape,
      rect: {
        x: corner.endsWith("l") ? margin : out.width - margin - size,
        y: corner.startsWith("t") ? margin : out.height - margin - size,
        width: size,
        height: size,
      },
    };
  }

  return {
    output: out,
    video,
    crop,
    background: {
      kind: project.background.kind,
      from: preset.from,
      to: preset.to,
      angle: preset.angle,
      padding: project.background.padding,
      radius: project.background.radius,
      shadow: project.background.shadow,
    },
    frame: project.frame,
    tilt: project.tilt,
    zoom,
    focus,
    cursor: cursorState,
    clicks: project.cursor.clickEffect
      ? clicks.map((click) => ({ x: click.x, y: click.y, age: t - click.t })).filter((click) => click.age >= 0 && click.age < CLICK_EFFECT)
      : [],
    spotlight: project.cursor.spotlight && !raw.empty ? spotlightAt(clicks, t) * 0.85 : 0,
    lens:
      lensSegment && tip
        ? { x: tip[0], y: tip[1], magnification: lensSegment.scale, amount: (lensLevel - 1) / Math.max(0.001, lensSegment.scale - 1) }
        : null,
    blurs: project.blurs.filter((blur) => t >= blur.start && t <= blur.end),
    webcam,
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
    const recent = scene.keys.filter((key) => key.t <= t && t - key.t < KEY_HOLD);
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
    const deleted = new Set(project.deletedWords);
    const words = scene.words.filter((word) => !deleted.has(word.i));
    // Lines: up to CAPTION_WORDS words, broken at pauses.
    let line: Word[] = [];
    for (const word of words) {
      const previous = line[line.length - 1];
      if (line.length && (line.length >= CAPTION_WORDS || word.t0 - previous.t1 > CAPTION_GAP)) {
        if (t >= line[0].t0 && t <= previous.t1 + 400) break;
        line = [];
      }
      line.push(word);
    }
    if (line.length && t >= line[0].t0 && t <= line[line.length - 1].t1 + 400) {
      caption = { words: line, current: line.findIndex((word) => t >= word.t0 && t <= word.t1) };
    }
  }
  return { keys, caption, notes };
}

/** Output size helper that accounts for the crop. */
export const sceneSource = (scene: Scene) => sourceSize(scene.project, scene.take);
