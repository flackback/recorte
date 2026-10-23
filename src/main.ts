import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { startAgent } from "./agent";
import { joinSegments } from "./join";
import { Editor } from "./editor/editor";
import { confirmDialog, onContextMenu, type MenuItem } from "./menu";
import { resetTips, showTour } from "./tips";
import { toast } from "./toast";
import { Settings } from "./settings";
import { Updates } from "./updates";
import { joinPath, takeName, type Take } from "./types";

type MonitorInfo = { index: number; name: string; width: number; height: number; primary: boolean; x: number; y: number; refreshRate: number };
type WindowInfo = { hwnd: string; title: string; process: string; width: number; height: number };
type Sources = { monitors: MonitorInfo[]; windows: WindowInfo[] };
type Status = { recording: boolean; elapsedMs: number; frames: number; closed: boolean; paused: boolean };

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
  keystrokes: $<HTMLInputElement>("keystrokes"),
  showCursor: $<HTMLInputElement>("show-cursor"),
  countdown: $<HTMLInputElement>("countdown"),
  fps: $("fps"),
  record: $<HTMLButtonElement>("record"),
  recordLabel: $("record-label"),
  recordHint: $("record-hint"),
  warnings: $<HTMLUListElement>("warnings"),
  takes: $<HTMLUListElement>("takes"),
  openFolder: $<HTMLButtonElement>("open-folder"),
  empty: $("empty"),
  takeSelection: $("take-selection"),
  takeSelectionCount: $("take-selection-count"),
  takeSelectionTrash: $<HTMLButtonElement>("take-selection-trash"),
  takeSelectionClear: $<HTMLButtonElement>("take-selection-clear"),
  emptyRecord: $<HTMLButtonElement>("empty-record"),
  emptyOpen: $<HTMLButtonElement>("empty-open"),
  titlebarStatus: $("titlebar-status"),
  titlebarTime: $("titlebar-time"),
  minimize: $<HTMLButtonElement>("win-min"),
  maximize: $<HTMLButtonElement>("win-max"),
  close: $<HTMLButtonElement>("win-close"),
};

