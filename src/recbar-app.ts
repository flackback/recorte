import { invoke } from "@tauri-apps/api/core";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { DEFAULT_DRAW, DRAW_COLORS, DRAW_TOOLS, DRAW_WIDTHS, type DrawConfig, type DrawTool } from "./draw";
import { levelFill, type Levels } from "./types";

/**
 * The floating bar shown while recording. It shows state, sends the user's choices to the main
 * window (which owns the recording), and owns the drawing tools: the overlay only draws what
 * this bar tells it.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const appWindow = getCurrentWindow();
const ui = {
  shell: $("shell"),
  status: $("status"),
  time: $("time"),
  pause: $<HTMLButtonElement>("pause"),
  mark: $<HTMLButtonElement>("mark"),
  draw: $<HTMLButtonElement>("draw"),
  drawIcon: $("draw-icon"),
  drawLabel: $("draw-label"),
  stop: $<HTMLButtonElement>("stop"),
  redo: $<HTMLButtonElement>("redo"),
  redoLabel: $("redo-label"),
  levels: $("levels"),
  levelSystem: $("level-system"),
  levelMic: $("level-mic"),
  tray: $("tray"),
  tools: $("tools"),
  indicator: $("indicator"),
  colors: $("colors"),
  widths: $("widths"),
  fade: $<HTMLButtonElement>("fade"),
  undo: $<HTMLButtonElement>("undo"),
  clear: $<HTMLButtonElement>("clear"),
};

const SETTINGS_KEY = "recorte.draw";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const EXIT_MS = reducedMotion ? 0 : 130;

let paused = false;
/** What the pause button shows now; null until the first state arrives. */
let shownPaused: boolean | null = null;
/** While set, the time shows "Marca n" instead of the elapsed time. */
let flashUntil = 0;

// ---------- drawing state ----------

/** Color, thickness and "sumir sozinho" are remembered; every recording starts with the mouse. */
function loadConfig(): DrawConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<DrawConfig> | null;
    if (saved) return { ...DEFAULT_DRAW, ...saved, tool: "mouse" };
  } catch {
    // Storage blocked or corrupt: use the defaults.
  }
  return { ...DEFAULT_DRAW };
}

const config = loadConfig();
/** The tool to come back to when the tray opens again. */
let lastTool: DrawTool = "pen";

function saveConfig() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ color: config.color, width: config.width, fade: config.fade }));
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

function broadcast() {
  void emit("draw-config", config);
}

function format(ms: number) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

/** Sizes the window to the bar (and tray), keeping it centered where it is. */
async function fit() {
  const rect = ui.shell.getBoundingClientRect();
  const [scale, position, size] = await Promise.all([appWindow.scaleFactor(), appWindow.outerPosition(), appWindow.outerSize()]);
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  const newWidth = Math.round(width * scale);
  if (newWidth === size.width && Math.round(height * scale) === size.height) return;
  await appWindow.setSize(new LogicalSize(width, height));
  await appWindow.setPosition(new PhysicalPosition(position.x + Math.round((size.width - newWidth) / 2), position.y));
}

// ---------- moving the bar ----------

/**
 * Drags the bar by its grip or its timer. Done here instead of with a drag region, which does not
 * move this window (it sits above the drawing layer and never takes the focus).
 */
function makeDraggable(handle: HTMLElement) {
  handle.addEventListener("pointerdown", async (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const from = { x: event.screenX, y: event.screenY };
    const ratio = window.devicePixelRatio || 1;
    let origin: { x: number; y: number } | null = null;
    let latest = from;
    let frame = 0;
    const place = () => {
      frame = 0;
      if (!origin) return;
      void appWindow.setPosition(new PhysicalPosition(Math.round(origin.x + (latest.x - from.x) * ratio), Math.round(origin.y + (latest.y - from.y) * ratio)));
    };
    const move = (moveEvent: PointerEvent) => {
      latest = { x: moveEvent.screenX, y: moveEvent.screenY };
      frame ||= requestAnimationFrame(place);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.classList.remove("dragging");
    };
    handle.classList.add("dragging");
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    const position = await appWindow.outerPosition();
    origin = { x: position.x, y: position.y };
    place();
  });
}

// ---------- tray ----------

