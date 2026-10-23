import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { DEFAULT_DRAW, DRAW_TOOLS, FADE_AFTER, FADE_OUT, type DrawConfig, type DrawTool } from "./draw";

/**
 * The transparent overlay window. In "area" mode the user drags the region to record; in "draw"
 * mode it shows what is drawn on the screen while recording (and is captured with it). The tools
 * live in the floating bar, which stays out of the video; this window only draws.
 */

const mode = new URLSearchParams(location.search).get("mode") === "draw" ? "draw" : "area";
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const context = canvas.getContext("2d")!;
const ratio = window.devicePixelRatio || 1;
const appWindow = getCurrentWindow();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function resize() {
  canvas.width = Math.round(innerWidth * ratio);
  canvas.height = Math.round(innerHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  still.width = canvas.width;
  still.height = canvas.height;
  stillContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  stillDirty = true;
  draw();
}

// ---------- area ----------

type Rect = { x: number; y: number; width: number; height: number };
/** Starts from the area chosen before, if any (given in physical pixels). */
let area: Rect | null = (() => {
  const values = new URLSearchParams(location.search).get("area")?.split(",").map(Number);
  if (!values || values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
  const [x, y, width, height] = values.map((value) => value / (window.devicePixelRatio || 1));
  return { x, y, width, height };
})();
let dragFrom: { x: number; y: number } | null = null;
/** The area before the current drag, restored when the drag is too small to use. */
let areaBefore: Rect | null = null;
const MIN_AREA = 16;

function drawArea() {
  context.clearRect(0, 0, innerWidth, innerHeight);
  context.fillStyle = "rgba(0, 0, 0, 0.55)";
  context.fillRect(0, 0, innerWidth, innerHeight);
  const size = document.getElementById("size")!;
  if (!area) {
    size.hidden = true;
    return;
  }
  context.clearRect(area.x, area.y, area.width, area.height);
  context.strokeStyle = "#ffffff";
  context.lineWidth = 2;
  context.strokeRect(area.x, area.y, area.width, area.height);
  size.hidden = false;
  size.textContent = `${Math.round(area.width * ratio)} × ${Math.round(area.height * ratio)}`;
  size.style.left = `${area.x}px`;
  size.style.top = `${Math.max(4, area.y - 26)}px`;
}

async function confirmArea(full: boolean) {
  const usable = area && area.width >= MIN_AREA && area.height >= MIN_AREA ? area : null;
  // "Gravar área" with no area keeps the picker open; only "Tela inteira" records the whole screen.
  if (!full && !usable) return;
  const rect = full ? null : usable;
  // Physical pixels relative to the monitor, which is what the recording uses.
  await emit("area-selected", rect && {
    x: Math.round(rect.x * ratio),
    y: Math.round(rect.y * ratio),
    width: Math.round((rect.width * ratio) / 2) * 2,
    height: Math.round((rect.height * ratio) / 2) * 2,
  });
  await appWindow.close();
}

async function cancelArea() {
  await emit("area-cancelled", null);
  await appWindow.close();
}

// ---------- drawing ----------

type Point = { x: number; y: number };
type Shape = {
  tool: Exclude<DrawTool, "mouse">;
  color: string;
  width: number;
  points: Point[];
  text?: string;
  /** When it was finished, for "sumir sozinho"; null keeps it. */
  fadeFrom: number | null;
  /** When it was finished; unset while it is being drawn. */
  doneAt?: number;
};

const shapes: Shape[] = [];
let current: Shape | null = null;
let config: DrawConfig = { ...DEFAULT_DRAW };
let shift = false;
let frameRequested = false;
const textInput = document.getElementById("text-input") as HTMLInputElement;
let textAt: Point | null = null;

const textSize = (width: number) => 14 + width * 3.4;

/** Dashed arrows march this long after they are drawn, then rest. */
const DASH_MARCH = 4000;
/** Finished shapes that no longer change, painted once into this layer and copied each frame. */
const still = document.createElement("canvas");
const stillContext = still.getContext("2d")!;
let stillShapes: Shape[] = [];
let stillDirty = true;

/** Lines snap to 45° steps, and boxes to squares and circles, while Shift is held. */
function constrain(tool: Shape["tool"], from: Point, to: Point): Point {
  if (!shift) return to;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (tool === "rect" || tool === "ellipse") {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: from.x + Math.sign(dx || 1) * side, y: from.y + Math.sign(dy || 1) * side };
  }
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const length = Math.hypot(dx, dy);
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

function arrowHead(context: CanvasRenderingContext2D, from: Point, to: Point, width: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = 10 + width * 2.6;
  context.beginPath();
  context.moveTo(to.x, to.y);
  context.lineTo(to.x - head * Math.cos(angle - 0.42), to.y - head * Math.sin(angle - 0.42));
  context.lineTo(to.x - head * Math.cos(angle + 0.42), to.y - head * Math.sin(angle + 0.42));
  context.closePath();
  context.fill();
  return { x: to.x - Math.cos(angle) * head * 0.7, y: to.y - Math.sin(angle) * head * 0.7 };
}

function paintShape(context: CanvasRenderingContext2D, shape: Shape, now: number) {
  const points = shape.points;
  const first = points[0];
  const last = points[points.length - 1];
  let alpha = shape.tool === "marker" ? 0.35 : 1;
  if (shape.fadeFrom !== null) alpha *= Math.max(0, Math.min(1, 1 - (now - shape.fadeFrom - FADE_AFTER) / FADE_OUT));
  if (alpha <= 0) return;

  context.save();
  context.globalAlpha = alpha;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = shape.color;
  context.fillStyle = shape.color;
  context.lineWidth = shape.tool === "marker" ? shape.width * 4.5 : shape.width;
  // A soft shadow keeps strokes readable on any background.
  context.shadowColor = "rgba(0, 0, 0, 0.35)";
  context.shadowBlur = shape.tool === "marker" ? 0 : 6;

  if (shape.tool === "text") {
    context.font = `700 ${textSize(shape.width)}px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`;
    context.textBaseline = "top";
    context.shadowBlur = 8;
    context.fillText(shape.text ?? "", first.x, first.y);
  } else if (points.length >= 2) {
    if (shape.tool === "rect") {
      context.beginPath();
      context.roundRect(Math.min(first.x, last.x), Math.min(first.y, last.y), Math.abs(last.x - first.x), Math.abs(last.y - first.y), 8);
      context.stroke();
    } else if (shape.tool === "ellipse") {
      context.beginPath();
      context.ellipse((first.x + last.x) / 2, (first.y + last.y) / 2, Math.abs(last.x - first.x) / 2, Math.abs(last.y - first.y) / 2, 0, 0, Math.PI * 2);
      context.stroke();
    } else if (shape.tool === "line") {
      context.beginPath();
      context.moveTo(first.x, first.y);
      context.lineTo(last.x, last.y);
      context.stroke();
    } else if (shape.tool === "arrow" || shape.tool === "dashed") {
      const neck = arrowHead(context, first, last, shape.width);
      if (shape.tool === "dashed") {
        context.setLineDash([shape.width * 2.4, shape.width * 2]);
        // The dashes march toward the tip, so the eye follows where it points.
        // They stop where the march ended, so the still layer matches the last moving frame.
        const time = shape.doneAt === undefined ? now : Math.min(now, shape.doneAt + DASH_MARCH);
        if (!reducedMotion) context.lineDashOffset = -((time / 30) % (shape.width * 4.4));
      }
      context.beginPath();
      context.moveTo(first.x, first.y);
      context.lineTo(neck.x, neck.y);
      context.stroke();
    } else {
      // Pen and marker: smoothed through the midpoints between samples.
      context.beginPath();
      context.moveTo(first.x, first.y);
      for (let index = 1; index < points.length - 1; index++) {
        const middle = { x: (points[index].x + points[index + 1].x) / 2, y: (points[index].y + points[index + 1].y) / 2 };
        context.quadraticCurveTo(points[index].x, points[index].y, middle.x, middle.y);
      }
      context.lineTo(last.x, last.y);
      context.stroke();
    }
  }
  context.restore();
}

function drawShapes() {
  const now = performance.now();
  // Drawings that have faded out are gone for good.
  for (let index = shapes.length - 1; index >= 0; index--) {
    const fadeFrom = shapes[index].fadeFrom;
    if (fadeFrom !== null && now - fadeFrom > FADE_AFTER + FADE_OUT) shapes.splice(index, 1);
  }
  // Repaint the still layer only when the set of still shapes changes.
  const settled = shapes.filter((shape) => !isLive(shape, now));
  if (stillDirty || settled.length !== stillShapes.length || settled.some((shape, index) => shape !== stillShapes[index])) {
    stillContext.clearRect(0, 0, innerWidth, innerHeight);
    for (const shape of settled) paintShape(stillContext, shape, now);
    stillShapes = settled;
    stillDirty = false;
  }
  context.clearRect(0, 0, innerWidth, innerHeight);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.drawImage(still, 0, 0);
  context.restore();
  for (const shape of shapes) if (isLive(shape, now)) paintShape(context, shape, now);
  if (current) paintShape(context, current, now);
  // Keep animating only while something moves or will move: fading shapes or marching dashes.
  const moving = shapes.some((shape) => shape.fadeFrom !== null || marching(shape, now));
  if (moving) requestFrame();
}

function marching(shape: Shape, now: number) {
  return shape.tool === "dashed" && !reducedMotion && (shape.doneAt === undefined || now - shape.doneAt < DASH_MARCH);
}

/** A shape that changes from frame to frame: marching, or fading out. */
function isLive(shape: Shape, now: number) {
  return marching(shape, now) || (shape.fadeFrom !== null && now - shape.fadeFrom >= FADE_AFTER);
}

function requestFrame() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    draw();
  });
}

