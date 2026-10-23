import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { showTour } from "../tips";
import { toast } from "../toast";
import { joinPath, takeName, type CursorEvent, type KeyEvent, type Take, type Word } from "../types";
import { CARD_FADE, cardLength, createScene, frameState, overlayText, refreshTime, sceneSource, wordCuts, type CardView, type Scene } from "./composition";
import { confirmDialog, onContextMenu, type MenuItem } from "../menu";
import { ExportDialog } from "./export-dialog";
import { thumbnails, waveform } from "./media";
import { cursorPath } from "./motion";
import { OverlayPainter } from "./overlay";
import {
  ASPECTS,
  autoZooms,
  BACKGROUNDS,
  defaultProject,
  insertRange,
  newId,
  newNote,
  NOTE_COLORS,
  SPEEDS,
  STYLES,
  normalizeProject,
  outputSize,
  type Aspect,
  type BlurRegion,
  type Corner,
  type Frame,
  type Note,
  type NoteKind,
  type Project,
  type Range,
  type SpeedRange,
  type ZoomSegment,
} from "./project";
import { RectEditor } from "./rect-editor";
import { Renderer } from "./renderer";
import { SoundPreview } from "./sounds";
import { Timeline, type Selection, type Track, type TrackKey } from "./timeline";
import type { Span } from "./timemap";
import { LANGUAGES, preferredLanguage, rememberLanguage, SAMPLE_RATE, speech, transcribe } from "./transcribe";
import { fillerWords, findSilences } from "./cleanup";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const UNDO_LIMIT = 100;
/** Default lengths of items added at the playhead, in ms. */
const LENGTHS: Record<TrackKey, number> = { cuts: 1000, speed: 3000, zoom: 2000, notes: 3000, blurs: 3000 };
const NOTE_NAMES: Record<NoteKind, string> = { text: "Texto", arrow: "Seta", box: "Destaque" };
/** Rate of a new sped-up stretch. */
const DEFAULT_SPEED = 2;
const speedLabel = (rate: number) => `${String(rate).replace(".", ",")}×`;

/** "2,5×": zoom levels written the Brazilian way. */
const scaleLabel = (scale: number) => `${scale.toFixed(1).replace(".", ",")}×`;