function buildTray() {
  DRAW_TOOLS.forEach((tool, index) => {
    const button = document.createElement("button");
    button.dataset.tool = tool.id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", tool.name);
    button.title = `${tool.name} (${tool.key})`;
    button.style.setProperty("--i", String(index));
    button.innerHTML = `<svg viewBox="0 0 24 24">${tool.icon}</svg>`;
    button.addEventListener("click", () => setTool(tool.id));
    ui.tools.append(button);
  });
  for (const color of DRAW_COLORS) {
    const button = document.createElement("button");
    button.className = "swatch";
    button.dataset.color = color.id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", color.name);
    button.title = color.name;
    button.style.setProperty("--color", color.id);
    button.innerHTML = "<span></span>";
    button.addEventListener("click", () => {
      config.color = color.id;
      // Picking a color while on the mouse means the user wants to draw.
      if (config.tool === "mouse") setTool(lastTool);
      else update();
    });
    ui.colors.append(button);
  }
  for (const width of DRAW_WIDTHS) {
    const button = document.createElement("button");
    button.className = "width";
    button.dataset.width = String(width.id);
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", width.name);
    button.title = `Espessura: ${width.name.toLowerCase()}`;
    button.style.setProperty("--size", `${4 + width.id}px`);
    button.innerHTML = "<span></span>";
    button.addEventListener("click", () => {
      config.width = width.id;
      update();
    });
    ui.widths.append(button);
  }
}

/** Reflects the config in the tray and the Desenhar button, then tells the overlay. */
function update() {
  for (const button of ui.tools.querySelectorAll<HTMLButtonElement>("[data-tool]")) button.setAttribute("aria-checked", String(button.dataset.tool === config.tool));
  for (const button of ui.colors.querySelectorAll<HTMLButtonElement>("[data-color]")) button.setAttribute("aria-checked", String(button.dataset.color === config.color));
  for (const button of ui.widths.querySelectorAll<HTMLButtonElement>("[data-width]")) button.setAttribute("aria-checked", String(Number(button.dataset.width) === config.width));
  ui.fade.setAttribute("aria-pressed", String(config.fade));
  moveIndicator();

  const tool = DRAW_TOOLS.find((candidate) => candidate.id === config.tool)!;
  const drawingNow = config.tool !== "mouse";
  ui.drawIcon.innerHTML = drawingNow ? tool.icon : DRAW_TOOLS[1].icon;
  ui.drawLabel.textContent = drawingNow ? tool.name : "Desenhar";
  saveConfig();
  broadcast();
  void fit();
}

function moveIndicator() {
  const button = ui.tools.querySelector<HTMLElement>(`[data-tool="${config.tool}"]`);
  if (!button) return;
  ui.indicator.style.transform = `translateX(${button.offsetLeft}px)`;
  ui.indicator.classList.toggle("mouse", config.tool === "mouse");
}

async function setTool(tool: DrawTool) {
  if (tool !== "mouse") {
    lastTool = tool;
    await openTray();
    // The main window opens the overlay on the recorded monitor if it isn't open yet.
    await emit("recbar-action", "draw-open");
  }
  config.tool = tool;
  update();
}

async function openTray() {
  if (!ui.tray.hidden && !ui.tray.classList.contains("leaving")) return;
  ui.tray.classList.remove("leaving");
  ui.tray.hidden = false;
  ui.draw.setAttribute("aria-pressed", "true");
  await fit();
  moveIndicator();
}

/** Hides the tray and goes back to the mouse; drawings stay on screen. */
async function closeTray() {
  if (ui.tray.hidden) return;
  ui.draw.setAttribute("aria-pressed", "false");
  config.tool = "mouse";
  update();
  ui.tray.classList.add("leaving");
  await new Promise((resolve) => setTimeout(resolve, EXIT_MS));
  if (!ui.tray.classList.contains("leaving")) return;
  ui.tray.classList.remove("leaving");
  ui.tray.hidden = true;
  await fit();
}

async function toggleTray() {
  if (ui.tray.hidden) await setTool(lastTool);
  else await closeTray();
}

// ---------- sound levels ----------

/** Sources being recorded, as last told by the main window. */
let audio = { system: false, mic: false };
let levelTimer: number | undefined;
let levelPolling = false;

/** Shows a bar per recorded source, polled ~12 times a second while any is shown. */
function setAudio(next: { system: boolean; mic: boolean }) {
  if (next.system === audio.system && next.mic === audio.mic) return;
  audio = { ...next };
  ui.levelSystem.hidden = !audio.system;
  ui.levelMic.hidden = !audio.mic;
  ui.levels.hidden = !audio.system && !audio.mic;
  window.clearInterval(levelTimer);
  levelTimer = ui.levels.hidden ? undefined : window.setInterval(() => void pollLevels(), 80);
  void fit();
}

async function pollLevels() {
  if (levelPolling) return;
  levelPolling = true;
  try {
    const levels = await invoke<Levels>("audio_levels");
    showLevel(ui.levelSystem, levels.system);
    showLevel(ui.levelMic, levels.mic);
  } catch {
    // The next tick tries again.
  } finally {
    levelPolling = false;
  }
}

