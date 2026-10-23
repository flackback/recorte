import type { CursorEvent, Take } from "../types";

/** A stretch of the source timeline, in ms. */
export type Range = { id: string; start: number; end: number };
/** Shown zoomed in; `lens` magnifies around the cursor instead of moving the camera. */
export type ZoomSegment = Range & { scale: number; mode: "zoom" | "lens" };
/** Blurred area of the recording, in video pixels, over a time range. */
export type BlurRegion = Range & { x: number; y: number; width: number; height: number };
/** Played faster, without sound (typing, loading screens). */
export type SpeedRange = Range & { rate: number };
export const SPEEDS = [1.5, 2, 4, 8];

/** Effects played across the seam a cut leaves: the clip before goes out, the clip after comes in. */
export type TransitionKind = "fade" | "zoomblur" | "flip" | "burn" | "dissolve" | "wave";
export type Transition = { kind: TransitionKind; durationMs: number };
export const TRANSITIONS: { id: TransitionKind; name: string }[] = [
  { id: "fade", name: "Esmaecer" },
  { id: "zoomblur", name: "Zoom com desfoque" },
  { id: "flip", name: "Girar" },
  { id: "burn", name: "Queimar" },
  { id: "dissolve", name: "Desintegrar" },
  { id: "wave", name: "Onda" },
];
export const DEFAULT_TRANSITION: Transition = { kind: "zoomblur", durationMs: 700 };
/**
 * A removed stretch; the seam it leaves can carry a transition. A cut with `end === start` is a
 * split: it removes nothing and only marks a seam (the time map ignores it).
 */
export type Cut = Range & { transition?: Transition };

export const isSplit = (cut: Range) => cut.end <= cut.start;

/**
 * Folds splits that sit inside or on the edge of a real cut into it: the cut's seam replaces
 * theirs, and it takes over a split's transition when it has none.
 */
export function absorbSplits(cuts: Cut[]): Cut[] {
  const real = cuts.filter((cut) => !isSplit(cut));
  const splits = cuts.filter(isSplit);
  const inside = (split: Cut, cut: Cut) => split.start >= cut.start && split.start <= cut.end;
  const free = splits.filter((split) => !real.some((cut) => inside(split, cut)));
  if (free.length === splits.length) return cuts;
  const merged = real.map((cut) => {
    if (cut.transition) return cut;
    const transition = splits.find((split) => split.transition && inside(split, cut))?.transition;
    return transition ? { ...cut, transition } : cut;
  });
  return [...merged, ...free].sort((a, b) => a.start - b.start);
}

/** Adds cuts, merging them with cuts they touch; a merged cut keeps one of their transitions. */
export function mergeCuts(cuts: Cut[], added: { start: number; end: number }[]): Cut[] {
  let result = cuts.filter((cut) => !isSplit(cut));
  for (const range of added) {
    const touching = result.filter((cut) => cut.start <= range.end && cut.end >= range.start);
    const start = Math.min(range.start, ...touching.map((cut) => cut.start));
    const end = Math.max(range.end, ...touching.map((cut) => cut.end));
    const transition = touching.find((cut) => cut.transition)?.transition;
    // The first touched cut keeps its id.
    result = [...result.filter((cut) => !touching.includes(cut)), { id: touching[0]?.id ?? newId(), start, end, ...(transition ? { transition } : {}) }];
  }
  return absorbSplits([...result, ...cuts.filter(isSplit)].sort((a, b) => a.start - b.start));
}

export type CursorStyle = "classic" | "light" | "dot" | "pizza" | "melon" | "rocket";
export const CURSOR_STYLES: { id: CursorStyle; name: string }[] = [
  { id: "classic", name: "Clássico" },
  { id: "light", name: "Claro" },
  { id: "dot", name: "Ponto" },
  { id: "pizza", name: "Pizza" },
  { id: "melon", name: "Melancia" },
  { id: "rocket", name: "Foguete" },
];
export type ClickStyle = "ring" | "liquid";
export type ClickTone = "tick" | "soft" | "mech";
export const CLICK_TONES: { id: ClickTone; name: string }[] = [
  { id: "tick", name: "Clique" },
  { id: "soft", name: "Suave" },
  { id: "mech", name: "Mecânico" },
];

