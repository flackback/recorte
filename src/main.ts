import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen, TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { startAgent } from "./agent";
import { joinSegments } from "./join";
import { Editor } from "./editor/editor";
import { readMp4, type ByteSource } from "./editor/mp4";
import { confirmDialog, onContextMenu, showMenu, type MenuItem } from "./menu";
import { resetTips, showTour } from "./tips";
import { toast } from "./toast";
import { Settings } from "./settings";
import { Updates } from "./updates";
import { CamLook, MicPanel, OptionsPanel, SoundPanel } from "./cardpanels";
import { joinPath, levelFill, takeName, type Levels, type Take } from "./types";

type MonitorInfo = { index: number; name: string; width: number; height: number; primary: boolean; x: number; y: number; refreshRate: number };
type WindowInfo = { hwnd: string; title: string; process: string; width: number; height: number };
type Sources = { monitors: MonitorInfo[]; windows: WindowInfo[] };
/** `error` is set when the capture failed (disk full, encoder error, monitor unplugged). */
type Status = { recording: boolean; elapsedMs: number; frames: number; closed: boolean; paused: boolean; error?: string | null };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  sourceKind: $("source-kind"),
  monitorMap: $("monitor-map"),
  windowList: $("window-list"),
  sourceCaption: $("source-caption"),
  refresh: $<HTMLButtonElement>("refresh"),
  systemAudio: $<HTMLInputElement>("system-audio"),
  microphone: $<HTMLInputElement>("microphone"),
  webcam: $<HTMLInputElement>("webcam"),
  micPick: $<HTMLButtonElement>("mic-pick"),
  micName: $("mic-name"),
  camPick: $<HTMLButtonElement>("cam-pick"),
  camName: $("cam-name"),
  keystrokes: $<HTMLInputElement>("keystrokes"),
  drawZoom: $<HTMLInputElement>("draw-zoom"),
  showCursor: $<HTMLInputElement>("show-cursor"),
  countdown: $<HTMLInputElement>("countdown"),
  fps: $("fps"),
  record: $<HTMLButtonElement>("record"),
  recordLabel: $("record-label"),
  sidebarToggle: $<HTMLButtonElement>("sidebar-toggle"),
  railRecord: $<HTMLButtonElement>("rail-record"),
  railTakes: $<HTMLButtonElement>("rail-takes"),
  railExpand: $<HTMLButtonElement>("rail-expand"),
  recentAll: $<HTMLButtonElement>("recent-all"),
  optionsOpen: $<HTMLButtonElement>("options-open"),
  optionsBody: $("options-body"),
  optionsSummary: $("options-summary"),
  recordHint: $("record-hint"),
  warnings: $<HTMLUListElement>("warnings"),
  live: $("live"),
  meterSystem: $("meter-system"),
  meterMic: $("meter-mic"),
  camPreview: $("cam-preview"),
  camVideo: $<HTMLVideoElement>("cam-preview-video"),
  camNote: $("cam-note"),
  takeSearchBox: $("take-search-box"),
  takeSearch: $<HTMLInputElement>("take-search"),
  takes: $<HTMLUListElement>("takes"),
  openFolder: $<HTMLButtonElement>("open-folder"),
  importVideo: $<HTMLButtonElement>("import-video"),
  importProgress: $("import-progress"),
  empty: $("empty"),
  takeSelection: $("take-selection"),
  takeSelectionCount: $("take-selection-count"),
  takeSelectionTrash: $<HTMLButtonElement>("take-selection-trash"),
  takeSelectionClear: $<HTMLButtonElement>("take-selection-clear"),
  emptyRecord: $<HTMLButtonElement>("empty-record"),
  areaHint: $("area-hint"),
  emptyOpen: $<HTMLButtonElement>("empty-open"),
  recent: $("recent"),
  recentRow: $("recent-row"),
  titlebarStatus: $("titlebar-status"),
  titlebarTime: $("titlebar-time"),
  minimize: $<HTMLButtonElement>("win-min"),
  maximize: $<HTMLButtonElement>("win-max"),
  close: $<HTMLButtonElement>("win-close"),
};

const SETTINGS_KEY = "recorte.settings";
const WEBCAM_FILE = "webcam.mp4";
/** Below this much free space a recording doesn't start (the backend checks too). */
const DISK_STOP_BYTES = 300 * 1024 ** 2;
/** Below this much free space the user is warned before recording. */
const DISK_LOW_BYTES = 2 * 1024 ** 3;
/** The capture failure set when the disk fills up while recording (`recorder::DISK_FULL`). */
const DISK_FULL_ERROR = "O disco está quase cheio; a gravação parou para não se perder.";

const editor = new Editor();
// Handy for inspecting state from the WebView devtools during development.
if (import.meta.env.DEV) (window as unknown as { editor: Editor }).editor = editor;
let recording = false;
let busy = false;
let statusTimer: number | undefined;
let takes: Take[] = [];
/** Takes picked with Ctrl or Shift for actions on several at once, and where a Shift range starts. */
const picked = new Set<string>();
let pickAnchor: string | null = null;
let camera: WebcamRecorder | null = null;
/** Monitor being recorded (one-based), for the drawing overlay. */
let recordedMonitor = 1;
/** What is being recorded, so an ended capture can say what went away. */
let recordedKind: "monitor" | "window" = "monitor";
/** Why the recording stopped on its own; shown with the take's warnings. */
let stopNotice: string | null = null;
let drawing = false;
/** Sound sources being recorded, for the level bars in the floating bar. */
let recordedAudio = { system: false, mic: false };

// ---------- helpers ----------