const SETTINGS_KEY = "recorte.settings";
const WEBCAM_FILE = "webcam.mp4";

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
let drawing = false;

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
    ] as const) {
      if (typeof saved[key] === "boolean") input.checked = saved[key];
    }
    if (saved.fps) for (const input of ui.fps.querySelectorAll<HTMLInputElement>("input")) input.checked = Number(input.value) === saved.fps;
    if (saved.area && typeof saved.area.width === "number") picker.area = saved.area;
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
        keystrokes: ui.keystrokes.checked,
        showCursor: ui.showCursor.checked,
        countdown: ui.countdown.checked,
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

  ui.monitorMap.replaceChildren(
    ...monitors.map((monitor) => {
      const button = document.createElement("button");
      button.className = "monitor";
      button.classList.toggle("primary", monitor.primary);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(monitor.index === picker.monitor));
      button.textContent = String(ordered.indexOf(monitor) + 1);
      button.title = `${places.get(monitor.index)} · ${monitor.name} · ${monitor.width}×${monitor.height}`;
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
      const area = picker.kind === "a" && picker.area?.monitor === monitor.index ? picker.area : null;
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
  const selected = monitors.find((monitor) => monitor.index === picker.monitor);
  const place = selected ? `${places.get(selected.index)}${selected.primary ? " (principal)" : ""}` : "";
  const area = picker.area?.monitor === picker.monitor ? picker.area : null;
  ui.sourceCaption.replaceChildren();
  if (!selected) return;
  if (picker.kind !== "a") {
    ui.sourceCaption.textContent = `${place} · ${selected.width}×${selected.height}`;
    return;
  }
  // Área mode: the chosen size, and a way to change it.
  const text = document.createElement("span");
  text.textContent = area ? `Área de ${area.width}×${area.height}` : "Nenhuma área escolhida";
  text.title = area ? `${place} · ${area.width}×${area.height} a partir de ${area.x}, ${area.y}` : "";
  const change = document.createElement("button");
  change.className = "link";
  change.textContent = area ? "Alterar área" : "Desenhar a área";
  change.disabled = recording;
  change.addEventListener("click", () => void chooseArea());
  ui.sourceCaption.append(text, " · ", change);
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
  if (picked) picker.area = { monitor, ...picked };
  else {
    picker.kind = "m";
    const radio = ui.sourceKind.querySelector<HTMLInputElement>('input[value="m"]');
    if (radio) radio.checked = true;
  }
  renderPicker();
  saveSettings();
}

function renderWindows() {
  const { windows } = picker.sources;
  ui.windowList.replaceChildren(
    ...windows.map((window) => {
      const button = document.createElement("button");
      button.className = "window-item";
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
  ui.windowList.hidden = !showWindows;
  if (showWindows) renderWindows();
  else renderMonitors();
}

/** Turns off the Microfone and Webcam chips when there is no such device. */
async function checkDevices() {
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
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
}

function selectedSource() {
  if (picker.kind === "w") return picker.window ? { kind: "window", hwnd: picker.window } : null;
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
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
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

// ---------- recording ----------

function setRecordingUi(active: boolean) {
  recording = active;
  ui.titlebarStatus.hidden = !active;
  ui.titlebarTime.textContent = "Gravando";
  ui.record.classList.toggle("active", active);
  ui.recordLabel.textContent = active ? "Parar · 0:00.0" : "Gravar";
  for (const control of [ui.refresh, ui.systemAudio, ui.microphone, ui.webcam, ui.keystrokes, ui.showCursor, ...ui.sourceKind.querySelectorAll("input")]) {
    (control as HTMLInputElement).disabled = active;
  }
  renderPicker();
  if (!active) {
    void checkDevices();
    void invoke("main_window_capture", { hidden: false });
  }
  ui.recordHint.textContent = active
    ? "Gravando… Ctrl+Shift+D desenha na tela · Ctrl+Shift+X para"
    : "Esta janela não aparece na gravação.";
}

async function startRecording() {
  const source = selectedSource();
  if (!source) {
    showWarnings(["Escolha uma tela ou janela."]);
    return;
  }
  saveSettings();
  showWarnings([]);
  const warnings: string[] = [];

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
    crop,
    fps: selectedFps(),
  };
  recordedMonitor = source.kind === "monitor" ? (source as { index: number }).index : picker.monitor || 1;

  // 3-2-1 on the monitor about to be recorded, so the click on Gravar isn't in the video.
  if (ui.countdown.checked && !(await countdown(recordedMonitor))) {
    camera?.close();
    camera = null;
    return;
  }

  // Hidden from captures only while recording, so it stays visible over remote access.
  await invoke("main_window_capture", { hidden: true });
  let started: { warnings: string[]; dir: string };
  try {
    started = await invoke<{ warnings: string[]; dir: string }>("start_recording", { options });
  } catch (error) {
    camera?.close();
    camera = null;
    void invoke("main_window_capture", { hidden: false });
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
  setRecordingUi(true);
  statusTimer = window.setInterval(pollStatus, 200);
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
  const status = await invoke<Status>("recording_status");
  if (!status.recording) return;
  ui.recordLabel.textContent = `Parar · ${formatClock(status.elapsedMs)}`;
  ui.titlebarTime.textContent = `${status.paused ? "Pausado" : "Gravando"} · ${formatDuration(status.elapsedMs)}`;
  void emit("recbar-state", { elapsedMs: status.elapsedMs, paused: status.paused });
  if (status.closed) {
    showWarnings(["A janela gravada foi fechada; a gravação foi encerrada."]);
    await toggleRecording();
  }
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

async function stopRecording() {
  window.clearInterval(statusTimer);
  await invoke("recbar_close").catch(() => undefined);
  // Back to the app to edit what was just recorded.
  await appWindow.unminimize().catch(() => undefined);
  await appWindow.show().catch(() => undefined);
  await appWindow.setFocus().catch(() => undefined);
  if (drawing) {
    drawing = false;
    await invoke("overlay_close").catch(() => undefined);
  }
  ui.recordLabel.textContent = "Finalizando…";
  try {
    const webcamSaved = camera ? await camera.stop() : false;
    let take = await invoke<Take>("stop_recording");
    if (camera && webcamSaved) {
      take = await invoke<Take>("take_set_webcam", { dir: take.dir, file: WEBCAM_FILE, startedHns: camera.startedHns });
    }
    // The video was recorded in pieces; join them into one file before editing.
    if (take.segments?.length) {
      try {
        take = await joinSegments(take, (fraction) => (ui.recordLabel.textContent = `Finalizando… ${Math.floor(fraction * 100)}%`));
      } catch (error) {
        showWarnings([`Não foi possível finalizar o vídeo: ${error}. A gravação continua salva; o app tenta de novo ao abrir a lista.`]);
      }
    }
    camera = null;
    if (take.warnings.length) showWarnings(take.warnings);
    await refreshTakes();
    await openTake(take.id);
  } finally {
    setRecordingUi(false);
  }
}

async function toggleRecording() {
  if (busy) return;
  busy = true;
  ui.record.disabled = true;
  try {
    if (recording) await stopRecording();
    else await startRecording();
  } catch (error) {
    showWarnings([String(error)]);
    if (recording) setRecordingUi(false);
  } finally {
    busy = false;
    ui.record.disabled = !recording && !selectedSource();
  }
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
    const from = takes.findIndex((take) => take.id === pickAnchor);
    const to = takes.findIndex((take) => take.id === id);
    if (!event.ctrlKey) picked.clear();
    for (const take of takes.slice(Math.min(from, to), Math.max(from, to) + 1)) picked.add(take.id);
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

async function refreshTakes() {
  takes = await invoke<Take[]>("list_takes");
  ui.emptyOpen.hidden = takes.length === 0;
  for (const id of [...picked]) if (!takes.some((take) => take.id === id)) picked.delete(id);
  void joinPending();
  ui.takes.replaceChildren(
    ...takes.map((take) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.className = "take";
      button.dataset.id = take.id;

      const thumb = document.createElement("span");
      thumb.className = "thumb";
      const thumbnail = (take as Take & { thumbnail?: string | null }).thumbnail;
      if (thumbnail) thumb.style.backgroundImage = `url("${convertFileSrc(joinPath(take.dir, thumbnail))}")`;
      const name = document.createElement("strong");
      name.textContent = takeName(take);
      const meta = document.createElement("span");
      meta.textContent = take.segments?.length ? "Finalizando a gravação…" : `${formatDate(take.createdAt)} · ${formatDuration(take.durationMs)}`;
      button.append(thumb, name, meta);
      button.addEventListener("click", (event) => {
        if (event.ctrlKey || event.shiftKey) {
          pickTake(take.id, event);
          return;
        }
        clearPicked();
        pickAnchor = take.id;
        void openTake(take.id);
      });
      button.addEventListener("dblclick", () => startRename(button, take));
      onContextMenu(button, () => (picked.size > 1 && picked.has(take.id) ? pickedMenu() : takeMenu(button, take)));
      item.append(button);
      return item;
    }),
  );
  if (!takes.length) {
    const item = document.createElement("li");
    item.className = "none";
    item.textContent = "Nenhuma gravação ainda.";
    ui.takes.append(item);
  }
  markSelected();
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
  for (const take of takes) picked.add(take.id);
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
}

async function openTake(id: string) {
  const take = takes.find((candidate) => candidate.id === id);
  if (!take) return;
  if (take.segments?.length) {
    toast("Esta gravação ainda está sendo finalizada. Ela abre em instantes.");
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
ui.close.addEventListener("click", () => {
  // Closing mid-recording would lose the take; ask to stop first.
  if (recording) {
    toast("Pare a gravação antes de fechar (Ctrl+Shift+X ou o botão Parar).");
    return;
  }
  void appWindow.close();
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
  else return;
  event.preventDefault();
  // Keeps the editor's own Delete and Ctrl+A from acting on the timeline too.
  event.stopPropagation();
});
void updateMaximizeButton();

ui.record.addEventListener("click", toggleRecording);
ui.takeSelectionTrash.addEventListener("click", () => void trashTakes(takes.filter((take) => picked.has(take.id))));
ui.takeSelectionClear.addEventListener("click", () => clearPicked());
ui.emptyRecord.addEventListener("click", toggleRecording);
ui.emptyOpen.addEventListener("click", () => {
  if (takes[0]) void openTake(takes[0].id);
});
ui.refresh.addEventListener("click", () => refreshSources());
ui.sourceKind.addEventListener("change", (event) => {
  picker.kind = (event.target as HTMLInputElement).value as typeof picker.kind;
  renderPicker();
  saveSettings();
  // Área: draw it right away, unless one is already chosen on this monitor.
  if (picker.kind === "a" && picker.area?.monitor !== picker.monitor) void chooseArea();
  // Window titles change all the time; refresh when switching to the list.
  if (picker.kind === "w") void refreshSources();
});
for (const control of [ui.systemAudio, ui.microphone, ui.webcam, ui.keystrokes, ui.showCursor, ui.countdown, ui.fps]) {
  control.addEventListener("change", saveSettings);
}
ui.keystrokes.addEventListener("change", () => {
  if (ui.keystrokes.checked) toast("As teclas ficam salvas na gravação, inclusive o que for digitado em senhas.");
});
ui.openFolder.addEventListener("click", () => {
  invoke("takes_dir_open").catch((error) => showWarnings([`Não foi possível abrir a pasta de gravações: ${error}`]));
});

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
  }
});

navigator.mediaDevices?.addEventListener("devicechange", () => void checkDevices());

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