export type NoteKind = "text" | "arrow" | "box";
/**
 * Text, arrow or highlight box drawn over the finished frame, so it stays put while the camera
 * zooms. Position and size are fractions (0–1) of the output frame. An arrow crosses its box
 * toward `direction`.
 */
export type Note = Range & {
  kind: NoteKind;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  size: number;
  direction: "se" | "sw" | "ne" | "nw";
};
/** A title screen before or after the video, on the same background as the style. */
export type TitleCard = { enabled: boolean; title: string; subtitle: string; durationMs: number };

/** How long a title card lasts; 0 when it is off or has no text. */
export const cardLength = (card: TitleCard) => (card.enabled && (card.title.trim() || card.subtitle.trim()) ? card.durationMs : 0);

export const NOTE_COLORS = ["#ffffff", "#ffd60a", "#ff453a", "#30d158", "#0a84ff"];

export function newNote(range: Range, kind: NoteKind = "text"): Note {
  const area = kind === "text" ? { x: 0.25, y: 0.07, width: 0.5, height: 0.12 } : kind === "box" ? { x: 0.35, y: 0.35, width: 0.3, height: 0.3 } : { x: 0.3, y: 0.3, width: 0.18, height: 0.18 };
  return { ...range, kind, ...area, text: kind === "text" ? "Seu texto aqui" : "", color: kind === "text" ? "#ffffff" : "#ffd60a", size: 1, direction: "se" };
}
export type Rect = { x: number; y: number; width: number; height: number };

export type Aspect = "auto" | "16:9" | "9:16" | "1:1" | "4:3";
export type Frame = "none" | "window";
export type Corner = "br" | "bl" | "tr" | "tl";

/** Everything the user changed about a take, saved as `project.json` next to it. */
export type Project = {
  version: 2;
  trim: { start: number; end: number };
  /** Ranges removed from the middle of the take. */
  cuts: Cut[];
  /** Words removed in the transcript; their time ranges are cut too. */
  deletedWords: number[];
  aspect: Aspect;
  /** Part of the recording to keep, in video pixels; null keeps all of it. */
  crop: Rect | null;
  background: {
    kind: "gradient" | "image";
    preset: string;
    /** File name inside the take folder. */
    image: string | null;
    blur: number;
    padding: number;
    radius: number;
    shadow: number;
  };
  frame: Frame;
  /** 3D tilt of the screen in degrees; 0 is flat. */
  tilt: number;
  cursor: {
    visible: boolean;
    size: number;
    smoothing: number;
    style: CursorStyle;
    /** Fades the cursor out after it rests this long (ms); 0 never hides it. */
    hideIdle: number;
    /** Glides back to where it started at the end, for videos that loop. */
    returnHome: boolean;
    /** Hand and text-beam changes shorter than this (ms) are skipped, so passing over links doesn't flicker. */
    shapeDelay: number;
    clickEffect: boolean;
    clickStyle: ClickStyle;
    clickSize: number;
    spotlight: boolean;
  };
  keys: { visible: boolean; mode: "shortcuts" | "all" };
  webcam: { visible: boolean; size: number; corner: Corner; shape: "circle" | "rounded" };
  audio: {
    system: number;
    mic: number;
    /** File name inside the take folder. */
    music: string | null;
    musicVolume: number;
    clickSound: boolean;
    clickTone: ClickTone;
    keySound: boolean;
    enhance: boolean;
  };
  captions: { visible: boolean; size: number; position: "bottom" | "top" };
  zoom: { defaultScale: number; segments: ZoomSegment[] };
  blurs: BlurRegion[];
  speed: SpeedRange[];
  notes: Note[];
  cards: { intro: TitleCard; outro: TitleCard };
};

export type BackgroundPreset = { id: string; name: string; from: string; to: string; angle: number };