function draw() {
  if (mode === "area") drawArea();
  else drawShapes();
}

function finish(shape: Shape) {
  shape.doneAt = performance.now();
  shape.fadeFrom = config.fade ? shape.doneAt : null;
  shapes.push(shape);
}

/** Applies the bar's choices: the mouse passes clicks through to the apps below. */
async function applyConfig(next: DrawConfig) {
  const wasMouse = config.tool === "mouse";
  config = next;
  if (config.tool !== "text") commitText();
  document.body.dataset.tool = config.tool;
  await appWindow.setIgnoreCursorEvents(config.tool === "mouse");
  if (config.tool !== "mouse" && wasMouse) await appWindow.setFocus();
}

// ---------- text ----------

function startText(at: Point) {
  commitText();
  textAt = at;
  textInput.value = "";
  textInput.style.left = `${at.x}px`;
  textInput.style.top = `${at.y}px`;
  textInput.style.color = config.color;
  textInput.style.fontSize = `${textSize(config.width)}px`;
  textInput.hidden = false;
  textInput.focus();
}

function commitText() {
  if (!textAt) return;
  const text = textInput.value.trim();
  if (text) finish({ tool: "text", color: config.color, width: config.width, points: [textAt], text, fadeFrom: null });
  textAt = null;
  textInput.hidden = true;
  draw();
}

