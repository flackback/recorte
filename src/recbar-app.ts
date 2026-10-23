import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { DEFAULT_DRAW, DRAW_COLORS, DRAW_TOOLS, DRAW_WIDTHS, type DrawConfig, type DrawTool } from "./draw";

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

// ---------- wiring ----------

buildTray();
update();

void listen<{ elapsedMs: number; paused: boolean }>("recbar-state", (event) => {
  paused = event.payload.paused;
  ui.status.classList.toggle("paused", paused);
  ui.pause.querySelector("span")!.textContent = paused ? "Continuar" : "Pausar";
  ui.pause.querySelector("svg")!.innerHTML = paused ? '<path d="M8 5.5v13l10.5-6.5z" />' : '<path d="M9 6v12M15 6v12" />';
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
ui.fade.addEventListener("click", () => {
  config.fade = !config.fade;
  update();
});
ui.undo.addEventListener("click", () => void emit("draw-undo", null));
ui.clear.addEventListener("click", () => void emit("draw-clear", null));
document.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void setTool("mouse");
});
void document.fonts.ready.then(() => fit());