export const BACKGROUNDS: BackgroundPreset[] = [
  { id: "aurora", name: "Aurora", from: "#5b8cff", to: "#b65bff", angle: 35 },
  { id: "sunset", name: "Pôr do sol", from: "#ff7a59", to: "#ffcc4d", angle: 120 },
  { id: "ocean", name: "Oceano", from: "#0f9b8e", to: "#2a5cff", angle: 60 },
  { id: "rose", name: "Rosa", from: "#ff5f9e", to: "#ffb199", angle: 20 },
  { id: "forest", name: "Floresta", from: "#1e5b3a", to: "#7fd18b", angle: 150 },
  { id: "night", name: "Noite", from: "#141e30", to: "#35577d", angle: 90 },
  { id: "peach", name: "Pêssego", from: "#f6d5c3", to: "#c8a2e8", angle: 45 },
  { id: "mint", name: "Menta", from: "#b8f2e6", to: "#5e9cf2", angle: 135 },
  { id: "graphite", name: "Grafite", from: "#2b2b30", to: "#2b2b30", angle: 0 },
  { id: "paper", name: "Papel", from: "#ecebe6", to: "#ecebe6", angle: 0 },
  { id: "black", name: "Preto", from: "#000000", to: "#000000", angle: 0 },
  { id: "white", name: "Branco", from: "#ffffff", to: "#ffffff", angle: 0 },
];

export const ASPECTS: { id: Aspect; name: string }[] = [
  { id: "auto", name: "Original" },
  { id: "16:9", name: "16:9" },
  { id: "9:16", name: "9:16" },
  { id: "1:1", name: "1:1" },
  { id: "4:3", name: "4:3" },
];

/** Size of the part of the recording that is kept, after cropping. */
export function sourceSize(project: Pick<Project, "crop">, take: Pick<Take, "width" | "height">) {
  return project.crop ? { width: project.crop.width, height: project.crop.height } : { width: take.width, height: take.height };
}

/** Output size in pixels for an aspect, with the long side at `longSide` (1920 = 1080p). */
export function outputSize(
  aspect: Aspect,
  source: { width: number; height: number },
  longSide = 1920,
): { width: number; height: number } {
  const ratio = aspect === "auto" ? source.width / source.height : (() => {
    const [w, h] = aspect.split(":").map(Number);
    return w / h;
  })();
  const even = (value: number) => Math.round(value / 2) * 2;
  // H.264 needs even sizes, so an odd long side (1279) is rounded too.
  const side = even(longSide);
  return ratio >= 1 ? { width: side, height: even(side / ratio) } : { width: even(side * ratio), height: side };
}

let nextId = 0;
export const newId = () => `r${Date.now().toString(36)}${(nextId++).toString(36)}`;

const MIN_RANGE = 1200;

/**
 * Adds a range of about `length` ms centered on `center`, shrunk to fit the free space between its
 * neighbors so ranges on one track never overlap. Returns the id of the new range, or of the
 * existing one under `center` when there is no room.
 */
export function insertRange<T extends Range>(
  ranges: T[],
  center: number,
  length: number,
  duration: number,
  make: (range: Range) => T,
): { ranges: T[]; id: string; created: boolean } {
  const under = ranges.find((range) => center >= range.start && center <= range.end);
  if (under) return { ranges, id: under.id, created: false };
  const before = Math.max(0, ...ranges.filter((range) => range.end <= center).map((range) => range.end));
  const after = Math.min(duration, ...ranges.filter((range) => range.start >= center).map((range) => range.start));
  let start = Math.max(before, center - length / 2);
  const end = Math.min(after, start + length);
  start = Math.max(before, end - length);
  if (end - start < Math.min(MIN_RANGE, length) / 2) {
    const nearest = [...ranges].sort((a, b) => Math.abs((a.start + a.end) / 2 - center) - Math.abs((b.start + b.end) / 2 - center))[0];
    return { ranges, id: nearest?.id ?? "", created: false };
  }
  const range = make({ id: newId(), start, end });
  return { ranges: [...ranges, range].sort((a, b) => a.start - b.start), id: range.id, created: true };
}

/** Clicks closer together than this belong to the same zoom. */
const CLICK_GAP = 2500;
/** The zoom starts this long before the first click, so it has landed when the click happens. */
const LEAD_IN = 700;
/** And holds this long after the last one. */
const HOLD = 1800;
/** Zooms separated by less than this are merged instead of zooming out and back in. */
const MERGE_GAP = 900;