function cancelText() {
  textAt = null;
  textInput.hidden = true;
}

// ---------- wiring ----------

document.body.classList.add(mode);
if (mode === "area") document.getElementById("area-panel")!.hidden = false;
window.addEventListener("resize", resize);
resize();

canvas.addEventListener("pointerdown", (event) => {
  const at = { x: event.clientX, y: event.clientY };
  if (mode === "area") {
    canvas.setPointerCapture(event.pointerId);
    dragFrom = at;
    areaBefore = area;
    area = { ...at, width: 0, height: 0 };
  } else if (config.tool === "text") {
    startText(at);
    event.preventDefault();
    return;
  } else if (config.tool !== "mouse") {
    canvas.setPointerCapture(event.pointerId);
    current = { tool: config.tool, color: config.color, width: config.width, points: [at], fadeFrom: null };
  }
  requestFrame();
});
canvas.addEventListener("pointermove", (event) => {
  const at = { x: event.clientX, y: event.clientY };
  if (mode === "area" && dragFrom) {
    area = { x: Math.min(dragFrom.x, at.x), y: Math.min(dragFrom.y, at.y), width: Math.abs(at.x - dragFrom.x), height: Math.abs(at.y - dragFrom.y) };
  } else if (current) {
    if (current.tool === "pen" || current.tool === "marker") current.points.push(at);
    else current.points = [current.points[0], constrain(current.tool, current.points[0], at)];
  } else {
    return;
  }
  // One paint per frame, however fast the pointer reports.
  requestFrame();
});
canvas.addEventListener("pointerup", () => {
  // A click or a tiny drag keeps the area chosen before, instead of an area too small to record.
  if (mode === "area" && dragFrom && area && (area.width < MIN_AREA || area.height < MIN_AREA)) area = areaBefore;
  dragFrom = null;
  if (current) {
    const [first, last] = [current.points[0], current.points[current.points.length - 1]];
    // A click without dragging leaves nothing behind.
    if (current.points.length > 1 && Math.hypot(last.x - first.x, last.y - first.y) > 3) finish(current);
    current = null;
  }
  requestFrame();
});
canvas.addEventListener("dblclick", () => {
  if (mode === "area") void confirmArea(false);
});

textInput.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Enter") commitText();
  else if (event.key === "Escape") cancelText();
});
textInput.addEventListener("blur", () => commitText());

window.addEventListener("keydown", (event) => {
  shift = event.shiftKey;
  if (mode === "area") {
    if (event.key === "Enter") void confirmArea(false);
    if (event.key === "Escape") void cancelArea();
    return;
  }
  if (event.ctrlKey && event.key.toLowerCase() === "z") {
    shapes.pop();
    draw();
    return;
  }
  if (event.key === "Delete") {
    shapes.length = 0;
    draw();
    return;
  }
  // Tool keys go through the bar, which owns the choice and shows it.
  const key = event.key === "Escape" ? "Esc" : event.key.toUpperCase();
  const tool = DRAW_TOOLS.find((candidate) => candidate.key === key);
  if (tool) void emit("draw-request", { tool: tool.id });
});
window.addEventListener("keyup", (event) => (shift = event.shiftKey));

if (mode === "draw") {
  void listen<DrawConfig>("draw-config", (event) => void applyConfig(event.payload));
  void listen("draw-undo", () => {
    shapes.pop();
    draw();
  });
  void listen("draw-clear", () => {
    shapes.length = 0;
    draw();
  });
  // Starts passing clicks through until the bar says which tool is on.
  void appWindow.setIgnoreCursorEvents(true);
  void emit("overlay-ready", null);
} else {
  document.getElementById("area-ok")!.addEventListener("click", () => void confirmArea(false));
  document.getElementById("area-full")!.addEventListener("click", () => void confirmArea(true));
  void appWindow.setFocus();
}