function formatTime(ms: number) {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${(total - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(convertFileSrc(path));
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

async function fetchBytes(path: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(convertFileSrc(path));
    return response.ok ? await response.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Uploads a file the user picked into the take folder; returns its name there. */
async function saveAsset(dir: string, file: File, name: string): Promise<string> {
  const created = await invoke<{ id: number; path: string }>("asset_create", { dir, name });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunk = 4 * 1024 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    await invoke("export_write", bytes.subarray(offset, offset + chunk), {
      headers: { "x-export-id": String(created.id), "x-position": String(offset) },
    });
  }
  await invoke("export_finish", { id: created.id });
  return name;
}

export class Editor {
  private ui = {
    root: $("editor"),
    preview: $("preview"),
    wrap: $("canvas-wrap"),
    canvas: $<HTMLCanvasElement>("preview-canvas"),
    error: $("preview-error"),
    status: $("preview-status"),
    saveState: $("save-state"),
    video: $<HTMLVideoElement>("video"),
    webcam: $<HTMLVideoElement>("webcam-video"),
    mic: $<HTMLAudioElement>("mic"),
    play: $<HTMLButtonElement>("play"),
    time: $("time"),
    title: $("take-title"),
    undo: $<HTMLButtonElement>("undo"),
    redo: $<HTMLButtonElement>("redo"),
    reveal: $<HTMLButtonElement>("reveal"),
    exportButton: $<HTMLButtonElement>("export"),
    addCut: $<HTMLButtonElement>("add-cut"),
    addZoom: $<HTMLButtonElement>("add-zoom"),
    addLens: $<HTMLButtonElement>("add-lens"),
    addBlur: $<HTMLButtonElement>("add-blur"),
    addSpeed: $<HTMLButtonElement>("add-speed"),
    addNote: $<HTMLButtonElement>("add-note"),
    introEnabled: $<HTMLInputElement>("intro-enabled"),
    introFields: $("intro-fields"),
    introTitle: $<HTMLInputElement>("intro-title"),
    introSubtitle: $<HTMLInputElement>("intro-subtitle"),
    outroEnabled: $<HTMLInputElement>("outro-enabled"),
    outroFields: $("outro-fields"),
    outroTitle: $<HTMLInputElement>("outro-title"),
    outroSubtitle: $<HTMLInputElement>("outro-subtitle"),
    cardsDuration: $<HTMLInputElement>("cards-duration"),
    selectionNote: $("selection-note"),
    noteKind: $("note-kind"),
    noteTextField: $("note-text-field"),
    noteText: $<HTMLTextAreaElement>("note-text"),
    noteColors: $("note-colors"),
    noteSize: $<HTMLInputElement>("note-size"),
    noteDirection: $("note-direction"),
    notePlace: $<HTMLButtonElement>("note-place"),
    selectionSpeed: $("selection-speed"),
    speedRate: $("speed-rate"),
    tabs: [...document.querySelectorAll<HTMLButtonElement>(".tabs [data-tab]")],
    panels: [...document.querySelectorAll<HTMLElement>(".tab-panel")],
    backgrounds: $("bg-presets"),
    styles: $("styles"),
    bgImage: $<HTMLButtonElement>("bg-image"),
    bgFile: $<HTMLInputElement>("bg-file"),
    bgBlurRow: $("bg-blur-row"),
    bgBlur: $<HTMLInputElement>("bg-blur"),
    padding: $<HTMLInputElement>("padding"),
    radius: $<HTMLInputElement>("radius"),
    shadow: $<HTMLInputElement>("shadow"),
    aspect: $("aspect"),
    frame: $("frame"),
    tilt: $<HTMLInputElement>("tilt"),
    crop: $<HTMLButtonElement>("crop"),
    cropLabel: $("crop-label"),
    cursorNote: $("cursor-note"),
    cursorVisible: $<HTMLInputElement>("cursor-visible"),
    cursorSize: $<HTMLInputElement>("cursor-size"),
    smoothing: $<HTMLInputElement>("cursor-smoothing"),
    clickEffect: $<HTMLInputElement>("click-effect"),
    spotlight: $<HTMLInputElement>("spotlight"),
    clickSound: $<HTMLInputElement>("click-sound"),
    keysNote: $("keys-note"),
    keysVisible: $<HTMLInputElement>("keys-visible"),
    keysMode: $("keys-mode"),
    keySound: $<HTMLInputElement>("key-sound"),
    autoZoom: $<HTMLButtonElement>("auto-zoom"),
    cutSilences: $<HTMLButtonElement>("cut-silences"),
    silenceMin: $<HTMLInputElement>("silence-min"),
    cutFillers: $<HTMLButtonElement>("cut-fillers"),
    cleanupHint: $("cleanup-hint"),
    zoomDefault: $<HTMLInputElement>("zoom-default"),
    selection: $("selection"),
    selectionTitle: $("selection-title"),
    selectionTime: $("selection-time"),
    selectionZoom: $("selection-zoom"),
    selectionDelete: $<HTMLButtonElement>("selection-delete"),
    selectionDeleteLabel: $("selection-delete-label"),
    autoZoomHint: $("auto-zoom-hint"),
    zoomMode: $("zoom-mode"),
    zoomScale: $<HTMLInputElement>("zoom-scale"),
    blurArea: $<HTMLButtonElement>("blur-area"),
    shortcuts: $<HTMLButtonElement>("shortcuts"),
    shortcutsOpen: $<HTMLButtonElement>("shortcuts-open"),
    shortcutsModal: $("shortcuts-modal"),
    shortcutsClose: $<HTMLButtonElement>("shortcuts-close"),
    volumeHint: $("volume-hint"),
    webcamNote: $("webcam-note"),
    webcamVisible: $<HTMLInputElement>("webcam-visible"),
    webcamSize: $<HTMLInputElement>("webcam-size"),
    webcamCorner: $("webcam-corner"),
    webcamShape: $("webcam-shape"),
    volumeSystem: $<HTMLInputElement>("volume-system"),
    volumeMic: $<HTMLInputElement>("volume-mic"),
    enhance: $<HTMLInputElement>("enhance"),
    enhanceHint: $("enhance-hint"),
    musicPick: $<HTMLButtonElement>("music-pick"),
    musicLabel: $("music-label"),
    musicRemove: $<HTMLButtonElement>("music-remove"),
    musicFile: $<HTMLInputElement>("music-file"),
    volumeMusic: $<HTMLInputElement>("volume-music"),
    transcribe: $<HTMLButtonElement>("transcribe"),
    transcribeLanguage: $<HTMLSelectElement>("transcribe-language"),
    transcribeStatus: $("transcript-status"),
    transcribeProgress: $("transcribe-progress"),
    captionsSection: $("captions-section"),
    captionsVisible: $<HTMLInputElement>("captions-visible"),
    captionsSize: $<HTMLInputElement>("captions-size"),
    captionsPosition: $("captions-position"),
    transcriptSection: $("transcript-section"),
    transcript: $("transcript"),
  };

  private renderer: Renderer | null = null;
  private scene: Scene | null = null;
  private selected: Selection = null;
  private saveTimer: number | undefined;
  private timeline: Timeline;
  private rectEditor = new RectEditor();
  /** While the area editor is open, the preview shows the whole recording without effects. */
  private rawView = false;
  private overlay = new OverlayPainter(1920, 1080);
  private sounds = new SoundPreview();
  private music = new Audio();
  private exportDialog = new ExportDialog();
  private thumbs: { t: number; image: ImageBitmap }[] = [];
  private wave: Float32Array | null = null;
  private backgroundKey = "";
  private lastTimelineKey = "";
  /** Bumped on every project or selection change, so a paused preview knows to redraw. */
  private version = 0;
  private lastRenderKey = "";
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** The project as it was before the current burst of edits; pushed to undo when the burst is saved. */
  private burstStart: string | null = null;
  private wordSelection: { from: number; to: number } | null = null;
  /** Stretch selected by dragging over the clip; tools and Delete act on it. */
  private range: Span | null = null;
  /** A title card playing in the preview, before or after the video. */
  private card: { kind: "intro" | "outro"; started: number } | null = null;
  private playIcons: { play: Element; pause: Element } | null = null;
  /** True while the microphone is being enhanced, so other edits don't reset the switch. */
  private enhancing = false;

  constructor() {
    this.timeline = new Timeline($<HTMLCanvasElement>("timeline"), {
      seek: (time) => this.seek(time),
      trim: (trim) => this.change((project) => (project.trim = trim), false),
      change: (track, items) => this.change((project) => this.setTrack(project, track, items), false),
      select: (selection) => this.select(selection),
      range: (range) => this.setRange(range),
      add: (track, time) => this.addAt(track, time),
      commit: () => this.save(),
    });
    this.buildInspector();
    this.buildMenus();
    this.bindPlayback();
    this.bindShortcuts();
    this.music.loop = true;
    requestAnimationFrame(() => this.frame());
  }

  get currentTakeId() {
    return this.scene?.take.id ?? null;
  }

  // ---------- loading ----------

  async open(take: Take) {
    this.flushSave();
    this.ui.video.pause();
    this.rectEditor.close();

    const cursor = await fetchJson<{ events: CursorEvent[] }>(joinPath(take.dir, take.cursor));
    const keys = take.keys ? await fetchJson<{ events: KeyEvent[] }>(joinPath(take.dir, take.keys)) : null;
    const transcript = await fetchJson<{ words: Word[] }>(joinPath(take.dir, "transcript.json"));
    const events = cursor?.events ?? [];

    const fallback = defaultProject(take, events);
    let project = fallback;
    try {
      const saved = await invoke<string | null>("load_project", { dir: take.dir });
      if (saved) project = normalizeProject(JSON.parse(saved), fallback);
    } catch (error) {
      console.warn("projeto não carregado", error);
    }

    this.scene = createScene(take, project, events, keys?.events ?? [], transcript?.words ?? []);
    refreshTime(this.scene);
    this.selected = null;
    this.range = null;
    this.wordSelection = null;
    this.undoStack = [];
    this.redoStack = [];
    this.burstStart = null;
    this.thumbs = [];
    this.wave = null;
    this.backgroundKey = "";
    this.setSaveState("");
    this.updateUndoButtons();

    const ui = this.ui;
    ui.root.hidden = false;
    ui.status.hidden = false;
    ui.error.hidden = true;
    ui.title.textContent = takeName(take);
    ui.video.src = convertFileSrc(joinPath(take.dir, take.video));
    this.loadMic();
    if (take.webcam) ui.webcam.src = convertFileSrc(joinPath(take.dir, take.webcam));
    else ui.webcam.removeAttribute("src");
    this.loadMusic();
    ui.video.currentTime = this.scene.time.spans[0]?.start / 1000 || 0;
    this.renderTranscript();
    this.syncInspector();
    await this.ensureRenderer();
    void this.loadBackground();
    // First time in the editor: a short tour of the essentials.
    window.setTimeout(() => {
      if (this.ui.root.hidden) return;
      showTour("editor", [
        {
          target: () => document.querySelector<HTMLElement>(".timeline-wrap"),
          title: "Corte arrastando",
          text: "Arraste sobre o vídeo na timeline para selecionar um trecho e aperte Delete para cortar. Zoom, Lente e Desfocar também usam o trecho selecionado.",
        },
        {
          target: () => this.ui.styles,
          title: "Comece por um estilo",
          text: "Um clique muda fundo, moldura e cursor. Depois ajuste o que quiser nas abas.",
        },
        {
          target: () => this.ui.preview,
          title: "Botão direito",
          text: "Clique com o botão direito na prévia, na timeline ou na lista para ver as opções de cada lugar.",
        },
        {
          target: () => this.ui.exportButton,
          title: "Exporte",
          text: "Quando estiver pronto, exporte em MP4 ou GIF. Tudo se salva sozinho enquanto você edita.",
        },
      ]);
    }, 600);
    void this.loadStrip(take);
  }

  /** Thumbnails and waveform for the timeline, in the background. */
  private async loadStrip(take: Take) {
    const recording = await fetchBytes(joinPath(take.dir, take.video));
    if (!recording || this.scene?.take.id !== take.id) return;
    const sources: ArrayBuffer[] = [];
    if (take.systemAudio) sources.push(recording);
    if (take.mic) {
      const mic = await fetchBytes(joinPath(take.dir, take.mic));
      if (mic) sources.push(mic);
    }
    const [thumbs, wave] = await Promise.all([
      thumbnails(recording, take).catch(() => []),
      waveform(sources, take.durationMs).catch(() => null),
    ]);
    if (this.scene?.take.id !== take.id) {
      for (const thumb of thumbs) thumb.image.close();
      return;
    }
    this.thumbs = thumbs;
    this.wave = wave;
    this.lastTimelineKey = "";
  }

  private async ensureRenderer() {
    if (this.renderer) return;
    try {
      this.renderer = await Renderer.create(this.ui.canvas);
      this.ui.error.hidden = true;
    } catch (error) {
      this.ui.error.hidden = false;
      this.ui.error.textContent = `Não foi possível iniciar a renderização: ${error}`;
    }
  }

  /** Loads, blurs and uploads the background image when it or its blur changes. */
  private async loadBackground() {
    const scene = this.scene;
    if (!scene || !this.renderer) return;
    const { background } = scene.project;
    const key = background.kind === "image" && background.image ? `${scene.take.dir}|${background.image}|${background.blur}` : "";
    if (key === this.backgroundKey) return;
    this.backgroundKey = key;
    if (!key) {
      this.renderer.setBackground(null);
      this.version++;
      return;
    }
    const canvas = await blurredImage(joinPath(scene.take.dir, background.image!), background.blur);
    if (this.backgroundKey !== key || !this.renderer) return;
    this.renderer.setBackground(canvas);
    this.version++;
  }

  private loadMusic() {
    const scene = this.scene;
    const music = scene?.project.audio.music;
    if (scene && music) this.music.src = convertFileSrc(joinPath(scene.take.dir, music));
    else this.music.removeAttribute("src");
    this.music.volume = Math.min(1, scene?.project.audio.musicVolume ?? 0.25);
  }

  // ---------- project changes ----------

  /** Applies a change; `save` false defers saving until a drag ends. */
  private change(mutate: (project: Project) => void, save = true) {
    const scene = this.scene;
    if (!scene) return;
    this.burstStart ??= JSON.stringify(scene.project);
    mutate(scene.project);
    refreshTime(scene);
    this.syncInspector();
    if (save) this.save();
  }

  private setTrack(project: Project, track: TrackKey, items: Range[]) {
    if (track === "cuts") project.cuts = items;
    else if (track === "speed") project.speed = items as SpeedRange[];
    else if (track === "notes") project.notes = items as Note[];
    else if (track === "zoom") project.zoom.segments = items as ZoomSegment[];
    else project.blurs = items as BlurRegion[];
  }

  private trackItems(project: Project, track: TrackKey): Range[] {
    if (track === "notes") return project.notes;
    return track === "cuts" ? project.cuts : track === "speed" ? project.speed : track === "zoom" ? project.zoom.segments : project.blurs;
  }

  /** Replaces the whole project (undo/redo) and rebuilds what depends on it. */
  private restore(json: string, write = true) {
    const scene = this.scene;
    if (!scene) return;
    const before = scene.project;
    scene.project = JSON.parse(json);
    if (scene.project.cursor.smoothing !== before.cursor.smoothing) {
      scene.cursor = cursorPath(scene.raw, scene.take.durationMs, scene.project.cursor.smoothing);
    }
    refreshTime(scene);
    if (this.selected && !this.trackItems(scene.project, this.selected.track).some((item) => item.id === this.selected!.id)) this.selected = null;
    this.syncInspector();
    this.renderTranscript();
    this.loadMusic();
    this.loadMic();
    void this.loadBackground();
    if (write) this.writeProject();
    else this.updateUndoButtons();
  }

  undo() {
    this.flushSave();
    const scene = this.scene;
    const previous = this.undoStack.pop();
    if (!scene || previous === undefined) {
      toast("Nada para desfazer");
      return;
    }
    this.redoStack.push(JSON.stringify(scene.project));
    this.restore(previous);
  }

  redo() {
    this.flushSave();
    const scene = this.scene;
    const next = this.redoStack.pop();
    if (!scene || next === undefined) {
      toast("Nada para refazer");
      return;
    }
    this.undoStack.push(JSON.stringify(scene.project));
    this.restore(next);
  }

  private setSaveState(state: "" | "saving" | "saved" | "error") {
    const labels = { "": "", saving: "Salvando…", saved: "Salvo", error: "Erro ao salvar" };
    this.ui.saveState.className = `save-state ${state}`;
    this.ui.saveState.textContent = labels[state];
  }

  private save() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 400);
  }

  private flushSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.scene || this.burstStart === null) return;
    if (this.burstStart !== JSON.stringify(this.scene.project)) {
      this.undoStack.push(this.burstStart);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.writeProject();
    }
    this.burstStart = null;
    this.updateUndoButtons();
  }

  private writeProject() {
    const scene = this.scene;
    if (!scene) return;
    this.setSaveState("saving");
    this.updateUndoButtons();
    invoke("save_project", { dir: scene.take.dir, json: JSON.stringify(scene.project, null, 2) })
      .then(() => this.setSaveState("saved"))
      .catch((error) => {
        console.error("falha ao salvar o projeto", error);
        this.setSaveState("error");
      });
  }

  private updateUndoButtons() {
    this.ui.undo.disabled = this.undoStack.length === 0 && this.burstStart === null;
    this.ui.redo.disabled = this.redoStack.length === 0;
  }

  private select(selection: Selection) {
    this.selected = selection;
    if (selection) this.showTab("zoom");
    this.syncInspector();
  }

  // ---------- adding and removing timeline items ----------

  private addAt(track: TrackKey, time: number) {
    const scene = this.scene;
    if (!scene) return;
    const { project, take } = scene;
    const items = this.trackItems(project, track);
    const make = (range: Range): Range => {
      if (track === "zoom") return { ...range, scale: project.zoom.defaultScale, mode: "zoom" } as ZoomSegment;
      if (track === "speed") return { ...range, rate: DEFAULT_SPEED } as SpeedRange;
      if (track === "notes") return newNote(range);
      if (track === "blurs") {
        const source = sceneSource(scene);
        const area = project.crop ?? { x: 0, y: 0, width: take.width, height: take.height };
        return { ...range, x: area.x + source.width * 0.35, y: area.y + source.height * 0.35, width: source.width * 0.3, height: source.height * 0.3 } as BlurRegion;
      }
      return range;
    };
    const result = insertRange(items, time, LENGTHS[track], take.durationMs, make);
    if (!result.created) {
      if (result.id) this.select({ track, id: result.id });
      toast("Já existe um trecho aqui; ele foi selecionado");
      return;
    }
    this.change((p) => this.setTrack(p, track, result.ranges));
    this.flushSave();
    this.select({ track, id: result.id });
    if (track === "blurs") this.editBlurArea();
    if (track === "notes") this.focusNoteText();
  }

  private addLensAt(time: number) {
    const scene = this.scene;
    if (!scene) return;
    const { project, take } = scene;
    const result = insertRange(project.zoom.segments, time, LENGTHS.zoom, take.durationMs, (range) => ({ ...range, scale: project.zoom.defaultScale, mode: "lens" as const }));
    if (!result.created) {
      if (result.id) this.select({ track: "zoom", id: result.id });
      toast("Já existe um trecho aqui; ele foi selecionado");
      return;
    }
    this.change((p) => (p.zoom.segments = result.ranges));
    this.flushSave();
    this.select({ track: "zoom", id: result.id });
  }

  private setRange(range: Span | null) {
    this.range = range;
    if (range) this.selected = null;
    this.syncInspector();
  }

  /**
   * A tool (button, key or menu): applies to the dragged stretch if there is one, otherwise to a
   * stretch of the default length at the playhead.
   */
  private useTool(tool: TrackKey | "lens") {
    const t = this.ui.video.currentTime * 1000;
    if (this.range) this.addRange(tool, this.range);
    else if (tool === "lens") this.addLensAt(t);
    else this.addAt(tool, t);
  }

  /** Adds an item covering exactly `range`. Cuts merge with overlapping cuts; others can't overlap. */
  private addRange(tool: TrackKey | "lens", range: Span) {
    const scene = this.scene;
    if (!scene) return;
    const { project, take } = scene;
    const track: TrackKey = tool === "lens" ? "zoom" : tool;
    const items = this.trackItems(project, track);
    const overlapping = items.filter((item) => item.start < range.end && item.end > range.start);
    const id = newId();

    if (track === "cuts") {
      const start = Math.min(range.start, ...overlapping.map((item) => item.start));
      const end = Math.max(range.end, ...overlapping.map((item) => item.end));
      const cuts = [...items.filter((item) => !overlapping.includes(item)), { id, start, end }].sort((a, b) => a.start - b.start);
      this.change((p) => (p.cuts = cuts));
      toast(`Trecho de ${((end - start) / 1000).toFixed(1).replace(".", ",")} s cortado`, { label: "Desfazer", run: () => this.undo() });
    } else {
      if (overlapping.length) {
        this.select({ track, id: overlapping[0].id });
        toast("Já existe um trecho nessa parte; ele foi selecionado");
        return;
      }
      const base = { id, start: range.start, end: range.end };
      let item: Range;
      if (track === "zoom") {
        item = { ...base, scale: project.zoom.defaultScale, mode: tool === "lens" ? "lens" : "zoom" } as ZoomSegment;
      } else if (track === "speed") {
        item = { ...base, rate: DEFAULT_SPEED } as SpeedRange;
      } else if (track === "notes") {
        item = newNote(base);
      } else {
        const source = sceneSource(scene);
        const area = project.crop ?? { x: 0, y: 0, width: take.width, height: take.height };
        item = { ...base, x: area.x + source.width * 0.35, y: area.y + source.height * 0.35, width: source.width * 0.3, height: source.height * 0.3 } as BlurRegion;
      }
      this.change((p) => this.setTrack(p, track, [...items, item].sort((a, b) => a.start - b.start)));
    }
    this.flushSave();
    this.range = null;
    if (track !== "cuts") this.select({ track, id });
    else this.syncInspector();
    if (track === "blurs") this.editBlurArea();
    if (track === "notes") this.focusNoteText();
  }

  private rangeMenu(): MenuItem[] {
    const range = this.range!;
    const seconds = `${((range.end - range.start) / 1000).toFixed(1).replace(".", ",")} s`;
    return [
      { label: `Cortar este trecho (${seconds})`, icon: "cut", danger: true, shortcut: "Delete", action: () => this.useTool("cuts") },
      { label: "Zoom neste trecho", icon: "zoom", shortcut: "Z", action: () => this.useTool("zoom") },
      { label: "Lente neste trecho", icon: "wand", shortcut: "L", action: () => this.useTool("lens") },
      { label: "Acelerar este trecho", icon: "speed", shortcut: "S", action: () => this.useTool("speed") },
      { label: "Texto neste trecho", icon: "text", shortcut: "T", action: () => this.useTool("notes") },
      { label: "Desfocar uma área neste trecho", icon: "blur", shortcut: "B", action: () => this.useTool("blurs") },
      "separator",
      { label: "Reproduzir o trecho", icon: "play", action: () => { this.seek(range.start); if (this.ui.video.paused) this.togglePlay(); } },
      { label: "Tirar a seleção", icon: "close", shortcut: "Esc", action: () => this.setRange(null) },
    ];
  }

  private deleteSelected() {
    const selection = this.selected;
    if (!selection) return;
    this.selected = null;
    this.change((project) => this.setTrack(project, selection.track, this.trackItems(project, selection.track).filter((item) => item.id !== selection.id)));
    this.flushSave();
    const removed = this.selectedKind(selection);
    const names = { cut: "Corte removido", zoom: "Zoom removido", lens: "Lente removida", blur: "Desfoque removido", speed: "Trecho voltou à velocidade normal", text: "Texto removido", arrow: "Seta removida", box: "Destaque removido" };
    toast(names[removed], { label: "Desfazer", run: () => this.undo() });
  }

  /** The kind of a selected item, for labels: cut, speed, zoom, lens or blur. */
  private selectedKind(selection: Selection): "cut" | "speed" | "zoom" | "lens" | "blur" | NoteKind {
    if (!selection || selection.track === "cuts") return "cut";
    if (selection.track === "blurs") return "blur";
    if (selection.track === "speed") return "speed";
    if (selection.track === "notes") return this.scene?.project.notes.find((note) => note.id === selection.id)?.kind ?? "text";
    const item = this.scene?.project.zoom.segments.find((segment) => segment.id === selection.id);
    return item?.mode === "lens" ? "lens" : "zoom";
  }

  private selectedItem<T extends Range>(): T | null {
    const scene = this.scene;
    const selection = this.selected;
    if (!scene || !selection) return null;
    return (this.trackItems(scene.project, selection.track).find((item) => item.id === selection.id) as T) ?? null;
  }

  // ---------- context menus ----------

  private buildMenus() {
    const timeline = $<HTMLCanvasElement>("timeline");
    onContextMenu(timeline, (event) => {
      const at = this.timeline.contextAt(event.offsetX, event.offsetY);
      if (!at || !this.scene) return null;
      if (at.kind === "range") return this.rangeMenu();
      if (at.kind === "item") return this.itemMenu(at.track, at.id);
      if (at.kind === "track") return this.trackMenu(at.track, at.time);
      return this.clipMenu(at.time);
    });
    onContextMenu(this.ui.canvas, () => (this.scene && !this.rectEditor.isOpen ? this.previewMenu() : null));
    onContextMenu(this.ui.transcript, (event) => {
      const word = (event.target as HTMLElement).closest<HTMLElement>(".word");
      return word ? this.wordMenu(Number(word.dataset.i)) : null;
    });
  }

  private itemMenu(track: TrackKey, id: string): MenuItem[] {
    const scene = this.scene!;
    const item = this.trackItems(scene.project, track).find((candidate) => candidate.id === id);
    if (!item) return [];
    this.select({ track, id });
    const go = [
      { label: "Ir para o início", icon: "play", action: () => this.seek(item.start) },
      { label: "Ir para o fim", icon: "play", action: () => this.seek(Math.max(item.start, item.end - 1)) },
    ];
    if (track === "zoom") {
      const zoom = item as ZoomSegment;
      const setScale = (scale: number) => this.change((p) => {
        const target = p.zoom.segments.find((candidate) => candidate.id === id);
        if (target) target.scale = Math.round(Math.min(4, Math.max(1.2, scale)) * 10) / 10;
      });
      return [
        ...go,
        "separator",
        {
          label: zoom.mode === "lens" ? "Trocar para zoom de câmera" : "Trocar para lente",
          icon: zoom.mode === "lens" ? "zoom" : "wand",
          action: () => this.change((p) => {
            const target = p.zoom.segments.find((candidate) => candidate.id === id);
            if (target) target.mode = target.mode === "lens" ? "zoom" : "lens";
          }),
        },
        { label: `Aumentar (${scaleLabel(zoom.scale + 0.5)})`, icon: "plus", disabled: zoom.scale >= 4 ? "Já está no máximo (4×)" : false, action: () => setScale(zoom.scale + 0.5) },
        { label: `Diminuir (${scaleLabel(Math.max(1.2, zoom.scale - 0.5))})`, icon: "zoom", disabled: zoom.scale <= 1.2 ? "Já está no mínimo (1,2×)" : false, action: () => setScale(zoom.scale - 0.5) },
        "separator",
        { label: zoom.mode === "lens" ? "Remover lente" : "Remover zoom", icon: "trash", danger: true, shortcut: "Delete", action: () => this.deleteSelected() },
      ];
    }
    if (track === "notes") {
      const note = item as Note;
      return [
        ...go,
        "separator",
        { label: "Posicionar no vídeo…", icon: "crop", action: () => this.editNotePosition() },
        ...(["text", "arrow", "box"] as NoteKind[])
          .filter((kind) => kind !== note.kind)
          .map((kind): MenuItem => ({ label: `Trocar para ${NOTE_NAMES[kind].toLowerCase()}`, icon: "text", action: () => this.setNoteKind(id, kind) })),
        "separator",
        { label: `Remover ${NOTE_NAMES[note.kind].toLowerCase()}`, icon: "trash", danger: true, shortcut: "Delete", action: () => this.deleteSelected() },
      ];
    }
    if (track === "speed") {
      const current = (item as SpeedRange).rate;
      return [
        ...go,
        "separator",
        ...SPEEDS.map((rate): MenuItem => ({
          label: rate === current ? `${speedLabel(rate)} (atual)` : `Velocidade ${speedLabel(rate)}`,
          icon: "speed",
          disabled: rate === current ? "Já está nesta velocidade" : false,
          action: () => this.setSpeed(id, rate),
        })),
        "separator",
        { label: "Voltar à velocidade normal", icon: "trash", danger: true, shortcut: "Delete", action: () => this.deleteSelected() },
      ];
    }
    if (track === "blurs") {
      return [
        ...go,
        "separator",
        { label: "Ajustar área…", icon: "crop", action: () => this.editBlurArea() },
        "separator",
        { label: "Remover desfoque", icon: "trash", danger: true, shortcut: "Delete", action: () => this.deleteSelected() },
      ];
    }
    return [...go, "separator", { label: "Remover corte (trazer o trecho de volta)", icon: "trash", danger: true, shortcut: "Delete", action: () => this.deleteSelected() }];
  }

  private trackMenu(track: TrackKey, time: number): MenuItem[] {
    const add: Record<TrackKey, MenuItem> = {
      cuts: { label: "Cortar um trecho aqui", icon: "cut", shortcut: "X", action: () => this.addAt("cuts", time) },
      speed: { label: "Acelerar um trecho aqui", icon: "speed", shortcut: "S", action: () => this.addAt("speed", time) },
      notes: { label: "Adicionar texto aqui", icon: "text", shortcut: "T", action: () => this.addAt("notes", time) },
      zoom: { label: "Adicionar zoom aqui", icon: "zoom", shortcut: "Z", action: () => this.addAt("zoom", time) },
      blurs: { label: "Desfocar uma área aqui", icon: "blur", shortcut: "B", action: () => this.addAt("blurs", time) },
    };
    const items: MenuItem[] = [add[track]];
    if (track === "zoom") items.push({ label: "Adicionar lente aqui", icon: "wand", shortcut: "L", action: () => this.addLensAt(time) });
    if (track === "zoom") items.push({ label: "Gerar zooms a partir dos cliques", icon: "wand", action: () => this.ui.autoZoom.click() });
    items.push("separator", { label: "Ir para este ponto", icon: "play", action: () => this.seek(time) });
    return items;
  }

  private clipMenu(time: number): MenuItem[] {
    const scene = this.scene!;
    const { trim } = scene.project;
    const trimmed = trim.start > 0 || trim.end < scene.take.durationMs;
    return [
      { label: "Reproduzir daqui", icon: "play", action: () => { this.seek(time); if (this.ui.video.paused) this.togglePlay(); } },
      "separator",
      { label: "Começar o vídeo aqui", icon: "cut", disabled: time >= trim.end - 500 ? "Precisa ficar antes do fim" : false, action: () => this.change((p) => (p.trim = { ...p.trim, start: time })) },
      { label: "Terminar o vídeo aqui", icon: "cut", disabled: time <= trim.start + 500 ? "Precisa ficar depois do início" : false, action: () => this.change((p) => (p.trim = { ...p.trim, end: time })) },
      { label: "Restaurar início e fim", icon: "undo", disabled: trimmed ? false : "O vídeo já está inteiro", action: () => this.change((p) => (p.trim = { start: 0, end: scene.take.durationMs })) },
      "separator",
      { label: "Cortar um trecho aqui", icon: "cut", shortcut: "X", action: () => this.addAt("cuts", time) },
      { label: "Adicionar zoom aqui", icon: "zoom", shortcut: "Z", action: () => this.addAt("zoom", time) },
    ];
  }

  private previewMenu(): MenuItem[] {
    const scene = this.scene!;
    const t = this.ui.video.currentTime * 1000;
    const playing = !this.ui.video.paused;
    return [
      { label: playing ? "Pausar" : "Reproduzir", icon: playing ? "pause" : "play", shortcut: "Espaço", action: () => this.togglePlay() },
      "separator",
      { label: "Zoom aqui", icon: "zoom", shortcut: "Z", action: () => this.addAt("zoom", t) },
      { label: "Lente aqui", icon: "wand", shortcut: "L", action: () => this.addLensAt(t) },
      { label: "Desfocar uma área", icon: "blur", shortcut: "B", action: () => this.addAt("blurs", t) },
      { label: "Acelerar um trecho aqui", icon: "speed", shortcut: "S", action: () => this.addAt("speed", t) },
      { label: "Adicionar texto aqui", icon: "text", shortcut: "T", action: () => this.addAt("notes", t) },
      { label: "Cortar um trecho aqui", icon: "cut", shortcut: "X", action: () => this.addAt("cuts", t) },
      "separator",
      { label: scene.project.crop ? "Ajustar área recortada…" : "Recortar área…", icon: "crop", action: () => this.editCrop() },
      { label: "Mostrar o vídeo inteiro", icon: "monitor", disabled: scene.project.crop ? false : "Não há recorte", action: () => this.change((p) => (p.crop = null)) },
      "separator",
      { label: "Exportar…", icon: "export", shortcut: "Ctrl+E", action: () => this.openExport() },
    ];
  }

  private wordMenu(index: number): MenuItem[] {
    const scene = this.scene!;
    const word = scene.words.find((candidate) => candidate.i === index);
    if (!word) return [];
    const selection = this.wordSelection;
    const inSelection = selection && index >= Math.min(selection.from, selection.to) && index <= Math.max(selection.from, selection.to);
    if (!inSelection) {
      this.wordSelection = { from: index, to: index };
      this.renderTranscript();
    }
    const range = this.wordSelection!;
    const count = Math.abs(range.to - range.from) + 1;
    const deleted = new Set(scene.project.deletedWords);
    const ids = scene.words.filter((w) => w.i >= Math.min(range.from, range.to) && w.i <= Math.max(range.from, range.to)).map((w) => w.i);
    const restore = ids.every((id) => deleted.has(id));
    return [
      { label: "Ir para esta palavra", icon: "play", action: () => this.seek(word.t0) },
      "separator",
      restore
        ? { label: count > 1 ? `Restaurar ${count} palavras` : "Restaurar palavra", icon: "undo", shortcut: "Delete", action: () => this.toggleWords() }
        : { label: count > 1 ? `Cortar ${count} palavras` : "Cortar palavra", icon: "cut", danger: true, shortcut: "Delete", action: () => this.toggleWords() },
      {
        label: "Restaurar todas as palavras",
        icon: "undo",
        disabled: deleted.size ? false : "Nenhuma palavra cortada",
        action: async () => {
          if (!(await confirmDialog({ title: "Restaurar todas as palavras?", message: "Todos os trechos cortados pela transcrição voltam para o vídeo.", confirm: "Restaurar" }))) return;
          this.change((p) => (p.deletedWords = []));
          this.renderTranscript();
        },
      },
    ];
  }

  // ---------- area editor ----------

  private openRectEditor(title: string, rect: { x: number; y: number; width: number; height: number }, allowReset: boolean, apply: (rect: BlurRegion | null | { x: number; y: number; width: number; height: number }) => void) {
    const scene = this.scene;
    if (!scene) return;
    this.ui.video.pause();
    this.rawView = true;
    this.version++;
    this.rectEditor.open({
      title,
      video: { width: scene.take.width, height: scene.take.height },
      rect,
      allowReset,
      onApply: (result) => apply(result as never),
      onClose: () => {
        this.rawView = false;
        this.version++;
      },
    });
  }

  private editCrop() {
    const scene = this.scene;
    if (!scene) return;
    const { take, project } = scene;
    const rect = project.crop ?? { x: Math.round(take.width * 0.1), y: Math.round(take.height * 0.1), width: Math.round(take.width * 0.8 / 2) * 2, height: Math.round(take.height * 0.8 / 2) * 2 };
    this.openRectEditor("Recortar área", rect, true, (result) => {
      this.change((p) => (p.crop = result ? { x: result.x, y: result.y, width: result.width, height: result.height } : null));
      toast(result ? "Área recortada" : "Mostrando o vídeo inteiro", { label: "Desfazer", run: () => this.undo() });
    });
  }

  private editBlurArea() {
    const blur = this.selectedItem<BlurRegion>();
    if (!blur || this.selected?.track !== "blurs") return;
    const id = blur.id;
    this.openRectEditor("Área a desfocar", { x: blur.x, y: blur.y, width: blur.width, height: blur.height }, false, (result) => {
      if (!result) return;
      this.change((p) => (p.blurs = p.blurs.map((item) => (item.id === id ? { ...item, ...result, id, start: item.start, end: item.end } : item))));
    });
  }

  // ---------- inspector ----------

  private showTab(tab: string | null) {
    if (!tab) return;
    for (const button of this.ui.tabs) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    for (const panel of this.ui.panels) panel.hidden = panel.dataset.panel !== tab;
  }

  private radios(group: HTMLElement, apply: (value: string) => void) {
    group.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      if (input.type === "radio" && input.checked) apply(input.value);
    });
  }

  private setRadio(group: HTMLElement, value: string) {
    for (const input of group.querySelectorAll<HTMLInputElement>("input[type=radio]")) input.checked = input.value === value;
  }

  private buildInspector() {
    const ui = this.ui;
    for (const tab of ui.tabs) tab.addEventListener("click", () => this.showTab(tab.dataset.tab!));

    ui.backgrounds.replaceChildren(
      ...BACKGROUNDS.map((preset) => {
        const swatch = document.createElement("button");
        swatch.className = "swatch";
        swatch.title = preset.name;
        swatch.setAttribute("aria-label", `Fundo ${preset.name}`);
        swatch.dataset.id = preset.id;
        swatch.style.background = `linear-gradient(${preset.angle + 90}deg, ${preset.from}, ${preset.to})`;
        swatch.addEventListener("click", () =>
          this.change((project) => {
            project.background.kind = "gradient";
            project.background.preset = preset.id;
          }),
        );
        return swatch;
      }),
    );
    ui.styles.replaceChildren(
      ...STYLES.map((style) => {
        const card = document.createElement("button");
        card.className = "style-card";
        card.dataset.id = style.id;
        card.title = style.description;
        card.setAttribute("role", "listitem");
        // Preview the look on a copy of a default project.
        const sample = defaultProject({ ...(this.scene?.take ?? ({ durationMs: 1, width: 1920, height: 1080, cursorInVideo: false } as Take)) }, []);
        style.apply(sample);
        const preset = BACKGROUNDS.find((candidate) => candidate.id === sample.background.preset) ?? BACKGROUNDS[0];
        const thumb = document.createElement("span");
        thumb.className = "style-thumb";
        thumb.style.background = `linear-gradient(${preset.angle + 90}deg, ${preset.from}, ${preset.to})`;
        const screen = document.createElement("span");
        screen.className = `screen ${sample.frame}${sample.aspect === "9:16" ? " vertical" : ""}`;
        screen.style.setProperty("--w", `${Math.round((1 - sample.background.padding * 2.6) * 100)}%`);
        screen.style.setProperty("--r", `${Math.round(sample.background.radius / 4)}px`);
        screen.style.setProperty("--s", String(sample.background.shadow * 0.6));
        thumb.append(screen);
        const name = document.createElement("strong");
        name.textContent = style.name;
        card.append(thumb, name);
        card.addEventListener("click", () => {
          this.change((project) => style.apply(project));
          this.flushSave();
          toast(`Estilo “${style.name}” aplicado`, { label: "Desfazer", run: () => this.undo() });
        });
        return card;
      }),
    );
    ui.aspect.replaceChildren(
      ...ASPECTS.map((aspect) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "aspect";
        input.value = aspect.id;
        label.append(input, aspect.name);
        return label;
      }),
    );

    const range = (input: HTMLInputElement, apply: (project: Project, value: number) => void) => {
      input.addEventListener("input", () => {
        this.change((project) => apply(project, Number(input.value)), false);
        this.showValue(input);
      });
      input.addEventListener("change", () => this.save());
    };
    const toggle = (input: HTMLInputElement, apply: (project: Project, value: boolean) => void) =>
      input.addEventListener("change", () => this.change((project) => apply(project, input.checked)));

    range(ui.padding, (p, v) => (p.background.padding = v));
    range(ui.radius, (p, v) => (p.background.radius = v));
    range(ui.shadow, (p, v) => (p.background.shadow = v));
    range(ui.tilt, (p, v) => (p.tilt = v));
    range(ui.cursorSize, (p, v) => (p.cursor.size = v));
    range(ui.zoomDefault, (p, v) => (p.zoom.defaultScale = v));
    range(ui.zoomScale, (p, v) => {
      const segment = p.zoom.segments.find((candidate) => candidate.id === this.selected?.id);
      if (segment) segment.scale = v;
    });
    range(ui.webcamSize, (p, v) => (p.webcam.size = v));
    range(ui.volumeSystem, (p, v) => (p.audio.system = v));
    range(ui.volumeMic, (p, v) => (p.audio.mic = v));
    range(ui.volumeMusic, (p, v) => {
      p.audio.musicVolume = v;
      this.music.volume = Math.min(1, v);
    });
    range(ui.captionsSize, (p, v) => (p.captions.size = v));
    // Blurring the background image and smoothing the cursor are heavier; apply when the slider settles.
    ui.bgBlur.addEventListener("input", () => this.showValue(ui.bgBlur));
    ui.bgBlur.addEventListener("change", () => {
      this.change((p) => (p.background.blur = Number(ui.bgBlur.value)));
      void this.loadBackground();
    });
    ui.smoothing.addEventListener("input", () => this.showValue(ui.smoothing));
    ui.smoothing.addEventListener("change", () => {
      const scene = this.scene;
      if (!scene) return;
      this.change((p) => (p.cursor.smoothing = Number(ui.smoothing.value)));
      scene.cursor = cursorPath(scene.raw, scene.take.durationMs, scene.project.cursor.smoothing);
    });

    toggle(ui.cursorVisible, (p, v) => (p.cursor.visible = v));
    toggle(ui.clickEffect, (p, v) => (p.cursor.clickEffect = v));
    toggle(ui.spotlight, (p, v) => (p.cursor.spotlight = v));
    toggle(ui.clickSound, (p, v) => (p.audio.clickSound = v));
    toggle(ui.keysVisible, (p, v) => (p.keys.visible = v));
    toggle(ui.keySound, (p, v) => (p.audio.keySound = v));
    toggle(ui.webcamVisible, (p, v) => (p.webcam.visible = v));
    ui.enhance.addEventListener("change", () => void this.setEnhance(ui.enhance.checked));
    toggle(ui.captionsVisible, (p, v) => (p.captions.visible = v));
    toggle(ui.introEnabled, (p, v) => (p.cards.intro.enabled = v));
    toggle(ui.outroEnabled, (p, v) => (p.cards.outro.enabled = v));
    const text = (input: HTMLInputElement, apply: (project: Project, value: string) => void) =>
      input.addEventListener("input", () => this.change((project) => apply(project, input.value)));
    text(ui.introTitle, (p, v) => (p.cards.intro.title = v));
    text(ui.introSubtitle, (p, v) => (p.cards.intro.subtitle = v));
    text(ui.outroTitle, (p, v) => (p.cards.outro.title = v));
    text(ui.outroSubtitle, (p, v) => (p.cards.outro.subtitle = v));
    range(ui.cardsDuration, (p, v) => {
      p.cards.intro.durationMs = v * 1000;
      p.cards.outro.durationMs = v * 1000;
    });

    this.radios(ui.aspect, (value) => this.change((p) => (p.aspect = value as Aspect)));
    this.radios(ui.frame, (value) => this.change((p) => (p.frame = value as Frame)));
    this.radios(ui.keysMode, (value) => this.change((p) => (p.keys.mode = value as Project["keys"]["mode"])));
    this.radios(ui.zoomMode, (value) =>
      this.change((p) => {
        const segment = p.zoom.segments.find((candidate) => candidate.id === this.selected?.id);
        if (segment) segment.mode = value as ZoomSegment["mode"];
      }),
    );
    range(ui.noteSize, (p, v) => {
      const note = p.notes.find((candidate) => candidate.id === this.selected?.id);
      if (note) note.size = v;
    });
    this.radios(ui.noteKind, (value) => {
      if (this.selected?.track === "notes") this.setNoteKind(this.selected.id, value as NoteKind);
    });
    this.radios(ui.noteDirection, (value) => this.updateNote((note) => (note.direction = value as Note["direction"])));
    this.radios(ui.speedRate, (value) => {
      if (this.selected?.track === "speed") this.setSpeed(this.selected.id, Number(value));
    });
    this.radios(ui.webcamCorner, (value) => this.change((p) => (p.webcam.corner = value as Corner)));
    this.radios(ui.webcamShape, (value) => this.change((p) => (p.webcam.shape = value as Project["webcam"]["shape"])));
    this.radios(ui.captionsPosition, (value) => this.change((p) => (p.captions.position = value as Project["captions"]["position"])));

    ui.bgImage.addEventListener("click", () => ui.bgFile.click());
    ui.bgFile.addEventListener("change", async () => {
      const file = ui.bgFile.files?.[0];
      const scene = this.scene;
      ui.bgFile.value = "";
      if (!file || !scene) return;
      try {
        const extension = (file.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "");
        const name = await saveAsset(scene.take.dir, file, `fundo-${Date.now().toString(36)}.${extension}`);
        this.change((p) => {
          p.background.kind = "image";
          p.background.image = name;
        });
        await this.loadBackground();
      } catch (error) {
        toast(`Não foi possível usar a imagem: ${error}`);
      }
    });

    ui.musicPick.addEventListener("click", () => ui.musicFile.click());
    ui.musicFile.addEventListener("change", async () => {
      const file = ui.musicFile.files?.[0];
      const scene = this.scene;
      ui.musicFile.value = "";
      if (!file || !scene) return;
      try {
        const extension = (file.name.split(".").pop() ?? "mp3").toLowerCase().replace(/[^a-z0-9]/g, "");
        const name = await saveAsset(scene.take.dir, file, `musica-${Date.now().toString(36)}.${extension}`);
        this.change((p) => (p.audio.music = name));
        this.loadMusic();
        toast(`Música: ${file.name}`);
      } catch (error) {
        toast(`Não foi possível usar a música: ${error}`);
      }
    });
    ui.musicRemove.addEventListener("click", () => {
      this.change((p) => (p.audio.music = null));
      this.loadMusic();
    });

    ui.crop.addEventListener("click", () => this.editCrop());
    ui.blurArea.addEventListener("click", () => this.editBlurArea());
    ui.selectionDelete.addEventListener("click", () => this.deleteSelected());
    const showShortcuts = () => {
      ui.shortcutsModal.hidden = false;
      ui.shortcutsClose.focus();
    };
    ui.shortcuts.addEventListener("click", showShortcuts);
    ui.shortcutsOpen.addEventListener("click", showShortcuts);
    ui.shortcutsClose.addEventListener("click", () => (ui.shortcutsModal.hidden = true));
    ui.shortcutsModal.addEventListener("click", (event) => {
      if (event.target === ui.shortcutsModal) ui.shortcutsModal.hidden = true;
    });
    ui.shortcutsModal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") ui.shortcutsModal.hidden = true;
      event.stopPropagation();
    });
    ui.autoZoom.addEventListener("click", () => {
      const scene = this.scene;
      if (!scene) return;
      const lenses = scene.project.zoom.segments.filter((segment) => segment.mode === "lens");
      const segments = autoZooms(scene.events, scene.take.durationMs, scene.project.zoom.defaultScale);
      if (!segments.length) {
        toast("Nenhum clique encontrado nesta gravação");
        return;
      }
      this.selected = null;
      // Replaces camera zooms; lenses are kept.
      this.change((p) => (p.zoom.segments = [...segments, ...lenses].sort((a, b) => a.start - b.start)));
      this.flushSave();
      toast(`${segments.length} ${segments.length === 1 ? "zoom gerado" : "zooms gerados"} a partir dos cliques`, { label: "Desfazer", run: () => this.undo() });
    });

    ui.transcribeLanguage.replaceChildren(...LANGUAGES.map(([code, name]) => new Option(name, code)));
    ui.transcribeLanguage.value = preferredLanguage();
    ui.transcribeLanguage.addEventListener("change", () => rememberLanguage(ui.transcribeLanguage.value));
    ui.transcribe.addEventListener("click", () => void this.runTranscription());
    ui.undo.addEventListener("click", () => this.undo());
    ui.redo.addEventListener("click", () => this.redo());
    ui.reveal.addEventListener("click", () => {
      if (this.scene) void revealItemInDir(joinPath(this.scene.take.dir, this.scene.take.video));
    });
    ui.exportButton.addEventListener("click", () => this.openExport());
    ui.addCut.addEventListener("click", () => this.useTool("cuts"));
    ui.addZoom.addEventListener("click", () => this.useTool("zoom"));
    ui.addLens.addEventListener("click", () => this.useTool("lens"));
    ui.addBlur.addEventListener("click", () => this.useTool("blurs"));
    ui.addSpeed.addEventListener("click", () => this.useTool("speed"));
    ui.addNote.addEventListener("click", () => this.useTool("notes"));
    ui.noteColors.replaceChildren(
      ...NOTE_COLORS.map((color) => {
        const swatch = document.createElement("button");
        swatch.className = "swatch";
        swatch.dataset.color = color;
        swatch.style.background = color;
        swatch.setAttribute("aria-label", `Cor ${color}`);
        swatch.addEventListener("click", () => this.updateNote((note) => (note.color = color)));
        return swatch;
      }),
    );
    ui.noteText.addEventListener("input", () => this.updateNote((note) => (note.text = ui.noteText.value)));
    ui.notePlace.addEventListener("click", () => this.editNotePosition());
    ui.silenceMin.addEventListener("input", () => this.showValue(ui.silenceMin));
    ui.cutSilences.addEventListener("click", () => void this.cutSilences());
    ui.cutFillers.addEventListener("click", () => this.cutFillers());

    // Transcript: click a word to seek, shift-click to extend, Delete to cut the selection.
    ui.transcript.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(".word");
      if (!target || !this.scene) return;
      const index = Number(target.dataset.i);
      const word = this.scene.words.find((candidate) => candidate.i === index);
      if (!word) return;
      this.wordSelection = event.shiftKey && this.wordSelection ? { from: this.wordSelection.from, to: index } : { from: index, to: index };
      this.seek(word.t0);
      this.renderTranscript();
    });
    ui.transcript.addEventListener("keydown", (event) => {
      if ((event.key === "Delete" || event.key === "Backspace") && this.wordSelection) {
        event.preventDefault();
        event.stopPropagation();
        this.toggleWords();
      }
    });
  }

  /** Turns voice enhancement on (processing the microphone once) or off. */
  private async setEnhance(on: boolean) {
    const scene = this.scene;
    if (!scene?.take.mic) return;
    const ui = this.ui;
    if (on) {
      this.enhancing = true;
      ui.enhance.disabled = true;
      ui.enhanceHint.hidden = false;
      ui.enhanceHint.textContent = "Melhorando a voz…";
      try {
        await invoke("enhance_voice", { dir: scene.take.dir });
      } catch (error) {
        this.enhancing = false;
        ui.enhance.checked = false;
        ui.enhance.disabled = false;
        ui.enhanceHint.textContent = `Não foi possível melhorar a voz: ${error}`;
        return;
      }
      this.enhancing = false;
      ui.enhance.disabled = false;
    }
    this.change((p) => (p.audio.enhance = on));
    this.loadMic();
    ui.enhanceHint.hidden = false;
    ui.enhanceHint.textContent = on ? "Ruído removido e volume nivelado. Desligue para ouvir o original." : "Usando o áudio original do microfone.";
  }

  /** The microphone track for preview: the enhanced one when that option is on. */
  private loadMic() {
    const scene = this.scene;
    const mic = this.ui.mic;
    if (!scene?.take.mic) {
      mic.removeAttribute("src");
      return;
    }
    const file = scene.project.audio.enhance ? "mic.enhanced.wav" : scene.take.mic;
    const time = this.ui.video.currentTime;
    mic.src = convertFileSrc(joinPath(scene.take.dir, file));
    mic.currentTime = time;
    if (!this.ui.video.paused) void mic.play();
  }

  private toggleWords() {
    const selection = this.wordSelection;
    if (!selection || !this.scene) return;
    const [from, to] = [Math.min(selection.from, selection.to), Math.max(selection.from, selection.to)];
    const ids = this.scene.words.filter((word) => word.i >= from && word.i <= to).map((word) => word.i);
    const deleted = new Set(this.scene.project.deletedWords);
    const restore = ids.every((id) => deleted.has(id));
    this.change((p) => {
      const set = new Set(p.deletedWords);
      for (const id of ids) {
        if (restore) set.delete(id);
        else set.add(id);
      }
      p.deletedWords = [...set].sort((a, b) => a - b);
    });
    this.flushSave();
    // Clear the selection so the struck-through words read clearly.
    this.wordSelection = null;
    this.renderTranscript();
    toast(restore ? "Palavras restauradas" : `${ids.length} ${ids.length === 1 ? "palavra cortada" : "palavras cortadas"}`, { label: "Desfazer", run: () => this.undo() });
  }

  private renderTranscript() {
    const scene = this.scene;
    const ui = this.ui;
    const words = scene?.words ?? [];
    const hasWords = words.length > 0;
    ui.captionsSection.hidden = !hasWords;
    ui.transcriptSection.hidden = !hasWords;
    ui.transcribe.querySelector("use")?.setAttribute("href", "#i-wand");
    ui.transcribe.lastChild!.textContent = hasWords ? "Transcrever de novo" : "Transcrever";
    if (!scene || !hasWords) {
      ui.transcript.replaceChildren();
      const audio = scene && (scene.take.mic || scene.take.systemAudio);
      ui.transcribeStatus.textContent = audio
        ? "Transcreva a fala para gerar legendas e cortar o vídeo apagando palavras."
        : "Esta gravação não tem áudio para transcrever.";
      ui.transcribe.disabled = !audio;
      return;
    }
    ui.transcribe.disabled = false;
    ui.transcribeStatus.textContent = `${words.length} palavras reconhecidas.`;
    const deleted = new Set(scene.project.deletedWords);
    const selection = this.wordSelection;
    const [from, to] = selection ? [Math.min(selection.from, selection.to), Math.max(selection.from, selection.to)] : [-1, -1];
    ui.transcript.replaceChildren(
      ...words.flatMap((word) => {
        const span = document.createElement("span");
        span.className = "word";
        span.dataset.i = String(word.i);
        span.textContent = word.text.trim();
        span.classList.toggle("deleted", deleted.has(word.i));
        span.classList.toggle("selected", word.i >= from && word.i <= to);
        return [span, document.createTextNode(" ")];
      }),
    );
  }

  private async runTranscription() {
    const scene = this.scene;
    if (!scene) return;
    const ui = this.ui;
    const take = scene.take;
    ui.transcribe.disabled = true;
    ui.transcribeProgress.hidden = false;
    ui.transcribeProgress.classList.add("indeterminate");
    try {
      const words = await transcribe(take, (message) => (ui.transcribeStatus.textContent = message), ui.transcribeLanguage.value);
      if (this.scene?.take.id !== take.id) return;
      this.scene.words = words;
      this.change((p) => {
        p.deletedWords = [];
        p.captions.visible = words.length > 0;
      });
      this.renderTranscript();
      ui.transcribeStatus.textContent = words.length ? `${words.length} palavras reconhecidas.` : "Nenhuma fala encontrada.";
    } catch (error) {
      ui.transcribeStatus.textContent = `A transcrição falhou: ${error instanceof Error ? error.message : error}`;
    } finally {
      ui.transcribe.disabled = false;
      ui.transcribeProgress.hidden = true;
    }
  }

  private showValue(input: HTMLInputElement) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 1);
    input.style.setProperty("--fill", `${((Number(input.value) - min) / (max - min || 1)) * 100}%`);
    const output = document.querySelector<HTMLElement>(`[data-value-for="${input.id}"]`);
    if (!output) return;
    const value = Number(input.value);
    const percent = ["padding", "shadow", "cursor-smoothing", "webcam-size", "volume-system", "volume-mic", "volume-music"];
    output.textContent = percent.includes(input.id)
      ? `${Math.round(value * 100)}%`
      : input.id === "radius" || input.id === "bg-blur"
        ? `${value}px`
        : input.id === "tilt"
          ? `${value}°`
          : input.id === "silence-min" || input.id === "cards-duration"
            ? `${value.toFixed(1).replace(".", ",")} s`
            : `${value.toFixed(input.id === "captions-size" ? 2 : 1).replace(".", ",")}×`;
  }

  private syncInspector() {
    const scene = this.scene;
    if (!scene) return;
    this.version++;
    const { project, take } = scene;
    const ui = this.ui;
    const gradient = project.background.kind === "gradient";
    for (const card of ui.styles.querySelectorAll<HTMLElement>(".style-card")) {
      card.classList.toggle("selected", STYLES.find((style) => style.id === card.dataset.id)!.matches(project));
    }
    for (const swatch of ui.backgrounds.querySelectorAll<HTMLElement>(".swatch")) {
      swatch.classList.toggle("selected", gradient && swatch.dataset.id === project.background.preset);
    }
    ui.bgImage.classList.toggle("selected", !gradient);
    ui.bgBlurRow.hidden = gradient;
    ui.bgBlur.value = String(project.background.blur);
    ui.padding.value = String(project.background.padding);
    ui.radius.value = String(project.background.radius);
    ui.shadow.value = String(project.background.shadow);
    ui.tilt.value = String(project.tilt);
    this.setRadio(ui.aspect, project.aspect);
    this.setRadio(ui.frame, project.frame);
    ui.cropLabel.textContent = project.crop ? `Área recortada (${project.crop.width}×${project.crop.height})` : "Recortar área…";

    const redrawable = !take.cursorInVideo && scene.events.length > 0;
    ui.cursorNote.hidden = redrawable;
    ui.cursorNote.textContent = take.cursorInVideo
      ? "O cursor foi gravado dentro do vídeo, então mostrar, tamanho e suavização não se aplicam. Grave com “Cursor no vídeo” desligado para usá-los."
      : "Esta gravação não tem dados do mouse.";
    for (const control of [ui.cursorVisible, ui.cursorSize, ui.smoothing]) control.disabled = !redrawable;
    const hasClicks = scene.clicks.length > 0;
    for (const control of [ui.clickEffect, ui.spotlight, ui.clickSound]) {
      control.disabled = !hasClicks;
      control.closest("label")!.title = hasClicks ? "" : "Não há cliques nesta gravação";
    }
    ui.cursorVisible.checked = project.cursor.visible;
    ui.cursorSize.value = String(project.cursor.size);
    ui.smoothing.value = String(project.cursor.smoothing);
    ui.clickEffect.checked = project.cursor.clickEffect;
    ui.spotlight.checked = project.cursor.spotlight;
    ui.clickSound.checked = project.audio.clickSound;

    const hasKeys = scene.keys.length > 0;
    ui.keysNote.hidden = hasKeys;
    ui.keysNote.textContent = take.keys
      ? "Nenhuma tecla foi pressionada nesta gravação."
      : "Grave com a opção “Teclas” ligada para mostrar atalhos no vídeo.";
    for (const control of [ui.keysVisible, ...ui.keysMode.querySelectorAll("input"), ui.keySound]) (control as HTMLInputElement).disabled = !hasKeys;
    ui.keysVisible.checked = project.keys.visible;
    this.setRadio(ui.keysMode, project.keys.mode);
    ui.keySound.checked = project.audio.keySound;

    ui.zoomDefault.value = String(project.zoom.defaultScale);
    const leftClicks = scene.clicks.some((click) => click.b === "l");
    ui.autoZoom.disabled = !leftClicks;
    ui.autoZoomHint.hidden = leftClicks;
    ui.autoZoomHint.textContent = "Não há cliques nesta gravação para gerar zooms.";

    // One panel for whatever is selected on the timeline.
    const selected = this.selectedItem<Range>();
    ui.selection.hidden = !selected;
    if (selected) {
      const kind = this.selectedKind(this.selected);
      const titles = { cut: "Corte selecionado", speed: "Trecho acelerado", zoom: "Zoom selecionado", lens: "Lente selecionada", blur: "Desfoque selecionado", text: "Texto selecionado", arrow: "Seta selecionada", box: "Destaque selecionado" };
      const removes = { cut: "Remover corte", speed: "Voltar à velocidade normal", zoom: "Remover zoom", lens: "Remover lente", blur: "Remover desfoque", text: "Remover texto", arrow: "Remover seta", box: "Remover destaque" };
      ui.selectionTitle.textContent = titles[kind];
      ui.selectionDeleteLabel.textContent = removes[kind];
      const seconds = (selected.end - selected.start) / 1000;
      ui.selectionTime.textContent = `${formatTime(selected.start)} – ${formatTime(selected.end)} · ${seconds.toFixed(1).replace(".", ",")} s`;
      ui.selectionZoom.hidden = kind !== "zoom" && kind !== "lens";
      ui.blurArea.hidden = kind !== "blur";
      ui.selectionSpeed.hidden = kind !== "speed";
      ui.selectionNote.hidden = this.selected?.track !== "notes";
      if (this.selected?.track === "notes") {
        const note = selected as Note;
        this.setRadio(ui.noteKind, note.kind);
        ui.noteTextField.hidden = note.kind !== "text";
        // Never rewrite the box while the user types in it; the caret would jump.
        if (document.activeElement !== ui.noteText) ui.noteText.value = note.text;
        ui.noteSize.value = String(note.size);
        ui.noteDirection.hidden = note.kind !== "arrow";
        this.setRadio(ui.noteDirection, note.direction);
        for (const swatch of ui.noteColors.querySelectorAll<HTMLElement>(".swatch")) swatch.classList.toggle("selected", swatch.dataset.color === note.color);
      }
      if (kind === "speed") {
        const rate = (selected as SpeedRange).rate;
        this.setRadio(ui.speedRate, String(rate));
        ui.selectionTime.textContent += ` → ${(seconds / rate).toFixed(1).replace(".", ",")} s no vídeo`;
      }
      if (kind === "zoom" || kind === "lens") {
        const zoom = selected as ZoomSegment;
        ui.zoomScale.value = String(zoom.scale);
        this.setRadio(ui.zoomMode, zoom.mode);
      }
    }

    const hasWebcam = Boolean(take.webcam);
    ui.webcamNote.hidden = hasWebcam;
    for (const control of [ui.webcamVisible, ui.webcamSize, ...ui.webcamCorner.querySelectorAll("input"), ...ui.webcamShape.querySelectorAll("input")]) {
      (control as HTMLInputElement).disabled = !hasWebcam;
    }
    ui.webcamVisible.checked = project.webcam.visible;
    ui.webcamSize.value = String(project.webcam.size);
    this.setRadio(ui.webcamCorner, project.webcam.corner);
    this.setRadio(ui.webcamShape, project.webcam.shape);

    ui.volumeSystem.value = String(project.audio.system);
    ui.volumeSystem.disabled = !take.systemAudio;
    ui.volumeMic.value = String(project.audio.mic);
    ui.volumeMic.disabled = !take.mic;
    const missing = [!take.systemAudio && "som do sistema", !take.mic && "microfone"].filter(Boolean);
    ui.volumeHint.hidden = !missing.length;
    ui.volumeHint.textContent = `Gravado sem ${missing.join(" e sem ")}.`;
    if (!this.enhancing) {
      ui.enhance.checked = project.audio.enhance;
      ui.enhance.disabled = !take.mic;
      ui.enhanceHint.hidden = Boolean(take.mic) && !project.audio.enhance;
      ui.enhanceHint.textContent = !take.mic
        ? "Disponível quando a gravação tem microfone."
        : "Ruído removido e volume nivelado. Desligue para ouvir o original.";
    }
    ui.volumeMusic.value = String(project.audio.musicVolume);
    ui.volumeMusic.disabled = !project.audio.music;
    ui.musicLabel.textContent = project.audio.music ? "Trocar música…" : "Escolher música…";
    ui.musicRemove.hidden = !project.audio.music;

    ui.captionsVisible.checked = project.captions.visible;
    ui.captionsSize.value = String(project.captions.size);
    this.setRadio(ui.captionsPosition, project.captions.position);

    const hasAudio = Boolean(take.mic) || take.systemAudio;
    ui.cutSilences.disabled = !hasAudio;
    ui.cutFillers.disabled = !scene.words.length;
    ui.cutFillers.title = scene.words.length ? "" : "Transcreva a fala primeiro, na aba Legendas";
    const { intro, outro } = project.cards;
    ui.introEnabled.checked = intro.enabled;
    ui.outroEnabled.checked = outro.enabled;
    ui.introFields.hidden = !intro.enabled;
    ui.outroFields.hidden = !outro.enabled;
    // Never rewrite a field while the user types in it; the caret would jump.
    for (const [input, value] of [[ui.introTitle, intro.title], [ui.introSubtitle, intro.subtitle], [ui.outroTitle, outro.title], [ui.outroSubtitle, outro.subtitle]] as const) {
      if (document.activeElement !== input) input.value = value;
    }
    ui.cardsDuration.value = String(intro.durationMs / 1000);
    for (const input of [ui.cardsDuration, ui.noteSize, ui.silenceMin, ui.padding, ui.radius, ui.shadow, ui.tilt, ui.bgBlur, ui.cursorSize, ui.smoothing, ui.zoomDefault, ui.zoomScale, ui.webcamSize, ui.volumeSystem, ui.volumeMic, ui.volumeMusic, ui.captionsSize]) {
      this.showValue(input);
    }
    this.video.volume = Math.min(1, project.audio.system);
    this.ui.mic.volume = Math.min(1, project.audio.mic);
    this.lastTimelineKey = "";
  }

  private get video() {
    return this.ui.video;
  }

  // ---------- playback ----------

  private bindPlayback() {
    const { video, mic, webcam, play } = this.ui;
    play.addEventListener("click", () => this.togglePlay());
    this.playIcons = { play: play.querySelector(".icon-play")!, pause: play.querySelector(".icon-pause")! };
    const showPlaying = (playing: boolean) => this.showPlaying(playing);
    video.addEventListener("loadeddata", () => (this.ui.status.hidden = true));
    video.addEventListener("error", () => {
      this.ui.status.hidden = true;
      this.ui.error.hidden = false;
      this.ui.error.textContent = "Não foi possível abrir o vídeo desta gravação. O arquivo pode ter sido movido ou estar incompleto.";
    });
    video.addEventListener("play", () => {
      this.card = null;
      showPlaying(true);
      this.sounds.reset();
      this.syncCompanions(true);
    });
    video.addEventListener("pause", () => {
      showPlaying(false);
      mic.pause();
      webcam.pause();
      this.music.pause();
    });
    video.addEventListener("seeked", () => this.syncCompanions(false));
  }

  /** Keeps microphone, webcam and music in step with the main video. */
  private syncCompanions(start: boolean) {
    const scene = this.scene;
    if (!scene) return;
    const { video, mic, webcam } = this.ui;
    const t = video.currentTime;
    if (scene.take.mic && (start || Math.abs(mic.currentTime - t) > 0.08)) mic.currentTime = t;
    const webcamTime = t - (scene.take.webcamOffsetMs ?? 0) / 1000;
    if (scene.take.webcam && webcamTime >= 0 && (start || Math.abs(webcam.currentTime - webcamTime) > 0.1)) webcam.currentTime = webcamTime;
    if (scene.project.audio.music && this.music.duration) {
      const musicTime = (scene.time.toOutput(t * 1000) / 1000) % this.music.duration;
      if (start || Math.abs(this.music.currentTime - musicTime) > 0.25) this.music.currentTime = musicTime;
    }
    if (start && !video.paused) {
      if (scene.take.mic) void mic.play();
      if (scene.take.webcam) void webcam.play();
      if (scene.project.audio.music) void this.music.play();
    }
  }

  private bindShortcuts() {
    window.addEventListener("keydown", (event) => {
      if (this.ui.root.hidden || this.exportDialog.isOpen || this.rectEditor.isOpen) return;
      if (!this.ui.shortcutsModal.hidden) return;
      const ctrl = event.ctrlKey || event.metaKey;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.matches("input[type=text], textarea, .rename, .transcript") && !ctrl) return;
      // Space and arrows already mean something on buttons, switches and sliders.
      if (!ctrl && target?.matches("button, input, select") && (event.code === "Space" || event.key.startsWith("Arrow"))) return;
      const t = this.ui.video.currentTime * 1000;
      const key = event.code;
      if (ctrl && key === "KeyE") this.openExport();
      else if (ctrl && (key === "KeyY" || (key === "KeyZ" && event.shiftKey))) this.redo();
      else if (ctrl && key === "KeyZ") this.undo();
      else if (ctrl) return;
      else if (key === "Space") this.togglePlay();
      else if ((event.key === "Delete" || event.key === "Backspace") && this.range) this.useTool("cuts");
      else if ((event.key === "Delete" || event.key === "Backspace") && this.selected) this.deleteSelected();
      else if (key === "KeyX") this.useTool("cuts");
      else if (key === "KeyZ") this.useTool("zoom");
      else if (key === "KeyL") this.useTool("lens");
      else if (key === "KeyB") this.useTool("blurs");
      else if (key === "KeyS") this.useTool("speed");
      else if (key === "KeyT") this.useTool("notes");
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const trim = this.scene?.project.trim;
        if (!trim) return;
        const step = (event.shiftKey ? 5000 : 1000) * (event.key === "ArrowLeft" ? -1 : 1);
        this.seek(Math.min(trim.end, Math.max(trim.start, t + step)));
      } else if (event.key === "Escape" && this.range) this.setRange(null);
      else if (event.key === "Escape" && this.selected) this.select(null);
      else if (event.key === "?") {
        this.ui.shortcutsModal.hidden = false;
        this.ui.shortcutsClose.focus();
      } else return;
      event.preventDefault();
    });
  }

  private showPlaying(playing: boolean) {
    const { play } = this.ui;
    this.playIcons?.play.toggleAttribute("hidden", playing);
    this.playIcons?.pause.toggleAttribute("hidden", !playing);
    play.setAttribute("aria-label", playing ? "Pausar" : "Reproduzir");
    play.title = playing ? "Pausar (Espaço)" : "Reproduzir (Espaço)";
  }

  private togglePlay() {
    const scene = this.scene;
    if (!scene) return;
    const video = this.ui.video;
    if (this.card) {
      this.stopCard();
      return;
    }
    if (!video.paused) {
      video.pause();
      return;
    }
    const first = scene.time.spans[0]?.start ?? 0;
    const t = video.currentTime * 1000;
    const next = scene.time.playable(t);
    const restart = next === null || t >= scene.project.trim.end - 50;
    if (restart) video.currentTime = first / 1000;
    else if (next !== t) video.currentTime = next / 1000;
    // From the beginning, the opening card plays first.
    if ((restart || t <= first + 50) && cardLength(scene.project.cards.intro)) {
      this.startCard("intro");
      return;
    }
    void video.play();
  }

  private startCard(kind: "intro" | "outro") {
    this.card = { kind, started: performance.now() };
    this.showPlaying(true);
    this.version++;
  }

  private stopCard() {
    this.card = null;
    this.showPlaying(false);
    this.version++;
  }

  /** The title card in the preview right now, with its fade. */
  private cardView(): CardView | null {
    const scene = this.scene;
    if (!scene || !this.card) return null;
    const card = scene.project.cards[this.card.kind];
    const elapsed = performance.now() - this.card.started;
    const length = cardLength(card);
    const opacity = this.card.kind === "intro" ? Math.min(1, (length - elapsed) / CARD_FADE) : Math.min(1, elapsed / CARD_FADE);
    return { card, opacity: Math.max(0, opacity) };
  }

  private seek(time: number) {
    if (this.card) this.stopCard();
    this.ui.video.currentTime = time / 1000;
  }

  /** Closes the open take (e.g. after it was moved to the Recycle Bin). */
  close() {
    this.flushSave();
    this.ui.video.pause();
    this.rectEditor.close();
    this.scene = null;
    this.selected = null;
    this.ui.root.hidden = true;
    for (const media of [this.ui.video, this.ui.webcam, this.ui.mic]) media.removeAttribute("src");
    this.music.removeAttribute("src");
  }

  /** Adds cuts, merging them with cuts they touch. */
  private addCuts(ranges: Span[]) {
    this.change((p) => {
      let cuts = [...p.cuts];
      for (const range of ranges) {
        const touching = cuts.filter((cut) => cut.start <= range.end && cut.end >= range.start);
        const start = Math.min(range.start, ...touching.map((cut) => cut.start));
        const end = Math.max(range.end, ...touching.map((cut) => cut.end));
        cuts = [...cuts.filter((cut) => !touching.includes(cut)), { id: touching[0]?.id ?? newId(), start, end }];
      }
      p.cuts = cuts.sort((a, b) => a.start - b.start);
    });
    this.flushSave();
  }

  /** Cuts the quiet stretches, found in the microphone (or the recording's own sound). */
  private async cutSilences() {
    const scene = this.scene;
    if (!scene) return;
    const ui = this.ui;
    ui.cutSilences.disabled = true;
    ui.cleanupHint.textContent = "Procurando silêncios…";
    try {
      const samples = await speech(scene.take);
      if (this.scene !== scene) return;
      const spans = scene.time.spans.map(({ start, end }) => ({ start, end }));
      const silences = findSilences(samples, SAMPLE_RATE, spans, Number(ui.silenceMin.value) * 1000, 150);
      if (!silences.length) {
        ui.cleanupHint.textContent = "Nenhum silêncio desse tamanho encontrado.";
        return;
      }
      const total = silences.reduce((sum, range) => sum + range.end - range.start, 0);
      this.addCuts(silences);
      ui.cleanupHint.textContent = "Os cortes aparecem na timeline e podem ser desfeitos.";
      toast(`${silences.length} ${silences.length === 1 ? "silêncio cortado" : "silêncios cortados"} (${(total / 1000).toFixed(1).replace(".", ",")} s)`, { label: "Desfazer", run: () => this.undo() });
    } catch (error) {
      ui.cleanupHint.textContent = `Não foi possível analisar o áudio: ${error instanceof Error ? error.message : error}`;
    } finally {
      ui.cutSilences.disabled = false;
    }
  }

  /** Cuts hesitations found in the transcript. */
  private cutFillers() {
    const scene = this.scene;
    if (!scene) return;
    const found = fillerWords(scene.words, scene.project.deletedWords);
    if (!found.length) {
      toast("Nenhum “hã”, “hum” ou “é” longo na transcrição. O Whisper às vezes omite essas palavras.");
      return;
    }
    this.change((p) => (p.deletedWords = [...new Set([...p.deletedWords, ...found])].sort((a, b) => a - b)));
    this.flushSave();
    this.renderTranscript();
    toast(`${found.length} ${found.length === 1 ? "palavra de preenchimento cortada" : "palavras de preenchimento cortadas"}`, { label: "Desfazer", run: () => this.undo() });
  }

  /** Changes the selected note; typing and dragging are saved together a moment later. */
  private updateNote(apply: (note: Note) => void) {
    const id = this.selected?.track === "notes" ? this.selected.id : null;
    if (!id) return;
    this.change((p) => {
      const note = p.notes.find((candidate) => candidate.id === id);
      if (note) apply(note);
    });
  }

  private setNoteKind(id: string, kind: NoteKind) {
    this.change((p) => {
      const note = p.notes.find((candidate) => candidate.id === id);
      if (!note || note.kind === kind) return;
      // Each kind starts from its own sensible box, color and text.
      const fresh = newNote(note, kind);
      Object.assign(note, { kind, x: fresh.x, y: fresh.y, width: fresh.width, height: fresh.height, color: fresh.color, text: note.text || fresh.text });
    });
    this.flushSave();
  }

  /** Puts the caret in the new text, with the placeholder selected, so typing replaces it. */
  private focusNoteText() {
    window.setTimeout(() => {
      if (this.selected?.track !== "notes" || this.ui.noteTextField.hidden) return;
      this.ui.noteText.focus();
      this.ui.noteText.select();
    }, 50);
  }

  /** Drag the note's box over the preview, in the finished frame's coordinates. */
  private editNotePosition() {
    const scene = this.scene;
    const note = this.selectedItem<Note>();
    if (!scene || !note || this.selected?.track !== "notes") return;
    const output = outputSize(scene.project.aspect, sceneSource(scene));
    const id = note.id;
    this.ui.video.pause();
    const t = this.ui.video.currentTime * 1000;
    if (t < note.start || t > note.end) this.seek(note.start + Math.min(300, (note.end - note.start) / 2));
    this.rectEditor.open({
      title: note.kind === "arrow" ? "Caixa da seta: ela cruza de um canto ao outro" : `Posição do ${NOTE_NAMES[note.kind].toLowerCase()}`,
      video: output,
      rect: { x: note.x * output.width, y: note.y * output.height, width: note.width * output.width, height: note.height * output.height },
      allowReset: false,
      onApply: (rect) => {
        if (!rect) return;
        this.change((p) => {
          const target = p.notes.find((candidate) => candidate.id === id);
          if (target) Object.assign(target, { x: rect.x / output.width, y: rect.y / output.height, width: rect.width / output.width, height: rect.height / output.height });
        });
        this.flushSave();
      },
      onClose: () => this.version++,
    });
  }

  /** Plays sped-up stretches faster and silent, with the camera and microphone in step. */
  private setRate(rate: number) {
    const { video, mic, webcam } = this.ui;
    if (video.playbackRate === rate) return;
    for (const media of [video, mic, webcam]) media.playbackRate = rate;
    video.muted = rate !== 1;
    mic.muted = rate !== 1;
  }

  private setSpeed(id: string, rate: number) {
    this.change((p) => {
      const target = p.speed.find((candidate) => candidate.id === id);
      if (target) target.rate = rate;
    });
  }

  /** Saves pending edits now, so another program reads the latest project. */
  flush() {
    this.flushSave();
  }

  /**
   * Loads `project.json` again after another program (the MCP server) changed it. The previous
   * state goes on the undo stack. Returns false when nothing changed.
   */
  async reloadProject(): Promise<boolean> {
    const scene = this.scene;
    if (!scene) return false;
    this.flushSave();
    const saved = await invoke<string | null>("load_project", { dir: scene.take.dir });
    if (!saved || this.scene !== scene) return false;
    const current = JSON.stringify(scene.project);
    const next = JSON.stringify(normalizeProject(JSON.parse(saved), defaultProject(scene.take, scene.events)));
    if (next === current) return false;
    this.undoStack.push(current);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.range = null;
    this.restore(next, false);
    return true;
  }

  /** New transcript from a transcription started elsewhere; word cuts refer to the old one. */
  setWords(takeId: string, words: Word[]) {
    if (this.scene?.take.id !== takeId) return;
    this.scene.words = words;
    this.wordSelection = null;
    refreshTime(this.scene);
    this.renderTranscript();
    this.syncInspector();
  }

  setTitle(title: string) {
    this.ui.title.textContent = title;
  }

  openExport() {
    if (!this.scene) return;
    this.ui.video.pause();
    this.flushSave();
    this.exportDialog.open(this.scene);
  }

  // ---------- rendering ----------

  /** Sizes the canvas to fit the preview area at the output's aspect ratio. */
  private layoutCanvas(output: { width: number; height: number }) {
    const box = this.ui.preview.getBoundingClientRect();
    const scale = Math.min(box.width / output.width, (box.height - (this.rectEditor.isOpen ? 48 : 0)) / output.height);
    const cssWidth = Math.max(1, Math.floor(output.width * scale));
    const cssHeight = Math.max(1, Math.floor(output.height * scale));
    const canvas = this.ui.canvas;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.min(output.width, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round((width * output.height) / output.width));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    return true;
  }

  private outputFor(scene: Scene) {
    return this.rawView ? outputSize("auto", { width: scene.take.width, height: scene.take.height }) : outputSize(scene.project.aspect, sceneSource(scene));
  }

  private renderFrame(t: number, key: string) {
    const scene = this.scene!;
    const renderer = this.renderer;
    if (!renderer) return;
    try {
      const output = this.outputFor(scene);
      this.overlay.resize(output.width, output.height);
      let state;
      if (this.rawView) {
        // The area editor works on the whole recording, without framing or effects.
        state = frameState(scene, t, output);
        Object.assign(state, {
          crop: null,
          frame: "none",
          tilt: 0,
          zoom: 1,
          lens: null,
          spotlight: 0,
          webcam: null,
          overlay: false,
          cursor: null,
          clicks: [],
          blurs: this.selected?.track === "blurs" ? [] : state.blurs,
          background: { ...state.background, padding: 0, radius: 0, shadow: 0 },
        });
      } else {
        if (this.overlay.paint(overlayText(scene, t), scene.project, this.cardView())) renderer.setOverlay(this.overlay.canvas);
        state = frameState(scene, t, output, this.overlay.visible);
      }
      if (renderer.render(this.ui.video, state, scene.take.webcam ? this.ui.webcam : null)) this.lastRenderKey = key;
    } catch (error) {
      // Show the failure once instead of throwing on every frame.
      this.renderer = null;
      this.ui.error.hidden = false;
      this.ui.error.textContent = `A renderização falhou: ${error}`;
    }
  }

  private frame() {
    requestAnimationFrame(() => this.frame());
    const scene = this.scene;
    if (!scene || this.ui.root.hidden) return;
    const { video } = this.ui;
    const { project, take, time } = scene;
    let t = video.currentTime * 1000;

    if (this.card) {
      // A title card plays on its own clock; the video waits under it.
      const length = cardLength(project.cards[this.card.kind]);
      if (performance.now() - this.card.started >= length) {
        const kind = this.card.kind;
        this.stopCard();
        if (kind === "intro") void video.play();
      }
    } else if (!video.paused) {
      // Skip cuts during playback, and stop at the end of the edit.
      const next = time.playable(t);
      if (next === null) {
        video.pause();
        const end = time.spans[time.spans.length - 1]?.end ?? project.trim.end;
        video.currentTime = end / 1000;
        t = end;
        if (cardLength(project.cards.outro)) this.startCard("outro");
      } else if (next - t > 1) {
        video.currentTime = next / 1000;
        t = next;
      } else {
        this.setRate(time.rateAt(t));
        this.syncCompanions(false);
        this.sounds.update(
          t,
          scene.clicks.filter((click) => click.b === "l").map((click) => click.t),
          scene.keys.map((key) => key.t),
          { click: project.audio.clickSound, key: project.audio.keySound },
        );
      }
    }

    const output = this.outputFor(scene);
    const resized = this.layoutCanvas(output);
    const renderKey = `${t}|${this.version}|${video.readyState}|${this.ui.webcam.readyState}`;
    if (!video.paused || this.card || resized || renderKey !== this.lastRenderKey) this.renderFrame(t, renderKey);

    const current = `${formatTime(time.toOutput(t))} `;
    const total = `/ ${formatTime(time.duration)}`;
    const currentNode = this.ui.time.firstChild;
    const totalNode = this.ui.time.lastChild;
    if (currentNode && currentNode.textContent !== current) currentNode.textContent = current;
    if (totalNode && totalNode.textContent !== total) totalNode.textContent = total;

    const key = `${t.toFixed(0)}|${this.version}|${this.thumbs.length}|${this.wave ? 1 : 0}|${this.range?.start}|${this.range?.end}`;
    if (key !== this.lastTimelineKey) {
      this.lastTimelineKey = key;
      const zoomColor = "#ff9f0a";
      const tracks: Track[] = [
        { key: "cuts", label: "Cortes", color: "#ff453a", items: project.cuts, text: () => "Cortado" },
        { key: "speed", label: "Velocidade", color: "#30d158", items: project.speed, text: (item) => speedLabel((item as SpeedRange).rate) },
        {
          key: "zoom",
          label: "Zoom",
          color: zoomColor,
          items: project.zoom.segments,
          text: (item) => `${(item as ZoomSegment).mode === "lens" ? "Lente " : ""}${scaleLabel((item as ZoomSegment).scale)}`,
          tint: (item) => ((item as ZoomSegment).mode === "lens" ? "#64d2ff" : zoomColor),
        },
        {
          key: "notes",
          label: "Textos",
          color: "#ffd60a",
          items: project.notes,
          text: (item) => {
            const note = item as Note;
            return note.kind === "text" ? note.text.split("\n")[0] || "Texto" : NOTE_NAMES[note.kind];
          },
        },
        { key: "blurs", label: "Desfoque", color: "#bf5af2", items: project.blurs, text: () => "Desfocado" },
      ];
      this.timeline.set({
        duration: take.durationMs,
        time: t,
        trim: project.trim,
        tracks,
        wordCuts: wordCuts(scene),
        clicks: scene.clicks.filter((click) => click.b === "l").map((click) => click.t),
        markers: take.markers ?? [],
        selected: this.selected,
        thumbnails: this.thumbs,
        waveform: this.wave,
        range: this.range,
      });
      this.highlightWord(t);
    }
  }

  private highlightWord(t: number) {
    const scene = this.scene;
    if (!scene?.words.length) return;
    const word = scene.words.find((candidate) => t >= candidate.t0 && t <= candidate.t1);
    for (const element of this.ui.transcript.querySelectorAll(".word.current")) element.classList.remove("current");
    if (word) this.ui.transcript.querySelector(`[data-i="${word.i}"]`)?.classList.add("current");
  }
}

/** The background image, blurred and scaled down to at most 1920 px wide. */
async function blurredImage(path: string, blur: number): Promise<OffscreenCanvas> {
  const response = await fetch(convertFileSrc(path));
  const bitmap = await createImageBitmap(await response.blob());
  const scale = Math.min(1, 1920 / bitmap.width);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d")!;
  if (blur > 0) {
    context.filter = `blur(${blur}px)`;
    // Draw slightly larger so the blur doesn't fade the edges.
    const margin = blur * 2;
    context.drawImage(bitmap, -margin, -margin, canvas.width + margin * 2, canvas.height + margin * 2);
  } else {
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
  bitmap.close();
  return canvas;
}