/** Moves the bar (transform only); null shows it as off. */
function showLevel(level: HTMLElement, peak: number | null) {
  if (level.hidden) return;
  const off = peak === null;
  if (level.classList.contains("off") !== off) {
    level.classList.toggle("off", off);
    level.title = off ? `${level.dataset.label}: sem sinal do dispositivo` : level.dataset.label!;
  }
  const fill = levelFill(peak);
  level.classList.toggle("loud", fill > 0.92);
  const transform = `scaleY(${fill.toFixed(3)})`;
  const bar = level.querySelector<HTMLElement>("i")!;
  if (bar.style.transform !== transform) bar.style.transform = transform;
}

// ---------- discard and record again ----------

const REDO_TITLE = "Descartar e gravar de novo";
let redoTimer: number | undefined;

/** Back to the plain icon, if it was waiting for the confirming click. */
function disarmRedo() {
  window.clearTimeout(redoTimer);
  if (!ui.redo.classList.contains("confirm")) return;
  ui.redo.classList.remove("confirm");
  ui.redoLabel.hidden = true;
  ui.redo.title = REDO_TITLE;
  ui.redo.setAttribute("aria-label", REDO_TITLE);
  void fit();
}

/** The first click asks; a second one within 3 s throws this take away and records again. */
function clickRedo() {
  if (ui.redo.classList.contains("confirm")) {
    disarmRedo();
    void emit("recbar-action", "redo");
    return;
  }
  ui.redo.classList.add("confirm");
  ui.redoLabel.hidden = false;
  ui.redo.title = "Clique de novo para descartar esta gravação e começar outra";
  ui.redo.setAttribute("aria-label", "Confirmar: descartar e gravar de novo");
  void fit();
  redoTimer = window.setTimeout(disarmRedo, 3000);
}

// ---------- wiring ----------

buildTray();
update();
makeDraggable(document.querySelector<HTMLElement>(".grip")!);
makeDraggable(ui.status);

void listen<{ elapsedMs: number; paused: boolean; audio?: { system: boolean; mic: boolean } }>("recbar-state", (event) => {
  if (event.payload.audio) setAudio(event.payload.audio);
  // The state arrives every 200 ms; touch the button only when it changes.
  if (event.payload.paused !== shownPaused) {
    paused = shownPaused = event.payload.paused;
    ui.status.classList.toggle("paused", paused);
    ui.pause.querySelector("span")!.textContent = paused ? "Continuar" : "Pausar";
    ui.pause.querySelector("svg")!.innerHTML = paused ? '<path d="M8 5.5v13l10.5-6.5z" />' : '<path d="M9 6v12M15 6v12" />';
  }
  if (performance.now() < flashUntil) return;
  ui.time.classList.remove("flash");
  ui.time.textContent = paused ? `Pausado · ${format(event.payload.elapsedMs)}` : format(event.payload.elapsedMs);
});

void listen<number>("recbar-mark", (event) => {
  flashUntil = performance.now() + 1200;
  ui.time.textContent = `Marca ${event.payload}`;
  ui.time.classList.add("flash");
  ui.mark.classList.remove("ring");
  // Restarts the ring animation.
  void ui.mark.offsetWidth;
  ui.mark.classList.add("ring");
});

// The overlay asks for tool changes (keys pressed while drawing) and for the config when it opens.
void listen<{ tool: DrawTool }>("draw-request", (event) => void setTool(event.payload.tool));
void listen("overlay-ready", () => broadcast());
// Ctrl+Shift+D, relayed by the main window.
void listen("draw-toggle", () => void toggleTray());

ui.pause.addEventListener("click", () => void emit("recbar-action", paused ? "resume" : "pause"));
ui.mark.addEventListener("click", () => void emit("recbar-action", "mark"));
ui.draw.addEventListener("click", () => void toggleTray());
ui.stop.addEventListener("click", () => void emit("recbar-action", "stop"));
ui.redo.addEventListener("click", clickRedo);
ui.fade.addEventListener("click", () => {
  config.fade = !config.fade;
  update();
});
ui.undo.addEventListener("click", () => void emit("draw-undo", null));
ui.clear.addEventListener("click", () => void emit("draw-clear", null));
document.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    disarmRedo();
    void setTool("mouse");
  }
});
// Any change in size (pause label, levels, tray, confirm, fonts) refits the window, so the bar is
// never cut. One fit per frame at most.
let fitFrame = 0;
new ResizeObserver(() => {
  fitFrame ||= requestAnimationFrame(() => {
    fitFrame = 0;
    void fit();
  });
}).observe(ui.shell);
void document.fonts.ready.then(() => fit());
