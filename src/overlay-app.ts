import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The transparent overlay window. In "area" mode the user drags the region to record; in "draw"
 * mode they annotate the screen while recording (the drawings are captured with it).
 */

const mode = new URLSearchParams(location.search).get("mode") === "draw" ? "draw" : "area";
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const context = canvas.getContext("2d")!;
const ratio = window.devicePixelRatio || 1;
const appWindow = getCurrentWindow();

function resize() {
  canvas.width = Math.round(innerWidth * ratio);
  canvas.height = Math.round(innerHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}

// ---------- area ----------

type Rect = { x: number; y: number; width: number; height: number };
let area: Rect | null = null;
let dragFrom: { x: number; y: number } | null = null;

function drawArea() {
  context.clearRect(0, 0, innerWidth, innerHeight);
  context.fillStyle = "rgba(0, 0, 0, 0.45)";
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
  const rect = full || !area || area.width < 16 || area.height < 16 ? null : area;
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

/** Tells the main window the overlay went away, then closes it. */
async function closeOverlay() {
  await emit("overlay-closed", null);
  await appWindow.close();
}

// ---------- drawing ----------

type Tool = "pen" | "arrow" | "rect" | "marker";
type Shape = { tool: Tool; color: string; points: { x: number; y: number }[] };
const shapes: Shape[] = [];
let current: Shape | null = null;
let tool: Tool = "pen";
let color = "#ff3b30";
let passThrough = false;

function strokeShape(shape: Shape) {
  const points = shape.points;
  if (points.length < 2) return;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = shape.color;
  context.globalAlpha = shape.tool === "marker" ? 0.35 : 1;
  context.lineWidth = shape.tool === "marker" ? 22 : 5;
  context.shadowColor = "rgba(0, 0, 0, 0.35)";
  context.shadowBlur = shape.tool === "marker" ? 0 : 6;
  const first = points[0];
  const last = points[points.length - 1];
  context.beginPath();
  if (shape.tool === "rect") {
    context.roundRect(Math.min(first.x, last.x), Math.min(first.y, last.y), Math.abs(last.x - first.x), Math.abs(last.y - first.y), 8);
  } else if (shape.tool === "arrow") {
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    const head = 18;
    context.moveTo(first.x, first.y);
    context.lineTo(last.x, last.y);
    context.moveTo(last.x - head * Math.cos(angle - 0.45), last.y - head * Math.sin(angle - 0.45));
    context.lineTo(last.x, last.y);
    context.lineTo(last.x - head * Math.cos(angle + 0.45), last.y - head * Math.sin(angle + 0.45));
  } else {
    context.moveTo(first.x, first.y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  }
  context.stroke();
  context.globalAlpha = 1;
  context.shadowBlur = 0;
}

function drawShapes() {
  context.clearRect(0, 0, innerWidth, innerHeight);
  for (const shape of shapes) strokeShape(shape);
  if (current) strokeShape(current);
}

async function setPassThrough(on: boolean) {
  passThrough = on;
  await appWindow.setIgnoreCursorEvents(on);
  document.getElementById("draw-panel")!.hidden = on;
  if (!on) await appWindow.setFocus();
}

function draw() {
  if (mode === "area") drawArea();
  else drawShapes();
}

// ---------- wiring ----------

document.body.classList.add(mode);
document.getElementById(mode === "area" ? "area-panel" : "draw-panel")!.hidden = false;
window.addEventListener("resize", resize);
resize();

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  if (mode === "area") {
    dragFrom = { x: event.clientX, y: event.clientY };
    area = { x: event.clientX, y: event.clientY, width: 0, height: 0 };
  } else {
    current = { tool, color, points: [{ x: event.clientX, y: event.clientY }] };
  }
  draw();
});
canvas.addEventListener("pointermove", (event) => {
  if (mode === "area" && dragFrom) {
    area = {
      x: Math.min(dragFrom.x, event.clientX),
      y: Math.min(dragFrom.y, event.clientY),
      width: Math.abs(event.clientX - dragFrom.x),
      height: Math.abs(event.clientY - dragFrom.y),
    };
  } else if (current) {
    const point = { x: event.clientX, y: event.clientY };
    if (current.tool === "pen" || current.tool === "marker") current.points.push(point);
    else current.points = [current.points[0], point];
  } else {
    return;
  }
  draw();
});
canvas.addEventListener("pointerup", () => {
  dragFrom = null;
  if (current) {
    if (current.points.length > 1) shapes.push(current);
    current = null;
  }
  draw();
});
canvas.addEventListener("dblclick", () => {
  if (mode === "area") void confirmArea(false);
});

window.addEventListener("keydown", (event) => {
  if (mode === "area") {
    if (event.key === "Enter") void confirmArea(false);
    if (event.key === "Escape") void cancelArea();
    return;
  }
  if (event.key === "Escape") void closeOverlay();
  else if (event.ctrlKey && event.key.toLowerCase() === "z") {
    shapes.pop();
    draw();
  } else if (event.key === "Delete") {
    shapes.length = 0;
    draw();
  } else {
    const keys: Record<string, Tool> = { p: "pen", a: "arrow", r: "rect", m: "marker" };
    const picked = keys[event.key.toLowerCase()];
    if (picked) selectTool(picked);
  }
});

function selectTool(next: Tool) {
  tool = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) button.setAttribute("aria-pressed", String(button.dataset.tool === next));
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) button.addEventListener("click", () => selectTool(button.dataset.tool as Tool));
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-color]")) {
  button.addEventListener("click", () => {
    color = button.dataset.color!;
    for (const other of document.querySelectorAll<HTMLButtonElement>("[data-color]")) other.setAttribute("aria-pressed", String(other === button));
  });
}
document.getElementById("area-ok")!.addEventListener("click", () => void confirmArea(false));
document.getElementById("area-full")!.addEventListener("click", () => void confirmArea(true));
document.getElementById("draw-undo")!.addEventListener("click", () => {
  shapes.pop();
  draw();
});
document.getElementById("draw-clear")!.addEventListener("click", () => {
  shapes.length = 0;
  draw();
});
document.getElementById("draw-pass")!.addEventListener("click", () => void setPassThrough(true));
document.getElementById("draw-close")!.addEventListener("click", () => void closeOverlay());

// The global Ctrl+Shift+D toggles between drawing and clicking through to the apps below.
void listen("overlay-toggle", () => void setPassThrough(!passThrough));
void appWindow.setFocus();