function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatClock(ms: number) {
  const tenths = Math.floor((ms % 1000) / 100);
  return `${formatDuration(ms - (ms % 1000))}.${tenths}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function showWarnings(messages: string[]) {
  ui.warnings.replaceChildren(
    ...messages.map((message) => {
      const item = document.createElement("li");
      item.textContent = message;
      return item;
    }),
  );
}

const selectedFps = () => Number(ui.fps.querySelector<HTMLInputElement>("input:checked")?.value ?? 60);

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    for (const [key, input] of [
      ["systemAudio", ui.systemAudio],
      ["microphone", ui.microphone],
      ["webcam", ui.webcam],
      ["keystrokes", ui.keystrokes],
      ["showCursor", ui.showCursor],
      ["countdown", ui.countdown],
      ["drawZoom", ui.drawZoom],
    ] as const) {
      if (typeof saved[key] === "boolean") input.checked = saved[key];
    }
    if (saved.fps) for (const input of ui.fps.querySelectorAll<HTMLInputElement>("input")) input.checked = Number(input.value) === saved.fps;
    if (saved.area && typeof saved.area.width === "number") picker.area = saved.area;
    if (typeof saved.micDevice === "string") devicePick.mic = saved.micDevice;
    if (typeof saved.camDevice === "string") devicePick.cam = saved.camDevice;
    return saved.source as string | undefined;
  } catch {
    return undefined;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        source: sourceValue(),
        area: picker.area,
        systemAudio: ui.systemAudio.checked,
        microphone: ui.microphone.checked,
        webcam: ui.webcam.checked,
        micDevice: devicePick.mic,
        camDevice: devicePick.cam,
        keystrokes: ui.keystrokes.checked,
        showCursor: ui.showCursor.checked,
        countdown: ui.countdown.checked,
        drawZoom: ui.drawZoom.checked,
        fps: selectedFps(),
      }),
    );
  } catch {
    // Settings are a convenience; recording works without them.
  }
}

// ---------- sources ----------

/** What will be recorded: a whole monitor ("m"), an area of one ("a"), or a window ("w"). */
const picker = {
  kind: "m" as "m" | "a" | "w",
  monitor: 0,
  window: "",
  sources: { monitors: [], windows: [] } as Sources,
  /** The area chosen in "Área" mode, in physical pixels of its monitor. */
  area: null as { monitor: number; x: number; y: number; width: number; height: number } | null,
  /** "Área" was just chosen: no monitor is selected until the user clicks one and draws the area. */
  areaPending: false,
};

/** Saved form, e.g. "m:2" or "w:12345", kept compatible with older settings. */
const sourceValue = () => `${picker.kind}:${picker.kind === "w" ? picker.window : picker.monitor}`;

async function refreshSources(preferred?: string) {
  if (preferred) {
    const [kind, value] = preferred.split(":");
    if (kind === "m" || kind === "a" || kind === "w") picker.kind = kind;
    if (kind === "w") picker.window = value;
    else picker.monitor = Number(value);
  }
  try {
    picker.sources = await invoke<Sources>("list_sources");
  } catch (error) {
    showWarnings([`Não foi possível listar as fontes: ${error}`]);
    return;
  }
  const { monitors, windows } = picker.sources;
  if (!monitors.some((monitor) => monitor.index === picker.monitor)) {
    picker.monitor = (monitors.find((monitor) => monitor.primary) ?? monitors[0])?.index ?? 0;
  }
  if (!windows.some((window) => window.hwnd === picker.window)) picker.window = windows[0]?.hwnd ?? "";
  renderPicker();
}

/** "Tela da esquerda", "Tela do centro"… from where each monitor sits on the desktop. */
function monitorPlaces(monitors: MonitorInfo[]): Map<number, string> {
  const ordered = [...monitors].sort((a, b) => a.x - b.x || a.y - b.y);
  const names =
    ordered.length === 1
      ? ["Tela"]
      : ordered.length === 2
        ? ["Tela da esquerda", "Tela da direita"]
        : ordered.length === 3
          ? ["Tela da esquerda", "Tela do centro", "Tela da direita"]
          : ordered.map((_, i) => `Tela ${i + 1}`);
  return new Map(ordered.map((monitor, i) => [monitor.index, names[i]]));
}

function renderMonitors() {
  const { monitors } = picker.sources;
  if (!monitors.length) {
    ui.monitorMap.replaceChildren();
    ui.sourceCaption.textContent = "Nenhuma tela encontrada";
    return;
  }
  // Scale the desktop layout into the map, keeping proportions and centering it.
  const left = Math.min(...monitors.map((m) => m.x));
  const top = Math.min(...monitors.map((m) => m.y));
  const right = Math.max(...monitors.map((m) => m.x + m.width));
  const bottom = Math.max(...monitors.map((m) => m.y + m.height));
  const box = { width: ui.monitorMap.clientWidth || 256, height: ui.monitorMap.clientHeight || 96 };
  const pad = 10;
  const gap = 3;
  const scale = Math.min((box.width - pad * 2) / (right - left), (box.height - pad * 2) / (bottom - top));
  const offsetX = (box.width - (right - left) * scale) / 2;
  const offsetY = (box.height - (bottom - top) * scale) / 2;
  const places = monitorPlaces(monitors);
  const ordered = [...monitors].sort((a, b) => a.x - b.x || a.y - b.y);

  ui.monitorMap.classList.toggle("area-mode", picker.kind === "a");
  const pending = picker.kind === "a" && picker.areaPending;
  // Rebuilding drops focus; give it back to the same monitor afterwards.
  const focused = focusedKey(ui.monitorMap);
  // Says how to choose the area, since clicking a monitor is not obvious.
  ui.areaHint.hidden = picker.kind !== "a";
  ui.monitorMap.replaceChildren(
    // Left to right, so the arrow keys follow the desktop layout.
    ...ordered.map((monitor) => {
      const button = document.createElement("button");
      button.className = "monitor";
      button.dataset.key = String(monitor.index);
      button.classList.toggle("primary", monitor.primary);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(!pending && monitor.index === picker.monitor));
      button.textContent = String(ordered.indexOf(monitor) + 1);
      button.title = picker.kind === "a"
        ? `Clique para desenhar a área na ${places.get(monitor.index)?.toLowerCase()}`
        : `${places.get(monitor.index)} · ${monitor.name} · ${monitor.width}×${monitor.height}`;
      button.style.left = `${offsetX + (monitor.x - left) * scale + gap / 2}px`;
      button.style.top = `${offsetY + (monitor.y - top) * scale + gap / 2}px`;
      button.style.width = `${monitor.width * scale - gap}px`;
      button.style.height = `${monitor.height * scale - gap}px`;
      button.disabled = recording;
      button.addEventListener("click", () => {
        picker.monitor = monitor.index;
        renderPicker();
        saveSettings();
        if (picker.kind === "a") void chooseArea();
      });
      // The chosen area, drawn to scale inside its monitor.
      const area = picker.kind === "a" && !pending && picker.area?.monitor === monitor.index ? picker.area : null;
      if (area) {
        const mark = document.createElement("span");
        mark.className = "area-mark";
        mark.style.left = `${(area.x / monitor.width) * 100}%`;
        mark.style.top = `${(area.y / monitor.height) * 100}%`;
        mark.style.width = `${(area.width / monitor.width) * 100}%`;
        mark.style.height = `${(area.height / monitor.height) * 100}%`;
        button.append(mark);
      }
      onContextMenu(button, () => {
        const choose = (kind: "m" | "a") => {
          picker.kind = kind;
          picker.monitor = monitor.index;
          renderPicker();
          saveSettings();
        };
        const busy = recording ? "Indisponível durante a gravação" : false;
        return [
          { label: "Gravar esta tela", icon: "monitor", disabled: busy, action: () => { choose("m"); void toggleRecording(); } },
          { label: "Escolher uma área nesta tela…", icon: "crop", disabled: busy, action: () => { choose("a"); void chooseArea(); } },
          "separator",
          { label: "Selecionar", icon: "check", disabled: busy, action: () => choose(picker.kind === "w" ? "m" : picker.kind) },
        ];
      });
      return button;
    }),
  );
  // Area mode only moves focus with the arrows: choosing a monitor there opens the area picker.
  rove(ui.monitorMap, String(picker.monitor), focused, picker.kind !== "a");
  const selected = monitors.find((monitor) => monitor.index === picker.monitor);
  const place = selected ? `${places.get(selected.index)}${selected.primary ? " (principal)" : ""}` : "";
  const area = picker.area?.monitor === picker.monitor ? picker.area : null;
  ui.sourceCaption.replaceChildren();
  if (!selected || pending) return;
  if (picker.kind !== "a") {
    ui.sourceCaption.textContent = `${place} · ${selected.width}×${selected.height}`;
    return;
  }
  // Área mode: the chosen size, and a way to change it.
  const text = document.createElement("span");
  text.textContent = area ? `Área de ${area.width}×${area.height}` : "Nenhuma área escolhida";
  text.title = area ? `${place} · ${area.width}×${area.height} a partir de ${area.x}, ${area.y}` : "";
  const change = document.createElement("button");
  change.className = "secondary compact";
  change.innerHTML = '<svg class="i"><use href="#i-crop" /></svg>';
  change.append(area ? "Alterar área" : "Desenhar a área");
  change.disabled = recording;
  change.addEventListener("click", () => void chooseArea());
  ui.sourceCaption.append(text, change);
}

/**
 * Opens the area picker over the selected monitor, starting from the current area. Choosing
 * "Tela inteira" there switches to recording the whole monitor.
 */
async function chooseArea() {
  if (recording || busy) return;
  const monitor = picker.monitor;
  const current = picker.area?.monitor === monitor ? picker.area : null;
  const picked = await pickArea(monitor, current);
  if (picked === "cancelled") {
    renderPicker();
    return;
  }
  if (picked) {
    picker.area = { monitor, ...picked };
    picker.areaPending = false;
  } else {
    picker.areaPending = false;
    picker.kind = "m";
    const radio = ui.sourceKind.querySelector<HTMLInputElement>('input[value="m"]');
    if (radio) radio.checked = true;
  }
  renderPicker();
  saveSettings();
}

/** The data-key of the item focused inside a list, if any. */
function focusedKey(list: HTMLElement) {
  const active = document.activeElement;
  return active instanceof HTMLElement && list.contains(active) ? (active.dataset.key ?? null) : null;
}

/**
 * Roving focus for a list rebuilt on every choice: one Tab stop (the chosen item), arrows move
 * between items, and focus returns to the item that had it before the rebuild.
 */
function rove(list: HTMLElement, chosen: string, focused: string | null, arrowsChoose: boolean) {
  const items = [...list.querySelectorAll<HTMLButtonElement>("button[data-key]")];
  const stop = items.find((item) => item.dataset.key === chosen) ?? items[0];
  for (const item of items) item.tabIndex = item === stop ? 0 : -1;
  if (focused !== null) items.find((item) => item.dataset.key === focused)?.focus();
  list.onkeydown = (event) => {
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const target = step ? items[(index + step + items.length) % items.length] : event.key === "Home" ? items[0] : event.key === "End" ? items[items.length - 1] : null;
    if (!target) return;
    event.preventDefault();
    if (target.disabled) return;
    for (const item of items) item.tabIndex = item === target ? 0 : -1;
    target.focus();
    if (arrowsChoose) target.click();
  };
}

function renderWindows() {
  const { windows } = picker.sources;
  const focused = focusedKey(ui.windowList);
  ui.windowList.replaceChildren(
    ...windows.map((window) => {
      const button = document.createElement("button");
      button.className = "window-item";
      button.dataset.key = window.hwnd;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(window.hwnd === picker.window));
      button.disabled = recording;
      const title = document.createElement("strong");
      title.textContent = window.title;
      const app = document.createElement("span");
      app.textContent = `${window.process.replace(/\.exe$/i, "")} · ${window.width}×${window.height}`;
      button.append(title, app);
      button.addEventListener("click", () => {
        picker.window = window.hwnd;
        renderPicker();
        saveSettings();
      });
      onContextMenu(button, () => [
        {
          label: "Gravar esta janela",
          icon: "visual",
          disabled: recording ? "Indisponível durante a gravação" : false,
          action: () => {
            picker.window = window.hwnd;
            renderPicker();
            saveSettings();
            void toggleRecording();
          },
        },
        { label: "Atualizar lista", icon: "refresh", action: () => void refreshSources() },
      ]);
      return button;
    }),
  );
  if (!windows.length) {
    const none = document.createElement("p");
    none.className = "none";
    none.textContent = "Nenhuma janela aberta para gravar.";
    ui.windowList.append(none);
  }
  rove(ui.windowList, picker.window, focused, true);
  ui.sourceCaption.textContent = windows.find((window) => window.hwnd === picker.window)?.title ?? "";
}

/** Recording faster than the screen refreshes gains nothing; offer only what the screen can show. */
function updateFpsOptions() {
  const monitor = picker.kind === "w" ? null : picker.sources.monitors.find((candidate) => candidate.index === picker.monitor);
  const limit = monitor ? monitor.refreshRate + 1 : Infinity;
  const inputs = [...ui.fps.querySelectorAll<HTMLInputElement>("input")];
  for (const input of inputs) {
    const tooFast = Number(input.value) > limit;
    input.disabled = recording || tooFast;
    input.closest("label")!.title = tooFast ? `Esta tela atualiza a ${monitor!.refreshRate} Hz` : "";
  }
  const checked = inputs.find((input) => input.checked);
  if (!checked || (Number(checked.value) > limit)) {
    const best = inputs.filter((input) => Number(input.value) <= limit).pop() ?? inputs[0];
    best.checked = true;
  }
}

function renderPicker() {
  updateFpsOptions();
  ui.record.disabled = busy || (!recording && !selectedSource());
  for (const input of ui.sourceKind.querySelectorAll<HTMLInputElement>("input")) input.checked = input.value === picker.kind;
  const showWindows = picker.kind === "w";
  ui.monitorMap.hidden = showWindows;
  ui.areaHint.hidden = picker.kind !== "a";
  ui.windowList.hidden = !showWindows;
  if (showWindows) renderWindows();
  else renderMonitors();
}

/** The microphone and the camera picked for recording; "" is the Windows default (the first camera). */
const devicePick = { mic: "", cam: "" };

type AudioInput = { id: string; name: string; default: boolean };
/** A choice in a device menu; `shown` is what the card says when it is picked. */
type DeviceChoice = { value: string; label: string; shown: string };

/** What each card offers, and what it uses now ("" for the default). */
const deviceLists = {
  mic: { choices: [] as DeviceChoice[], value: "", devices: 0 },
  cam: { choices: [] as DeviceChoice[], value: "", devices: 0 },
};

/** Each source card opens its panel: the device choice, and how it records in new recordings. */
const micDevice = () => ({ name: ui.micName.textContent ?? "", devices: deviceLists.mic.devices });
const camDevice = () => ({ name: ui.camName.textContent ?? "", devices: deviceLists.cam.devices });
const soundPanel = new SoundPanel(ui.meterSystem);
const micPanel = new MicPanel(ui.micPick, micDevice, (anchor) => openDeviceMenu("mic", anchor));
const camLook = new CamLook(ui.camPick, ui.camVideo, camDevice, (anchor) => openDeviceMenu("cam", anchor));

/** Keeps the pick while it is plugged in; otherwise the first choice. */
function fillDevices(kind: "mic" | "cam", choices: DeviceChoice[], devices: number) {
  const list = deviceLists[kind];
  list.choices = choices;
  list.devices = devices;
  list.value = choices.some((choice) => choice.value === devicePick[kind]) ? devicePick[kind] : (choices[0]?.value ?? "");
  const name = kind === "mic" ? ui.micName : ui.camName;
  const current = choices.find((choice) => choice.value === list.value);
  name.textContent = current?.shown ?? "";
  // The card always opens its panel; the device is picked there.
  if (kind === "mic") micPanel.refresh(micDevice);
  else camLook.refresh(camDevice);
}

/** Lists the microphones (names from Windows) and the cameras (names show once a camera was allowed). */
async function listDevices(devices: MediaDeviceInfo[]) {
  const cameras = devices.filter((device) => device.kind === "videoinput" && device.deviceId);
  fillDevices(
    "cam",
    cameras.map((camera, index) => {
      const label = camera.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "") || `Webcam ${index + 1}`;
      return { value: camera.deviceId, label, shown: label };
    }),
    cameras.length,
  );
  try {
    const inputs = await invoke<AudioInput[]>("audio_inputs");
    const fallback = inputs.find((input) => input.default);
    const choices = inputs.map((input) => ({ value: input.id, label: input.name, shown: input.name }));
    fillDevices("mic", inputs.length ? [{ value: "", label: "Padrão do Windows", shown: fallback?.name ?? "Padrão do Windows" }, ...choices] : [], inputs.length);
  } catch (error) {
    console.error("audio_inputs", error);
  }
  showPicks();
}

/** A card shows before recording, while its chip is on and there is a device. */
function showPicks() {
  const allowed = liveAllowed();
  ui.micPick.hidden = !allowed || !ui.microphone.checked || !deviceLists.mic.choices.length;
  ui.camPick.hidden = !allowed || !ui.webcam.checked || !deviceLists.cam.choices.length;
}

/** Opens the device menu under its card, or under `anchor`. */
function openDeviceMenu(kind: "mic" | "cam", anchor?: HTMLElement) {
  const list = deviceLists[kind];
  const card = anchor ?? (kind === "mic" ? ui.micPick : ui.camPick);
  if (list.devices < 2 || (card as HTMLButtonElement).disabled) return;
  const rect = card.getBoundingClientRect();
  const items: MenuItem[] = list.choices.map((choice) => ({
    label: choice.label,
    checked: choice.value === list.value,
    action: () => pickDevice(kind, choice.value),
  }));
  // The default comes first, apart from the devices.
  if (kind === "mic") items.splice(1, 0, "separator");
  card.setAttribute("aria-expanded", "true");
  showMenu(rect.left, rect.bottom + 6, items, { width: rect.width, onClose: () => card.setAttribute("aria-expanded", "false") });
}

function pickDevice(kind: "mic" | "cam", value: string) {
  if (value === deviceLists[kind].value) return;
  devicePick[kind] = value;
  fillDevices(kind, deviceLists[kind].choices, deviceLists[kind].devices);
  saveSettings();
  if (kind === "mic") {
    invoke("set_microphone", { id: value || null }).catch((error) => console.error("set_microphone", error));
  } else {
    // The preview moves to the new camera.
    closePreview();
    updateLive();
  }
}

/** Opens the picked camera, or the first one. */
function cameraConstraints(width: number, height: number): MediaStreamConstraints {
  const deviceId = deviceLists.cam.value;
  return { video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } }, audio: false };
}

/** Turns off the Microfone and Webcam chips when there is no such device, and lists the devices. */
async function checkDevices() {
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  void listDevices(devices);
  const chips: [HTMLInputElement, MediaDeviceKind, string][] = [
    [ui.microphone, "audioinput", "Nenhum microfone encontrado"],
    [ui.webcam, "videoinput", "Nenhuma webcam encontrada"],
  ];
  for (const [input, kind, missing] of chips) {
    const present = devices.some((device) => device.kind === kind);
    if (!present) input.checked = false;
    input.disabled = recording || !present;
    input.closest("label")!.title = present ? "" : missing;
  }
  // A camera plugged in after a failed preview gets another try.
  live.camFailed = false;
  updateLive();
}

function selectedSource() {
  if (picker.kind === "w") return picker.window ? { kind: "window", hwnd: picker.window } : null;
  if (picker.kind === "a" && picker.areaPending) return null;
  return picker.monitor ? { kind: "monitor", index: picker.monitor } : null;
}

// ---------- webcam ----------

/**
 * Records the camera in the WebView while the screen records, writing `webcam.mp4` into the take
 * folder as it goes. Its start is stamped on the same clock as the screen, so the editor can line
 * the two up.
 */
class WebcamRecorder {
  private recorder: MediaRecorder;
  private writeId = -1;
  private position = 0;
  private chain: Promise<unknown> = Promise.resolve();
  startedHns = 0;

  private constructor(private stream: MediaStream, mimeType: string) {
    this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  }

  static async open(): Promise<WebcamRecorder> {
    const mimeType = ["video/mp4;codecs=avc1.42E01F", "video/mp4;codecs=avc1", "video/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("este WebView não grava vídeo em MP4");
    const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(1280, 720));
    return new WebcamRecorder(stream, mimeType);
  }

  async start(dir: string) {
    const created = await invoke<{ id: number }>("asset_create", { dir, name: WEBCAM_FILE });
    this.writeId = created.id;
    const started = new Promise<void>((resolve) => this.recorder.addEventListener("start", () => resolve(), { once: true }));
    this.recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      const position = this.position;
      this.position += event.data.size;
      this.chain = this.chain.then(async () => {
        const bytes = new Uint8Array(await event.data.arrayBuffer());
        await invoke("export_write", bytes, { headers: { "x-export-id": String(this.writeId), "x-position": String(position) } });
      });
    };
    this.recorder.start(1000);
    await started;
    this.startedHns = await invoke<number>("clock_now");
  }

  async stop(): Promise<boolean> {
    const stopped = new Promise<void>((resolve) => this.recorder.addEventListener("stop", () => resolve(), { once: true }));
    if (this.recorder.state !== "inactive") this.recorder.stop();
    await stopped;
    for (const track of this.stream.getTracks()) track.stop();
    try {
      await this.chain;
      await invoke("export_finish", { id: this.writeId });
      return this.position > 0;
    } catch {
      await invoke("export_cancel", { id: this.writeId }).catch(() => undefined);
      return false;
    }
  }

  close() {
    for (const track of this.stream.getTracks()) track.stop();
  }
}

// ---------- live check (level bars, camera preview) ----------

/**
 * Before recording, shows that sound is coming in and how the camera frames the user. Runs only
 * while the window is in view, nothing is recording or starting, and the chip is on; the
 * recording opens the devices itself, so the preview lets the camera go before it starts.
 */
const live = {
  /** Sources the backend meter was last asked to read, as "system:mic"; "" when stopped. */
  meter: "",
  timer: undefined as number | undefined,
  polling: false,
  minimized: false,
  cam: null as MediaStream | null,
  /** Bumped to drop a camera that opens after it stopped being wanted. */
  camToken: 0,
  camOpening: false,
  /** The preview failed; not retried until the chip is turned on again or a device appears. */
  camFailed: false,
};

function liveAllowed() {
  return !recording && !busy && !live.minimized && document.visibilityState === "visible";
}

function updateLive() {
  const allowed = liveAllowed();
  const system = allowed && ui.systemAudio.checked;
  const mic = allowed && ui.microphone.checked;
  const cam = allowed && ui.webcam.checked;
  ui.meterSystem.hidden = !system;
  ui.meterMic.hidden = !mic;
  ui.live.hidden = !(system || mic || cam);
  showPicks();
  if (!system) soundPanel.close();
  if (!mic) micPanel.close();

  const wanted = system || mic ? `${system}:${mic}` : "";
  if (wanted !== live.meter) {
    live.meter = wanted;
    const sent = wanted ? invoke("meter_start", { system, mic }) : invoke("meter_stop");
    sent.catch((error) => console.error("meter", error));
  }
  if (wanted && live.timer === undefined) {
    live.timer = window.setInterval(() => void pollLevels(), 80);
  } else if (!wanted && live.timer !== undefined) {
    window.clearInterval(live.timer);
    live.timer = undefined;
    showLevel(ui.meterSystem, 0);
    showLevel(ui.meterMic, 0);
  }

  if (cam) void openPreview();
  else {
    closePreview();
    camLook.close();
  }
}

async function pollLevels() {
  // A slow answer skips a tick instead of piling up calls.
  if (live.polling) return;
  live.polling = true;
  try {
    const levels = await invoke<Levels>("audio_levels");
    if (!ui.meterSystem.hidden) showLevel(ui.meterSystem, levels.system);
    if (!ui.meterMic.hidden) showLevel(ui.meterMic, levels.mic);
    if (soundPanel.meter) showLevel(soundPanel.meter, levels.system);
    if (micPanel.meter) showLevel(micPanel.meter, levels.mic);
  } catch {
    // The next tick tries again.
  } finally {
    live.polling = false;
  }
}

/** Moves the bar's cover (transform only); null shows the bar as off. */
function showLevel(meter: HTMLElement, peak: number | null) {
  const off = peak === null;
  if (meter.classList.contains("off") !== off) {
    meter.classList.toggle("off", off);
    meter.title = off ? `${meter.dataset.label}: sem sinal do dispositivo` : meter.dataset.label!;
  }
  const cover = meter.querySelector<HTMLElement>(".meter-cover")!;
  const transform = `scaleX(${(1 - levelFill(peak)).toFixed(3)})`;
  if (cover.style.transform !== transform) cover.style.transform = transform;
}

function cameraError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "A webcam não foi liberada para o Recorte.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Nenhuma webcam encontrada.";
  if (name === "NotReadableError" || name === "AbortError") return "A webcam está em uso por outro programa.";
  return "Não foi possível abrir a webcam.";
}

async function openPreview() {
  if (live.cam || live.camOpening || live.camFailed) return;
  const token = ++live.camToken;
  live.camOpening = true;
  ui.camNote.hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(320, 240));
    if (token !== live.camToken) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    // Camera names are only given once a camera was allowed.
    if (deviceLists.cam.choices.some((choice) => /^Webcam \d+$/.test(choice.label))) {
      void navigator.mediaDevices.enumerateDevices().then(listDevices).catch(() => undefined);
    }
    live.cam = stream;
    ui.camVideo.srcObject = stream;
    ui.camPreview.hidden = false;
    void ui.camVideo.play().catch(() => undefined);
  } catch (error) {
    if (token !== live.camToken) return;
    live.camFailed = true;
    ui.camNote.textContent = cameraError(error);
    ui.camNote.hidden = false;
  } finally {
    if (token === live.camToken) live.camOpening = false;
  }
}

/** Lets the camera go (its light turns off). The next time it is wanted, a failed one is tried again. */
function closePreview() {
  live.camToken++;
  live.camOpening = false;
  live.camFailed = false;
  if (live.cam) for (const track of live.cam.getTracks()) track.stop();
  live.cam = null;
  ui.camVideo.srcObject = null;
  ui.camPreview.hidden = true;
  ui.camNote.hidden = true;
}

async function checkMinimized() {
  live.minimized = await appWindow.isMinimized().catch(() => false);
  updateLive();
}

// ---------- recording ----------

function setRecordingUi(active: boolean) {
  recording = active;
  ui.titlebarStatus.hidden = !active;
  ui.titlebarTime.textContent = "Gravando";
  ui.record.classList.toggle("active", active);
  ui.railRecord.classList.toggle("active", active);
  ui.railRecord.title = active ? "Parar (Alt+Shift+R)" : "Gravar (Alt+Shift+R)";
  ui.railRecord.setAttribute("aria-label", active ? "Parar" : "Gravar");
  ui.recordLabel.textContent = active ? "Parar · 0:00.0" : "Gravar";
  for (const control of [ui.refresh, ui.systemAudio, ui.microphone, ui.webcam, ui.micPick, ui.camPick, ui.keystrokes, ui.showCursor, ui.drawZoom, ...ui.sourceKind.querySelectorAll("input")]) {
    (control as HTMLInputElement).disabled = active;
  }
  renderPicker();
  if (!active) {
    void checkDevices();
    invoke("main_window_capture", { hidden: false }).catch((error) => console.error("main_window_capture", error));
  }
  ui.recordHint.textContent = active
    ? "Gravando… Ctrl+Shift+D desenha na tela · Ctrl+Shift+X para"
    : "Esta janela não aparece na gravação.";
}

async function startRecording() {
  if (picker.kind === "a" && picker.areaPending) {
    toast("Clique numa tela no mapa e desenhe a área para gravar");
    ui.areaHint.classList.remove("flash");
    void ui.areaHint.offsetWidth;
    ui.areaHint.classList.add("flash");
    return;
  }
  // Screens and windows may have changed since the list was drawn.
  const chosenBefore = sourceValue();
  await refreshSources();
  if (sourceValue() !== chosenBefore) {
    showWarnings(["A tela ou janela escolhida não está mais disponível. Confira a escolha e grave de novo."]);
    return;
  }
  const source = selectedSource();
  if (!source) {
    showWarnings(["Escolha uma tela ou janela."]);
    return;
  }
  saveSettings();
  showWarnings([]);
  const warnings: string[] = [];

  // A full disk would cut the take short; refuse when there is next to no room, warn when little.
  const free = await invoke<number | null>("disk_free").catch(() => null);
  if (free !== null && free < DISK_STOP_BYTES) {
    const message = "Não há espaço livre suficiente no disco das gravações (menos de 300 MB). Libere espaço e grave de novo.";
    showWarnings([message]);
    toast(message);
    return;
  }
  if (free !== null && free < DISK_LOW_BYTES) {
    toast(`Pouco espaço no disco: ${(free / 1024 ** 3).toFixed(1).replace(".", ",")} GB livres. A gravação para sozinha se o disco encher.`);
  }

  // An area: let the user drag it on the monitor first.
  let crop: { x: number; y: number; width: number; height: number } | null = null;
  if (picker.kind === "a") {
    const chosen = picker.area?.monitor === picker.monitor ? picker.area : null;
    if (chosen) {
      crop = { x: chosen.x, y: chosen.y, width: chosen.width, height: chosen.height };
    } else {
      const picked = await pickArea(picker.monitor, null);
      if (picked === "cancelled") return;
      crop = picked;
      if (picked) {
        picker.area = { monitor: picker.monitor, ...picked };
        saveSettings();
      }
    }
  }

  // Ask for the camera first, so its permission prompt doesn't land in the recording.
  camera = null;
  if (ui.webcam.checked) {
    try {
      camera = await WebcamRecorder.open();
    } catch (error) {
      warnings.push(`Webcam desativada: ${error instanceof Error ? error.message : error}`);
    }
  }

  const options = {
    source,
    systemAudio: ui.systemAudio.checked,
    microphone: ui.microphone.checked,
    showCursor: ui.showCursor.checked,
    keystrokes: ui.keystrokes.checked,
    drawZoom: ui.drawZoom.checked,
    crop,
    fps: selectedFps(),
  };
  recordedMonitor = source.kind === "monitor" ? (source as { index: number }).index : picker.monitor || 1;
  recordedKind = source.kind === "window" ? "window" : "monitor";
  recordedAudio = { system: options.systemAudio, mic: options.microphone };

  // 3-2-1 on the monitor about to be recorded, so the click on Gravar isn't in the video.
  if (ui.countdown.checked && !(await countdown(recordedMonitor))) {
    camera?.close();
    camera = null;
    return;
  }

  let started: { warnings: string[]; dir: string };
  try {
    // Hidden from captures only while recording, so it stays visible over remote access.
    await invoke("main_window_capture", { hidden: true });
    started = await invoke<{ warnings: string[]; dir: string }>("start_recording", { options });
  } catch (error) {
    camera?.close();
    camera = null;
    invoke("main_window_capture", { hidden: false }).catch(() => undefined);
    throw error;
  }
  if (camera) {
    try {
      await camera.start(started.dir);
    } catch (error) {
      warnings.push(`Webcam desativada: ${error}`);
      camera.close();
      camera = null;
    }
  }
  showWarnings([...started.warnings, ...warnings]);
  stopNotice = null;
  setRecordingUi(true);
  statusTimer = window.setInterval(() => void pollStatus(), 200);
  // Out of the way while recording: the floating bar takes over (and stays out of the video).
  try {
    await invoke("recbar_open", { monitor: recordedMonitor });
    await appWindow.minimize();
  } catch (error) {
    showWarnings([...started.warnings, ...warnings, `Barra de gravação indisponível: ${error}`]);
  }
}

/** Shows the countdown; resolves false if the user cancelled it. */
function countdown(monitor: number): Promise<boolean> {
  return new Promise((resolve) => {
    const stops: Promise<() => void>[] = [];
    const done = (go: boolean) => {
      for (const stop of stops) void stop.then((unlisten) => unlisten());
      resolve(go);
    };
    stops.push(listen("countdown-done", () => done(true)));
    stops.push(listen("countdown-cancelled", () => done(false)));
    invoke("overlay_open", { mode: "countdown", monitor }).catch(() => done(true));
  });
}

async function pollStatus() {
  let status: Status;
  try {
    status = await invoke<Status>("recording_status");
  } catch (error) {
    // One missed tick only delays the clock; the next one tries again.
    console.error("recording_status", error);
    return;
  }
  // A tick that arrives after the stop must not start a new recording through toggleRecording.
  if (!recording) return;
  // The capture ended on its own: stop the normal way, so what was recorded is saved.
  // The full-disk stop is already written for people; capture errors get some context.
  const ended = status.error
    ? status.error === DISK_FULL_ERROR
      ? `${status.error} O que já foi gravado fica salvo.`
      : `A gravação parou por um erro: ${status.error}. O que já foi gravado fica salvo.`
    : status.closed
      ? recordedKind === "window"
        ? "A janela gravada foi fechada. A gravação foi encerrada."
        : "A tela gravada foi desconectada. A gravação foi encerrada."
      : null;
  if (ended) {
    // Already stopping or starting: the next tick tries again.
    if (busy) return;
    stopNotice = ended;
    showWarnings([ended]);
    toast(ended);
    await toggleRecording();
    return;
  }
  if (!status.recording) return;
  ui.recordLabel.textContent = `Parar · ${formatClock(status.elapsedMs)}`;
  ui.titlebarTime.textContent = `${status.paused ? "Pausado" : "Gravando"} · ${formatDuration(status.elapsedMs)}`;
  void emit("recbar-state", { elapsedMs: status.elapsedMs, paused: status.paused, audio: recordedAudio });
}

/** Opens the area picker over a monitor; resolves with the area, null for the whole screen, or "cancelled". */
async function pickArea(monitor: number, current: { x: number; y: number; width: number; height: number } | null): Promise<{ x: number; y: number; width: number; height: number } | null | "cancelled"> {
  const result = new Promise<{ x: number; y: number; width: number; height: number } | null | "cancelled">((resolve) => {
    const stops: Promise<() => void>[] = [];
    const done = (value: { x: number; y: number; width: number; height: number } | null | "cancelled") => {
      for (const stop of stops) void stop.then((unlisten) => unlisten());
      resolve(value);
    };
    stops.push(listen<{ x: number; y: number; width: number; height: number } | null>("area-selected", (event) => done(event.payload)));
    stops.push(listen("area-cancelled", () => done("cancelled")));
  });
  await invoke("overlay_open", { mode: "area", monitor, area: current ? `${current.x},${current.y},${current.width},${current.height}` : null });
  return result;
}

async function showMainWindow() {
  await appWindow.unminimize().catch(() => undefined);
  await appWindow.show().catch(() => undefined);
  await appWindow.setFocus().catch(() => undefined);
}

/** Closes the floating bar and the drawing layer of the recording that is stopping. */
async function closeRecordingWindows() {
  window.clearInterval(statusTimer);
  await invoke("recbar_close").catch(() => undefined);
  if (drawing) {
    drawing = false;
    await invoke("overlay_close").catch(() => undefined);
  }
}

async function stopRecording() {
  await closeRecordingWindows();
  // Back to the app to edit what was just recorded.
  await showMainWindow();
  ui.recordLabel.textContent = "Finalizando…";
  let take: Take;
  try {
    const webcamSaved = camera ? await camera.stop() : false;
    take = await invoke<Take>("stop_recording");
    if (camera && webcamSaved) {
      take = await invoke<Take>("take_set_webcam", { dir: take.dir, file: WEBCAM_FILE, startedHns: camera.startedHns });
    }
    // The video was recorded in pieces; join them into one file before editing.
    if (take.segments?.length) {
      try {
        take = await joinSegments(take, (fraction) => (ui.recordLabel.textContent = `Finalizando… ${Math.floor(fraction * 100)}%`));
      } catch (error) {
        showWarnings([`Não foi possível finalizar o vídeo: ${error}. A gravação continua salva. O app tenta de novo em instantes.`]);
      }
    }
    camera = null;
    const notices = [...(stopNotice ? [stopNotice] : []), ...take.warnings];
    if (notices.length) showWarnings(notices);
  } finally {
    stopNotice = null;
    setRecordingUi(false);
  }
  // Only now, with the recording over, can the list join takes still in pieces.
  await refreshTakes();
  await openTake(take.id);
}

async function toggleRecording() {
  if (busy) {
    // A countdown, the area picker or the stop is still running.
    toast("Aguarde…");
    return;
  }
  busy = true;
  ui.record.disabled = true;
  // Lets the camera and the sound devices go before the recording opens them.
  updateLive();
  try {
    if (recording) await stopRecording();
    else await startRecording();
  } catch (error) {
    showWarnings([String(error)]);
    if (recording) setRecordingUi(false);
  } finally {
    busy = false;
    ui.record.disabled = !recording && !selectedSource();
    updateLive();
  }
}

/**
 * "Descartar e regravar" from the floating bar: stops the recording, moves its take to the
 * Recycle Bin without opening it, and records again with the same choices (countdown included).
 * The app stays out of the way unless the new recording doesn't start.
 */
async function discardAndRecord() {
  if (!recording || busy) return;
  busy = true;
  ui.record.disabled = true;
  try {
    await closeRecordingWindows();
    ui.recordLabel.textContent = "Descartando…";
    let dir: string;
    try {
      // The webcam file is finished first, so nothing holds the folder when it moves.
      if (camera) await camera.stop();
      camera = null;
      dir = (await invoke<Take>("stop_recording")).dir;
    } finally {
      stopNotice = null;
      setRecordingUi(false);
    }
    try {
      await invoke("take_trash", { dir });
    } catch (error) {
      showWarnings([`Não foi possível mover a gravação descartada para a Lixeira: ${error}`]);
    }
    await refreshTakes();
    await startRecording();
  } catch (error) {
    showWarnings([String(error)]);
    if (recording) setRecordingUi(false);
  } finally {
    busy = false;
    ui.record.disabled = !recording && !selectedSource();
  }
  // Cancelled countdown, source gone, start failed: back to the app, where the reason shows.
  if (!recording) await showMainWindow();
  updateLive();
}

// ---------- takes ----------

function markSelected() {
  for (const button of ui.takes.querySelectorAll<HTMLButtonElement>(".take")) {
    button.classList.toggle("selected", button.dataset.id === editor.currentTakeId);
    button.classList.toggle("picked", picked.has(button.dataset.id!));
    button.setAttribute("aria-selected", String(picked.has(button.dataset.id!)));
  }
  ui.takeSelection.hidden = picked.size === 0;
  ui.takeSelectionCount.textContent = picked.size === 1 ? "1 selecionada" : `${picked.size} selecionadas`;
}

/** Ctrl adds or removes one take; Shift picks everything from the last one picked. */
function pickTake(id: string, event: MouseEvent | KeyboardEvent) {
  if (event.shiftKey && pickAnchor) {
    // Only what the search shows: a range never reaches takes the user can't see.
    const shown = shownTakes();
    const from = Math.max(0, shown.findIndex((take) => take.id === pickAnchor));
    const to = shown.findIndex((take) => take.id === id);
    if (!event.ctrlKey) picked.clear();
    for (const take of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) picked.add(take.id);
  } else {
    // The open take joins the first Ctrl pick, as in Explorer.
    if (!picked.size && editor.currentTakeId && editor.currentTakeId !== id) picked.add(editor.currentTakeId);
    if (picked.has(id)) picked.delete(id);
    else picked.add(id);
    pickAnchor = id;
  }
  markSelected();
}

function clearPicked() {
  picked.clear();
  pickAnchor = null;
  markSelected();
}

/** One row of the list, kept across refreshes so focus and an open rename survive them. */
type TakeRow = { item: HTMLLIElement; button: HTMLButtonElement; thumb: HTMLSpanElement; name: HTMLElement; meta: HTMLSpanElement };
const takeRows = new Map<string, TakeRow>();
const noTakes = document.createElement("li");
noTakes.className = "none";
noTakes.setAttribute("role", "option");
noTakes.setAttribute("aria-disabled", "true");
noTakes.textContent = "Nenhuma gravação ainda.";
const noMatches = noTakes.cloneNode() as HTMLLIElement;
noMatches.textContent = "Nenhuma gravação encontrada.";

const takeById = (id: string) => takes.find((take) => take.id === id);

// ---------- search ----------

/** Lowercase without accents, so "acao" finds "Ação". */
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * The search over the list: by name here, and by what was said through the backend, which reads
 * the takes' transcripts (kept in memory until they change).
 */
const search = {
  query: "",
  terms: [] as string[],
  /** Takes whose transcript has every term, with the words around the first one. */
  said: new Map<string, string>(),
  /** Drops answers to an older query. */
  sequence: 0,
  timer: undefined as number | undefined,
};

function matchesName(take: Take) {
  const name = fold(takeName(take));
  return search.terms.every((term) => name.includes(term));
}

const isShown = (take: Take) => !search.terms.length || matchesName(take) || search.said.has(take.id);
/** The takes the list shows, in order. */
const shownTakes = () => takes.filter(isShown);

/** Hides the rows that don't match; a match only by speech shows what was said instead of the date. */
function applySearch() {
  let shown = 0;
  for (const take of takes) {
    const row = takeRows.get(take.id);
    if (!row) continue;
    const byName = !search.terms.length || matchesName(take);
    const said = byName ? undefined : search.said.get(take.id);
    const visible = byName || said !== undefined;
    row.item.hidden = !visible;
    if (visible) shown++;
    const meta = said !== undefined ? `“${said}”` : metaText(take);
    if (row.meta.textContent !== meta) row.meta.textContent = meta;
    row.meta.classList.toggle("said", said !== undefined);
    row.meta.title = said !== undefined ? "Dito na gravação" : "";
  }
  // Picked takes the search hides would be trashed unseen from the selection bar.
  for (const id of [...picked]) {
    const take = takeById(id);
    if (take && !isShown(take)) picked.delete(id);
  }
  if (takes.length && !shown) ui.takes.append(noMatches);
  else noMatches.remove();
  ui.takeSearchBox.hidden = !takes.length && !search.query;
}

/** Filters by name at once; asks for matches in the transcripts after a short pause in typing. */
function runSearch() {
  search.query = ui.takeSearch.value.trim();
  search.terms = fold(search.query).split(/\s+/).filter(Boolean);
  window.clearTimeout(search.timer);
  const sequence = ++search.sequence;
  if (!search.terms.length) search.said.clear();
  applySearch();
  markSelected();
  if (!search.terms.length) return;
  search.timer = window.setTimeout(async () => {
    let said = new Map<string, string>();
    try {
      const hits = await invoke<{ id: string; snippet: string }[]>("takes_search", { query: search.query });
      said = new Map(hits.map((hit) => [hit.id, hit.snippet]));
    } catch (error) {
      console.error("takes_search", error);
    }
    if (sequence !== search.sequence) return;
    search.said = said;
    applySearch();
    markSelected();
  }, 150);
}

function createTakeRow(id: string): TakeRow {
  const item = document.createElement("li");
  item.setAttribute("role", "none");
  const button = document.createElement("button");
  button.className = "take";
  button.dataset.id = id;
  button.setAttribute("role", "option");
  const thumb = document.createElement("span");
  thumb.className = "thumb";
  const name = document.createElement("strong");
  const meta = document.createElement("span");
  button.append(thumb, name, meta);
  // Handlers look the take up when they run, so they always see the latest version.
  button.addEventListener("click", (event) => {
    if (event.ctrlKey || event.shiftKey) {
      pickTake(id, event);
      return;
    }
    clearPicked();
    pickAnchor = id;
    void openTake(id);
  });
  button.addEventListener("dblclick", () => {
    const take = takeById(id);
    if (take) startRename(button, take);
  });
  onContextMenu(button, () => {
    const take = takeById(id);
    if (!take) return null;
    return picked.size > 1 && picked.has(id) ? pickedMenu() : takeMenu(button, take);
  });
  item.append(button);
  return { item, button, thumb, name, meta };
}

const metaText = (take: Take) => (take.segments?.length ? "Finalizando a gravação…" : `${formatDate(take.createdAt)} · ${formatDuration(take.durationMs)}`);

function updateTakeRow(row: TakeRow, take: Take) {
  row.name.textContent = takeName(take);
  // The second line (date, or what was said) is set by applySearch.
  const thumbnail = (take as Take & { thumbnail?: string | null }).thumbnail;
  const src = thumbnail ? convertFileSrc(joinPath(take.dir, thumbnail)) : "";
  const image = row.thumb.querySelector("img");
  if (!src) {
    image?.remove();
  } else if (!image) {
    const created = document.createElement("img");
    created.alt = "";
    created.loading = "lazy";
    created.decoding = "async";
    // A missing file leaves the plain placeholder.
    created.addEventListener("error", () => created.remove());
    created.src = src;
    row.thumb.append(created);
  } else if (image.getAttribute("src") !== src) {
    image.src = src;
  }
}

// ---------- recent takes on the start screen ----------

/** A card in the row of recent takes under "Gravar agora": thumbnail, name, date and length. */
function recentCard(take: Take) {
  const card = document.createElement("button");
  card.className = "recent-card";
  card.setAttribute("role", "listitem");
  card.title = `Abrir “${takeName(take)}”`;
  const thumb = document.createElement("span");
  thumb.className = "recent-thumb";
  const thumbnail = (take as Take & { thumbnail?: string | null }).thumbnail;
  if (thumbnail) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => image.remove());
    image.src = convertFileSrc(joinPath(take.dir, thumbnail));
    thumb.append(image);
  }
  const length = document.createElement("span");
  length.className = "recent-length";
  length.textContent = take.segments?.length ? "…" : formatDuration(take.durationMs);
  thumb.append(length);
  const name = document.createElement("strong");
  name.textContent = takeName(take);
  const date = document.createElement("span");
  date.textContent = take.segments?.length ? "Finalizando a gravação…" : formatDate(take.createdAt);
  card.append(thumb, name, date);
  card.addEventListener("click", () => void openTake(take.id));
  onContextMenu(card, () => {
    const current = takeById(take.id);
    // Renaming happens on the list row, which shows the name being edited.
    return current ? takeMenu(takeRows.get(take.id)?.button ?? card, current) : null;
  });
  return card;
}

/** How many recent takes the start screen shows; the panel lists them all. */
const RECENT_MAX = 8;

function renderRecent() {
  ui.recent.hidden = takes.length === 0;
  // With takes to show, the start screen sits higher instead of floating in the middle.
  ui.empty.classList.toggle("with-recent", takes.length > 0);
  ui.recentRow.replaceChildren(...takes.slice(0, RECENT_MAX).map(recentCard));
  ui.recentAll.hidden = takes.length <= RECENT_MAX;
  ui.recentAll.textContent = `Ver todas (${takes.length})`;
}

// "Ver todas": opens the panel on the full list, ready to search.
ui.recentAll.addEventListener("click", () => {
  setSidebarCollapsed(false);
  ui.takeSearch.focus();
});

function focusTake(id: string) {
  takeRows.get(id)?.button.focus();
}

async function refreshTakes() {
  takes = await invoke<Take[]>("list_takes");
  ui.emptyOpen.hidden = takes.length === 0;
  for (const id of [...picked]) if (!takes.some((take) => take.id === id)) picked.delete(id);
  void joinPending();
  // Reconcile by id: rows are reused and only moved when out of place, so focus stays put.
  const ids = new Set(takes.map((take) => take.id));
  for (const [id, row] of takeRows) {
    if (ids.has(id)) continue;
    row.item.remove();
    takeRows.delete(id);
  }
  if (takes.length) noTakes.remove();
  takes.forEach((take, index) => {
    let row = takeRows.get(take.id);
    if (!row) {
      row = createTakeRow(take.id);
      takeRows.set(take.id, row);
    }
    updateTakeRow(row, take);
    const here = ui.takes.children[index];
    if (here !== row.item) ui.takes.insertBefore(row.item, here ?? null);
  });
  if (!takes.length) ui.takes.append(noTakes);
  renderRecent();
  applySearch();
  markSelected();
  // A take may have been transcribed or renamed since; look again for an active search.
  if (search.terms.length) runSearch();
}

function takeMenu(button: HTMLButtonElement, take: Take): MenuItem[] {
  const isOpen = editor.currentTakeId === take.id;
  return [
    { label: "Abrir", icon: "play", disabled: isOpen ? "Já está aberta" : false, action: () => void openTake(take.id) },
    { label: "Renomear", icon: "visual", shortcut: "F2", action: () => startRename(button, take) },
    { label: "Mostrar na pasta", icon: "folder", action: () => void revealItemInDir(joinPath(take.dir, take.video)) },
    {
      label: "Exportar…",
      icon: "export",
      shortcut: isOpen ? "Ctrl+E" : undefined,
      action: async () => {
        await openTake(take.id);
        editor.openExport();
      },
    },
    "separator",
    {
      label: "Mover para a Lixeira",
      icon: "trash",
      danger: true,
      disabled: recording ? "Indisponível durante a gravação" : false,
      action: () => void trashTake(take),
    },
  ];
}

let joining = false;
/** A take the user tried to open while it was still in pieces; it opens once joined. */
let openWhenJoined: string | null = null;
/** Takes that failed to join this session; not retried until the app opens again. */
const joinFailed = new Set<string>();

/**
 * Joins takes still in pieces: one whose joining was interrupted, or one recovered after the app
 * stopped mid-recording. Not while recording, which needs the disk.
 */
async function joinPending() {
  if (joining || recording) return;
  const pending = takes.filter((take) => take.segments?.length && !joinFailed.has(take.id));
  if (!pending.length) return;
  joining = true;
  try {
    for (const take of pending) {
      try {
        await joinSegments(take, () => undefined);
        toast(take.title === "Gravação recuperada" ? "Uma gravação interrompida foi recuperada. Ela está na lista." : "Gravação finalizada");
      } catch (error) {
        console.error("juntar segmentos", error);
        joinFailed.add(take.id);
        showWarnings([`Não foi possível finalizar "${takeName(take)}": ${error}`]);
      }
    }
  } finally {
    joining = false;
  }
  await refreshTakes();
  // Keeps the promise of "Ela abre em instantes"; a failed join shows a warning instead.
  const waiting = openWhenJoined ? takeById(openWhenJoined) : undefined;
  if (waiting && !waiting.segments?.length) {
    openWhenJoined = null;
    await openTake(waiting.id);
  } else if (waiting && joinFailed.has(waiting.id)) {
    openWhenJoined = null;
  }
}

/** Menu for several picked takes. */
function pickedMenu(): MenuItem[] {
  const chosen = takes.filter((take) => picked.has(take.id));
  return [
    { label: `${chosen.length} gravações selecionadas`, icon: "check", disabled: "Use Ctrl ou Shift para mudar a seleção", action: () => undefined },
    "separator",
    { label: "Selecionar todas", icon: "check", shortcut: "Ctrl+A", action: () => pickAll() },
    { label: "Tirar a seleção", icon: "close", shortcut: "Esc", action: () => clearPicked() },
    "separator",
    {
      label: `Mover ${chosen.length} para a Lixeira`,
      icon: "trash",
      danger: true,
      shortcut: "Delete",
      disabled: recording ? "Indisponível durante a gravação" : false,
      action: () => void trashTakes(chosen),
    },
  ];
}

function pickAll() {
  for (const take of shownTakes()) picked.add(take.id);
  markSelected();
}

/** Edits the take's name in place: Enter saves, Escape cancels, empty restores the source name. */
function startRename(button: HTMLButtonElement, take: Take) {
  const name = button.querySelector("strong");
  if (!name || button.querySelector(".rename")) return;
  const input = document.createElement("input");
  input.className = "rename";
  input.value = takeName(take);
  input.setAttribute("aria-label", "Nome da gravação");
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const hadFocus = document.activeElement === input;
    input.replaceWith(name);
    if (hadFocus) button.focus({ preventScroll: true });
    if (save && input.value.trim() !== takeName(take)) {
      try {
        await invoke("take_rename", { dir: take.dir, title: input.value });
      } catch (error) {
        toast(`Não foi possível renomear: ${error}`);
      }
    }
    await refreshTakes();
    if (editor.currentTakeId === take.id) editor.setTitle(takeName(takes.find((candidate) => candidate.id === take.id) ?? take));
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") void finish(true);
    if (event.key === "Escape") void finish(false);
  });
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("blur", () => void finish(true));
}

async function trashTake(take: Take) {
  await trashTakes([take]);
}

/** Moves takes to the Recycle Bin after one confirmation. */
async function trashTakes(chosen: Take[]) {
  if (!chosen.length || recording) return;
  const one = chosen.length === 1;
  // From the list (or its selection bar), focus moves on to the next take afterwards.
  const fromList = ui.takes.contains(document.activeElement) || ui.takeSelection.contains(document.activeElement);
  const before = shownTakes();
  const firstIndex = Math.min(...chosen.map((take) => before.findIndex((candidate) => candidate.id === take.id)).filter((index) => index >= 0));
  const confirmed = await confirmDialog({
    title: one ? "Mover para a Lixeira?" : `Mover ${chosen.length} gravações para a Lixeira?`,
    message: one
      ? `"${takeName(chosen[0])}" e todos os arquivos dela (vídeo, áudio, edição) vão para a Lixeira do Windows. Dá para restaurar de lá.`
      : `As ${chosen.length} gravações e todos os arquivos delas (vídeo, áudio, edição) vão para a Lixeira do Windows. Dá para restaurar de lá.`,
    confirm: "Mover para a Lixeira",
    danger: true,
  });
  if (!confirmed) return;
  if (chosen.some((take) => take.id === editor.currentTakeId)) {
    editor.close();
    ui.empty.hidden = false;
  }
  const failures: string[] = [];
  for (const take of chosen) {
    try {
      await invoke("take_trash", { dir: take.dir });
    } catch (error) {
      failures.push(`${takeName(take)}: ${error}`);
    }
  }
  const moved = chosen.length - failures.length;
  if (moved) toast(moved === 1 ? "Gravação movida para a Lixeira" : `${moved} gravações movidas para a Lixeira`);
  if (failures.length) showWarnings(failures);
  clearPicked();
  await refreshTakes();
  const after = shownTakes();
  const next = after[Math.min(firstIndex, after.length - 1)];
  if (fromList && next) focusTake(next.id);
}

async function openTake(id: string) {
  const take = takes.find((candidate) => candidate.id === id);
  if (!take) return;
  if (take.segments?.length) {
    if (joinFailed.has(take.id)) {
      toast("Não foi possível finalizar esta gravação. Abra o app de novo para tentar outra vez.");
      return;
    }
    openWhenJoined = take.id;
    toast("Esta gravação ainda está sendo finalizada. Ela abre em instantes.");
    void joinPending();
    return;
  }
  ui.empty.hidden = true;
  try {
    await editor.open(take);
  } catch (error) {
    toast(`Não foi possível abrir a gravação: ${error}`);
  }
  markSelected();
  if (take.warnings.length) showWarnings(take.warnings);
}

// ---------- wiring ----------

// ---------- window controls (the native title bar is off) ----------

const appWindow = getCurrentWindow();

async function updateMaximizeButton() {
  const maximized = await appWindow.isMaximized();
  // Square corners when the window fills the screen.
  document.documentElement.classList.toggle("maximized", maximized);
  ui.maximize.querySelector("use")!.setAttribute("href", maximized ? "#i-win-restore" : "#i-win-max");
  ui.maximize.title = maximized ? "Restaurar" : "Maximizar";
  ui.maximize.setAttribute("aria-label", ui.maximize.title);
}

ui.minimize.addEventListener("click", () => void appWindow.minimize());
ui.maximize.addEventListener("click", () => void appWindow.toggleMaximize());
ui.close.addEventListener("click", () => void appWindow.close());
/**
 * Every close (this button, Alt+F4, the taskbar) passes here. Closing mid-recording would lose the
 * take and leave the floating bar and the overlay behind, so it asks to stop first. A listener makes
 * Tauri hold the close; to let it through, the guard steps aside and closes again (the capability
 * has close, not destroy).
 */
const closeGuard: Promise<UnlistenFn> = appWindow.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async () => {
  if (recording || busy) {
    toast("Pare a gravação antes de fechar o Recorte.");
    return;
  }
  (await closeGuard)();
  await appWindow.close();
});
void appWindow.onResized(() => void updateMaximizeButton());

// ---------- updates ----------

const updates = new Updates(document.getElementById("update") as HTMLButtonElement, () =>
  recording ? "Pare a gravação antes de atualizar." : document.querySelector("#export-running:not([hidden])") ? "Espere a exportação terminar antes de atualizar." : null,
);
updates.start();
const settings = new Settings(updates, {
  resetTips,
  showShortcuts: () => {
    const modal = document.getElementById("shortcuts-modal")!;
    modal.hidden = false;
    document.getElementById("shortcuts-close")?.focus();
  },
});
document.getElementById("settings-open")!.addEventListener("click", () => void settings.open());
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === ",") {
    event.preventDefault();
    if (!settings.isOpen) void settings.open();
  }
});
let appVersion = "";
void getVersion().then((version) => (appVersion = version));

onContextMenu(document.querySelector<HTMLElement>(".titlebar")!, () => {
  const maximized = ui.maximize.title === "Restaurar";
  return [
    { label: "Minimizar", icon: "win-min", action: () => void appWindow.minimize() },
    { label: maximized ? "Restaurar" : "Maximizar", icon: maximized ? "win-restore" : "win-max", action: () => void appWindow.toggleMaximize() },
    "separator",
    { label: "Configurações", icon: "gear", shortcut: "Ctrl+,", action: () => void settings.open() },
    { label: appVersion ? `Procurar atualizações (versão ${appVersion})` : "Procurar atualizações", icon: "refresh", action: () => void updates.check(true) },
    "separator",
    { label: "Fechar", icon: "win-close", shortcut: "Alt+F4", action: () => ui.close.click() },
  ];
});
onContextMenu(ui.takes, () => [
  { label: "Atualizar lista", icon: "refresh", action: () => void refreshTakes() },
  { label: "Abrir pasta de gravações", icon: "folder", action: () => ui.openFolder.click() },
  { label: "Importar vídeo", icon: "import", action: () => void pickVideo() },
]);
// The WebView's own menu (Back, Reload, Inspect…) makes no sense in an app; keep it for text fields only.
document.addEventListener("contextmenu", (event) => {
  if (!(event.target instanceof Element && event.target.closest("input, textarea"))) event.preventDefault();
});
ui.takes.addEventListener("keydown", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".take");
  const take = takes.find((candidate) => candidate.id === button?.dataset.id);
  if (!button || !take) return;
  if (event.key === "F2") startRename(button, take);
  else if (event.key === "Delete") void (picked.size ? trashTakes(takes.filter((candidate) => picked.has(candidate.id))) : trashTake(take));
  else if (event.key === "Escape" && picked.size) clearPicked();
  else if (event.ctrlKey && event.key.toLowerCase() === "a") pickAll();
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const shown = shownTakes();
    const index = shown.indexOf(take);
    // Up from the first take goes back to the search field.
    if (index === 0 && event.key === "ArrowUp" && !ui.takeSearchBox.hidden) ui.takeSearch.focus();
    const next = shown[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) focusTake(next.id);
  } else if (event.key === "Home" || event.key === "End") {
    const shown = shownTakes();
    const edge = event.key === "Home" ? shown[0] : shown[shown.length - 1];
    if (edge) focusTake(edge.id);
  } else return;
  event.preventDefault();
  // Keeps the editor's own Delete and Ctrl+A from acting on the timeline too.
  event.stopPropagation();
});
void updateMaximizeButton();

ui.record.addEventListener("click", toggleRecording);
ui.railRecord.addEventListener("click", toggleRecording);

// ---------- sidebar ----------

const SIDEBAR_KEY = "recorte.sidebarCollapsed";

/** Folds the panel into a thin rail (more room for the editor), or opens it again. Remembered. */
function setSidebarCollapsed(collapsed: boolean) {
  document.querySelector(".app")!.classList.toggle("collapsed", collapsed);
  ui.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "Mostrar o painel" : "Esconder o painel";
  ui.sidebarToggle.title = `${label} (Ctrl+\\)`;
  ui.sidebarToggle.setAttribute("aria-label", label);
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    // Only a convenience.
  }
}

const sidebarCollapsed = () => document.querySelector(".app")!.classList.contains("collapsed");
ui.sidebarToggle.addEventListener("click", () => setSidebarCollapsed(!sidebarCollapsed()));
ui.railTakes.addEventListener("click", () => {
  setSidebarCollapsed(false);
  ui.takeSearch.focus();
});
ui.railExpand.addEventListener("click", () => setSidebarCollapsed(false));

// Rail toggles mirror the panel chips (Som do sistema, Microfone, Webcam): same inputs, same events.
for (const toggle of document.querySelectorAll<HTMLButtonElement>(".rail-toggle")) {
  const input = $<HTMLInputElement>(toggle.dataset.for!);
  const sync = () => toggle.setAttribute("aria-pressed", String(input.checked));
  input.addEventListener("change", sync);
  toggle.addEventListener("click", () => {
    if (input.disabled) return;
    input.checked = !input.checked;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  sync();
}
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "\\") {
    event.preventDefault();
    setSidebarCollapsed(!sidebarCollapsed());
  }
});

/** "60 fps · Contagem · Zoom ao desenhar": how the folded options are set, at a glance. */
function updateOptionsSummary() {
  const on = [
    ui.keystrokes.checked && "Teclas",
    ui.showCursor.checked && "Cursor",
    ui.countdown.checked && "Contagem",
    ui.drawZoom.checked && "Zoom ao desenhar",
  ].filter(Boolean);
  ui.optionsSummary.textContent = [`${selectedFps()} fps`, ...on].join(" · ");
}

for (const control of [ui.keystrokes, ui.showCursor, ui.countdown, ui.drawZoom, ui.fps]) control.addEventListener("change", updateOptionsSummary);
const optionsPanel = new OptionsPanel(ui.optionsOpen, ui.optionsBody);
ui.optionsOpen.addEventListener("click", () => optionsPanel.toggle());
try {
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
} catch {
  // Default: panel open.
}
updateOptionsSummary();
ui.takeSelectionTrash.addEventListener("click", () => void trashTakes(takes.filter((take) => picked.has(take.id))));
ui.takeSelectionClear.addEventListener("click", () => clearPicked());
ui.takeSearch.addEventListener("input", () => runSearch());
ui.takeSearch.addEventListener("keydown", (event) => {
  // Typing here never reaches the editor's shortcuts (Space plays, Ctrl+Z undoes an edit).
  event.stopPropagation();
  if (event.key === "Escape") {
    // Esc clears the search; on an empty field it leaves it.
    if (ui.takeSearch.value) {
      ui.takeSearch.value = "";
      runSearch();
    } else {
      ui.takeSearch.blur();
    }
  } else if (event.key === "ArrowDown" || event.key === "Enter") {
    const first = shownTakes()[0];
    if (!first) return;
    if (event.key === "Enter") void openTake(first.id);
    else focusTake(first.id);
  } else if (event.ctrlKey && event.key.toLowerCase() === "f") {
    ui.takeSearch.select();
  } else return;
  event.preventDefault();
});
// Ctrl+F finds a recording, unless the editor is open (its shortcuts come first there).
window.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.key.toLowerCase() !== "f") return;
  if (editor.currentTakeId || settings.isOpen || ui.takeSearchBox.hidden) return;
  event.preventDefault();
  ui.takeSearch.focus();
  ui.takeSearch.select();
});
ui.emptyRecord.addEventListener("click", toggleRecording);
ui.emptyOpen.addEventListener("click", () => {
  if (takes[0]) void openTake(takes[0].id);
});
ui.refresh.addEventListener("click", () => refreshSources());
ui.sourceKind.addEventListener("change", (event) => {
  picker.kind = (event.target as HTMLInputElement).value as typeof picker.kind;
  // Área: no monitor is selected yet; clicking one opens the area drawing there.
  picker.areaPending = picker.kind === "a";
  renderPicker();
  saveSettings();
  // Window titles change all the time; refresh when switching to the list.
  if (picker.kind === "w") void refreshSources();
});
for (const control of [ui.systemAudio, ui.microphone, ui.webcam, ui.keystrokes, ui.showCursor, ui.countdown, ui.drawZoom, ui.fps]) {
  control.addEventListener("change", saveSettings);
}
for (const control of [ui.systemAudio, ui.microphone, ui.webcam]) control.addEventListener("change", () => updateLive());
ui.meterSystem.addEventListener("click", () => soundPanel.toggle());
ui.micPick.addEventListener("click", () => micPanel.toggle());
ui.camPick.addEventListener("click", () => camLook.toggle());
// The live check stops while the window is minimized or hidden.
document.addEventListener("visibilitychange", () => void checkMinimized());
window.addEventListener("focus", () => void checkMinimized());
void appWindow.onResized(() => void checkMinimized());
ui.keystrokes.addEventListener("change", () => {
  if (ui.keystrokes.checked) toast("As teclas ficam salvas na gravação, inclusive o que for digitado em senhas.");
});
ui.openFolder.addEventListener("click", () => {
  invoke("takes_dir_open").catch((error) => showWarnings([`Não foi possível abrir a pasta de gravações: ${error}`]));
});

// ---------- importing a video ----------

const UNSUPPORTED_VIDEO = "Formato não suportado. Use um vídeo MP4 ou MOV em H.264.";
let importing = false;

/** How far a copy or upload is, on the import button; null ends it. */
function showImportProgress(fraction: number | null) {
  ui.importProgress.hidden = fraction === null;
  ui.importProgress.textContent = fraction === null ? "" : `${Math.floor(fraction * 100)}%`;
  ui.importVideo.disabled = fraction !== null;
}

/** Runs one import at a time, then opens the new take in the editor. */
async function runImport(work: (progress: (fraction: number) => void) => Promise<Take>) {
  if (importing) {
    toast("Aguarde a importação em andamento.");
    return;
  }
  importing = true;
  showImportProgress(0);
  try {
    const take = await work(showImportProgress);
    await refreshTakes();
    await openTake(take.id);
    toast("Vídeo importado");
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  } finally {
    importing = false;
    showImportProgress(null);
  }
}

/** Picks a file with the system dialog; Rust copies it on its own thread and reports progress. */
async function pickVideo() {
  const options = { title: "Importar vídeo", multiple: false, directory: false, filters: [{ name: "Vídeos", extensions: ["mp4", "mov", "m4v"] }] };
  const path = await invoke<string | null>("plugin:dialog|open", { options }).catch((error) => {
    toast(String(error));
    return null;
  });
  if (path) await runImport(() => invoke<Take>("take_import", { path }));
}

/**
 * A dropped file has no path in the WebView, so it is checked with the editor's own MP4 reader and
 * then uploaded into the takes folder in pieces, where Rust makes the take from it.
 */
async function importDropped(file: File) {
  await runImport(async (progress) => {
    const source: ByteSource = { size: file.size, read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()) };
    const video = (await readMp4(source).catch(() => null))?.tracks.find((track) => track.kind === "video");
    if (!video?.codec.startsWith("avc1") || !video.description) throw new Error(UNSUPPORTED_VIDEO);
    const free = await invoke<number | null>("disk_free").catch(() => null);
    if (free !== null && free < file.size + 300 * 1024 ** 2) throw new Error("Não há espaço livre suficiente no disco das gravações para este vídeo.");
    const upload = await invoke<{ id: number }>("import_upload");
    try {
      const chunk = 8 * 1024 * 1024;
      for (let offset = 0; offset < file.size; offset += chunk) {
        const bytes = new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer());
        await invoke("export_write", bytes, { headers: { "x-export-id": String(upload.id), "x-position": String(offset) } });
        progress((offset + bytes.length) / file.size);
      }
      const path = await invoke<string>("export_finish", { id: upload.id });
      return await invoke<Take>("take_import", { path, name: file.name });
    } catch (error) {
      await invoke("export_cancel", { id: upload.id }).catch(() => {});
      throw error;
    }
  });
}

ui.importVideo.addEventListener("click", () => void pickVideo());
editor.onVideoDrop = (file) => void importDropped(file);
// Copy progress from Rust, also for imports the AI asks for; the last report ends it.
void listen<{ done: number; total: number }>("import-progress", ({ payload }) => {
  showImportProgress(payload.done >= payload.total && !importing ? null : payload.done / Math.max(1, payload.total));
});
// A take imported through the MCP server shows up in the list.
void listen("takes-changed", () => void refreshTakes());

// Global shortcuts (work while other apps have focus): Ctrl+Shift+D draws, Ctrl+Shift+X stops.
/** Marks the current moment of the recording; the floating bar confirms it. */
async function markMoment() {
  try {
    const count = await invoke<number>("recording_mark");
    await emit("recbar-mark", count);
  } catch (error) {
    toast(String(error));
  }
}

void listen<string>("hotkey", async (event) => {
  if (event.payload === "record") {
    await toggleRecording();
  } else if (event.payload === "mark") {
    if (recording) await markMoment();
  } else if (event.payload === "stop") {
    if (recording) await toggleRecording();
  } else if (event.payload === "draw") {
    if (!recording) toast("Desenhar na tela funciona durante a gravação.");
    else await emit("draw-toggle", null);
  }
});

/** Opens the drawing layer over the recorded monitor, once; the floating bar drives it after that. */
async function openDrawing() {
  if (drawing) return;
  drawing = true;
  await invoke("overlay_open", { mode: "draw", monitor: recordedMonitor }).catch((error) => {
    drawing = false;
    showWarnings([`Não foi possível abrir o desenho: ${error}`]);
  });
}
document.getElementById("tips-reset")!.addEventListener("click", () => {
  resetTips();
  document.getElementById("shortcuts-modal")!.hidden = true;
  toast("As dicas aparecem de novo ao abrir o app e a próxima gravação.");
});
void listen<string>("recbar-action", async (event) => {
  if (!recording) return;
  if (event.payload === "pause" || event.payload === "resume") {
    await invoke("recording_pause", { paused: event.payload === "pause" }).catch((error) => toast(String(error)));
    void pollStatus();
  } else if (event.payload === "draw-open") {
    await openDrawing();
  } else if (event.payload === "mark") {
    await markMoment();
  } else if (event.payload === "stop") {
    await toggleRecording();
  } else if (event.payload === "redo") {
    await discardAndRecord();
  }
});

navigator.mediaDevices?.addEventListener("devicechange", () => void checkDevices());

// Screens come and go (a monitor plugged in, a window opened); look again when the app is back in front.
let sourcesCheckedAt = 0;
window.addEventListener("focus", () => {
  if (recording || busy || performance.now() - sourcesCheckedAt < 2000) return;
  sourcesCheckedAt = performance.now();
  void refreshSources();
});

/** Lets the entry animation finish, then dissolves it into the app. */
function hideSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const shown = performance.now();
  const minimum = matchMedia("(prefers-reduced-motion: reduce)").matches ? 150 : 1050;
  window.setTimeout(() => {
    splash.classList.add("leaving");
    splash.addEventListener("transitionend", () => splash.remove(), { once: true });
    window.setTimeout(() => splash.remove(), 600);
  }, Math.max(0, minimum - shown));
}

window.addEventListener("DOMContentLoaded", async () => {
  const savedSource = loadSettings();
  if (devicePick.mic) invoke("set_microphone", { id: devicePick.mic }).catch((error) => console.error("set_microphone", error));
  void checkDevices();
  await refreshSources(savedSource);
  hideSplash();
  await new Promise((resolve) => window.setTimeout(resolve, 1200));
  showTour("record", [
    {
      target: () => ui.monitorMap.hidden ? ui.windowList : ui.monitorMap,
      title: "Escolha o que gravar",
      text: "Clique na tela que quer gravar. Em Área você desenha a região na hora; em Janela escolhe um programa.",
    },
    {
      target: () => document.querySelector<HTMLElement>(".chips"),
      title: "Ligue o que entra no vídeo",
      text: "Som do sistema, microfone, webcam e teclas. A contagem dá 3 segundos antes de começar.",
    },
    {
      target: () => ui.record,
      title: "Grave",
      text: "O app se esconde e uma barrinha flutuante mostra o tempo, pausar, desenhar e parar. Ela não aparece no vídeo. Ctrl+Shift+X para de qualquer programa.",
    },
  ]);
  await refreshTakes();
});

// ---------- AI (MCP server) ----------

startAgent({
  editor,
  async refresh() {
    await refreshTakes();
    return takes;
  },
  async open(id) {
    if (editor.currentTakeId !== id) await openTake(id);
    await appWindow.unminimize();
    await appWindow.show();
    await appWindow.setFocus();
  },
});