/** Suggests zoom segments around groups of left clicks. */
export function autoZooms(events: CursorEvent[], duration: number, scale: number): ZoomSegment[] {
  const clicks = events.filter((event) => event.k === "d" && event.b === "l").map((event) => event.t);
  const segments: ZoomSegment[] = [];
  let groupStart = -1;
  let groupEnd = -1;

  const flush = () => {
    if (groupStart < 0) return;
    const start = Math.max(0, groupStart - LEAD_IN);
    let end = Math.min(duration, groupEnd + HOLD);
    if (end - start < MIN_RANGE) end = Math.min(duration, start + MIN_RANGE);
    const previous = segments[segments.length - 1];
    if (previous && start - previous.end < MERGE_GAP) previous.end = Math.max(previous.end, end);
    else segments.push({ id: newId(), start, end, scale, mode: "zoom" });
  };

  for (const t of clicks) {
    if (groupStart >= 0 && t - groupEnd > CLICK_GAP) {
      flush();
      groupStart = -1;
    }
    if (groupStart < 0) groupStart = t;
    groupEnd = t;
  }
  flush();
  return segments;
}

export function defaultProject(take: Take, events: CursorEvent[]): Project {
  const defaultScale = 2;
  return {
    version: 2,
    trim: { start: 0, end: take.durationMs },
    // Stretches paused while recording start out cut.
    cuts: (take.pauses ?? []).filter((pause) => pause.end > pause.start).map((pause) => ({ id: newId(), start: pause.start, end: pause.end })),
    deletedWords: [],
    aspect: "auto",
    crop: take.crop ?? null,
    background: { kind: "gradient", preset: "aurora", image: null, blur: 0, padding: 0.07, radius: 14, shadow: 0.6 },
    frame: "none",
    tilt: 0,
    cursor: {
      visible: !take.cursorInVideo,
      size: 1.4,
      smoothing: 0.6,
      style: "classic",
      hideIdle: 0,
      returnHome: false,
      shapeDelay: 300,
      clickEffect: true,
      clickStyle: "ring",
      clickSize: 1,
      spotlight: false,
    },
    keys: { visible: Boolean(take.keys), mode: "shortcuts" },
    webcam: { visible: Boolean(take.webcam), size: 0.22, corner: "br", shape: "circle" },
    audio: { system: 1, mic: 1, music: null, musicVolume: 0.25, clickSound: false, clickTone: "tick", keySound: false, enhance: false },
    captions: { visible: false, size: 1, position: "bottom" },
    zoom: { defaultScale, segments: autoZooms(events, take.durationMs, defaultScale) },
    blurs: [],
    speed: [],
    notes: [],
    cards: {
      intro: { enabled: false, title: take.title || "", subtitle: "", durationMs: 2500 },
      outro: { enabled: false, title: "Obrigado por assistir", subtitle: "", durationMs: 2500 },
    },
  };
}

/** Fills in anything an older or hand-edited `project.json` lacks. */
export function normalizeProject(raw: unknown, fallback: Project): Project {
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as Partial<Project>;
  const duration = fallback.trim.end;
  const start = Math.min(Math.max(0, value.trim?.start ?? 0), duration);
  const end = Math.min(Math.max(start, value.trim?.end ?? duration), duration);
  const list = <T>(items: T[] | undefined, fallbackItems: T[]) => (Array.isArray(items) ? items : fallbackItems);
  return {
    version: 2,
    trim: { start, end: end > start ? end : duration },
    cuts: list(value.cuts, []),
    deletedWords: list(value.deletedWords, []),
    aspect: ASPECTS.some((aspect) => aspect.id === value.aspect) ? value.aspect! : fallback.aspect,
    crop: value.crop ?? null,
    background: { ...fallback.background, ...value.background },
    // The laptop frame was removed; such projects show the recording without a frame.
    frame: value.frame === "window" || value.frame === "none" ? value.frame : fallback.frame,
    tilt: value.tilt ?? fallback.tilt,
    cursor: { ...fallback.cursor, ...value.cursor },
    keys: { ...fallback.keys, ...value.keys },
    webcam: { ...fallback.webcam, ...value.webcam },
    audio: { ...fallback.audio, ...value.audio },
    captions: { ...fallback.captions, ...value.captions },
    zoom: {
      defaultScale: value.zoom?.defaultScale ?? fallback.zoom.defaultScale,
      // Version 1 segments had no mode.
      segments: list(value.zoom?.segments, fallback.zoom.segments).map((segment) => ({ ...segment, mode: segment.mode ?? "zoom" })),
    },
    blurs: list(value.blurs, []),
    speed: list(value.speed, []),
    notes: list(value.notes, []),
    cards: {
      intro: { ...fallback.cards.intro, ...value.cards?.intro },
      outro: { ...fallback.cards.outro, ...value.cards?.outro },
    },
  };
}

/** A ready-made look: one click sets framing, background, cursor and click effects together. */
export type Style = {
  id: string;
  name: string;
  description: string;
  apply: (project: Project) => void;
  /** Whether the project currently looks like this style (to mark its card). */
  matches: (project: Project) => boolean;
};

function look(values: {
  preset: string;
  padding: number;
  radius: number;
  shadow: number;
  aspect: Aspect;
  frame: Frame;
  tilt: number;
  cursor: number;
  clickEffect: boolean;
  spotlight: boolean;
  zoom: number;
}): Pick<Style, "apply" | "matches"> {
  return {
    apply(project) {
      project.background = { ...project.background, kind: "gradient", preset: values.preset, padding: values.padding, radius: values.radius, shadow: values.shadow };
      project.aspect = values.aspect;
      project.frame = values.frame;
      project.tilt = values.tilt;
      project.cursor = { ...project.cursor, size: values.cursor, clickEffect: values.clickEffect, spotlight: values.spotlight };
      project.zoom.defaultScale = values.zoom;
    },
    matches(project) {
      const b = project.background;
      return (
        b.kind === "gradient" &&
        b.preset === values.preset &&
        Math.abs(b.padding - values.padding) < 0.001 &&
        b.radius === values.radius &&
        Math.abs(b.shadow - values.shadow) < 0.001 &&
        project.aspect === values.aspect &&
        project.frame === values.frame &&
        project.tilt === values.tilt
      );
    },
  };
}

export const STYLES: Style[] = [
  {
    id: "tutorial",
    name: "Tutorial",
    description: "Degradê suave, cursor maior e anel nos cliques",
    ...look({ preset: "aurora", padding: 0.07, radius: 14, shadow: 0.6, aspect: "auto", frame: "none", tilt: 0, cursor: 1.4, clickEffect: true, spotlight: false, zoom: 2 }),
  },
  {
    id: "vertical",
    name: "Vertical",
    description: "9:16 para Reels, Shorts e TikTok, com zoom mais forte",
    ...look({ preset: "sunset", padding: 0.04, radius: 18, shadow: 0.5, aspect: "9:16", frame: "none", tilt: 0, cursor: 1.6, clickEffect: true, spotlight: false, zoom: 2.4 }),
  },
  {
    id: "minimal",
    name: "Minimalista",
    description: "Fundo claro, sombra leve e sem efeitos de clique",
    ...look({ preset: "paper", padding: 0.05, radius: 10, shadow: 0.25, aspect: "auto", frame: "none", tilt: 0, cursor: 1.2, clickEffect: false, spotlight: false, zoom: 1.8 }),
  },
  {
    id: "presentation",
    name: "Apresentação",
    description: "Moldura de janela, fundo escuro e destaque ao clicar",
    ...look({ preset: "night", padding: 0.09, radius: 12, shadow: 0.7, aspect: "16:9", frame: "window", tilt: 0, cursor: 1.5, clickEffect: true, spotlight: true, zoom: 2 }),
  },
  {
    id: "product",
    name: "Perspectiva",
    description: "Tela inclinada em 3D, com sombra forte",
    ...look({ preset: "ocean", padding: 0.1, radius: 14, shadow: 0.8, aspect: "16:9", frame: "none", tilt: 10, cursor: 1.4, clickEffect: true, spotlight: false, zoom: 2 }),
  },
  {
    id: "plain",
    name: "Sem efeitos",
    description: "Só a gravação, sem fundo, cantos nem sombra",
    ...look({ preset: "black", padding: 0, radius: 0, shadow: 0, aspect: "auto", frame: "none", tilt: 0, cursor: 1, clickEffect: false, spotlight: false, zoom: 2 }),
  },
];
