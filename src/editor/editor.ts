import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { tuckHints, trackKeyboard } from "../hints";
import { showTour } from "../tips";
import { toast } from "../toast";
import { joinPath, takeName, type CursorEvent, type KeyEvent, type Take, type Word } from "../types";
import { CARD_FADE, cardLength, createScene, frameState, leftClicks, overlayText, refreshTime, sceneSource, webcamBubble, wordCuts, type CardView, type Scene } from "./composition";
import { confirmDialog, onContextMenu, type MenuItem } from "../menu";
import { openAudio, type AudioSource } from "./audio-source";
import { ExportDialog } from "./export-dialog";
import { openVideo } from "./exporter";
import { thumbnails, trackSpan, waveform } from "./media";
import { duckAt, duckGains, voiceActivity, voiceLevels } from "./duck";
import { cursorPath } from "./motion";
import { OverlayPainter } from "./overlay";
import {
  absorbSplits,
  ASPECTS,
  autoZooms,
  ANIMATED_BACKGROUNDS,
  BACKGROUNDS,
  CAMERA_LAYOUTS,
  CURSOR_MOVEMENTS,
  CURSOR_STYLES,
  DEFAULT_TRANSITION,
  defaultProject,
  enhancedFile,
  insertRange,
  newTiltAngle,
  isSplit,
  LENS_SHAPES,
  mergeCuts,
  mergeRange,
  newId,
  newNote,
  NOTE_COLORS,
  SPEEDS,
  STYLES,
  TRANSITIONS,
  normalizeProject,
  outputSize,
  lookText,
  loadSoundLook,
  withSavedLook,
  type Aspect,
  type BlurRegion,
  type CameraLayout,
  type CameraRange,
  type EnhanceLevel,
  type ClickStyle,
  type ClickTone,
  type Corner,
  type Cut,
  type Frame,
  type LensShape,
  type MediaKey,
  type TransitionKind,
  type Note,
  type NoteKind,
  type Project,
  type Range,
  type Rect,
  type SpeedRange,
  type TiltRange,
  type ZoomSegment,
} from "./project";
import { DirectEdit, type DirectTarget } from "./direct-edit";
import { RectEditor } from "./rect-editor";
import { WebcamMatte, type Matte } from "./matte";
import { cursorPreview, Renderer } from "./renderer";
import { SoundPreview } from "./sounds";
import { laneCutKey, laneOfCut, shiftLabel, Timeline, type ItemKey, type MediaLane, type Selection, type Track, type TrackKey } from "./timeline";
import type { Span, TimeMap } from "./timemap";
import { LANGUAGES, preferredLanguage, rememberLanguage, SAMPLE_RATE, speech, transcribe } from "./transcribe";
import { fillerWords, findSilences, pausePad, pauseSpeeds, type PauseMode } from "./cleanup";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const UNDO_LIMIT = 100;
/** Default lengths of items added at the playhead, in ms. */
const LENGTHS: Record<TrackKey, number> = { cuts: 1000, speed: 3000, zoom: 2000, notes: 3000, blurs: 3000, camera: 4000, tilts: 4000 };
/** How a tilt reads on the timeline and in the panel. */
const tiltLabel = (angle: number) => (angle ? `3D ${angle}°` : "Plana");
const NOTE_NAMES: Record<NoteKind, string> = { text: "Texto", arrow: "Seta", box: "Destaque" };
/** Words for cutting a media lane on its own: the webcam hides, a sound goes silent. */
const LANE_WORDS: Record<MediaKey, { here: string; range: string; done: string; title: string; restored: string; icon: string }> = {
  webcam: {
    here: "Cortar a webcam aqui",
    range: "Cortar só a webcam neste trecho",
    done: "Webcam cortada neste trecho",
    title: "Webcam cortada",
    restored: "Webcam restaurada neste trecho",
    icon: "camera",
  },
  system: {
    here: "Silenciar o som do sistema aqui",
    range: "Silenciar só o som do sistema neste trecho",
    done: "Som do sistema silenciado neste trecho",
    title: "Som do sistema silenciado",
    restored: "Som do sistema restaurado neste trecho",
    icon: "audio",
  },
  mic: {
    here: "Silenciar o microfone aqui",
    range: "Silenciar só o microfone neste trecho",
    done: "Microfone silenciado neste trecho",
    title: "Microfone silenciado",
    restored: "Microfone restaurado neste trecho",
    icon: "mic",
  },
};
/** Length of a lane cut added at a point, in ms. */
const LANE_CUT = 1000;
/** Rate of a new sped-up stretch. */
const DEFAULT_SPEED = 2;
/** Where the pause settings ("Encurtar"/"Cortar", lengths) are remembered. */
const PAUSES_KEY = "recorte.pauses";
const speedLabel = (rate: number) => `${String(rate).replace(".", ",")}×`;

/** Preview playback speeds the transport button cycles through; export always plays at 1×. */
const PREVIEW_SPEEDS = [1, 1.5, 2];
const PREVIEW_SPEED_KEY = "recorte.previewSpeed";

function loadPreviewSpeed() {
  try {
    const saved = Number(localStorage.getItem(PREVIEW_SPEED_KEY));
    return PREVIEW_SPEEDS.includes(saved) ? saved : 1;
  } catch {
    return 1;
  }
}

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

/** Uploads a file the user picked into the take folder; returns its name there. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "weba"];
/** Videos are imported as new takes; the formats it can't read are refused there, with the reason. */
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "webm", "avi"];

/** A file's extension, lowercase and safe for a file name. */
const fileExtension = (file: File, fallback: string) => (file.name.includes(".") ? file.name.split(".").pop()! : fallback).toLowerCase().replace(/[^a-z0-9]/g, "") || fallback;

/** What a dropped file can be used for, by its type or, when that is empty, its name. */
function dropKind(type: string, name: string): "image" | "audio" | "video" | "other" {
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if ((type.startsWith("image/") && type !== "image/svg+xml") || IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (type.startsWith("audio/") || AUDIO_EXTENSIONS.includes(extension)) return "audio";
  if (type.startsWith("video/") || VIDEO_EXTENSIONS.includes(extension)) return "video";
  return "other";
}

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
    /** System sound of newer takes, which keep it in its own WAV. */
    system: $<HTMLAudioElement>("system-sound"),
    play: $<HTMLButtonElement>("play"),
    time: $("time"),
    previewSpeed: $<HTMLButtonElement>("preview-speed"),
    title: $("take-title"),
    undo: $<HTMLButtonElement>("undo"),
    redo: $<HTMLButtonElement>("redo"),
    reveal: $<HTMLButtonElement>("reveal"),
    exportButton: $<HTMLButtonElement>("export"),
    addCut: $<HTMLButtonElement>("add-cut"),
    addSplit: $<HTMLButtonElement>("add-split"),
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
    animatedBackgrounds: $("bg-animated"),
    bgSpeedRow: $("bg-speed-row"),
    bgSpeed: $<HTMLInputElement>("bg-speed"),
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
    cursorMovement: $("cursor-movement"),
    cursorBounce: $<HTMLInputElement>("cursor-bounce"),
    cursorTilt: $<HTMLInputElement>("cursor-tilt"),
    cursorFocus: $<HTMLInputElement>("cursor-focus"),
    cursorStyles: $("cursor-styles"),
    cursorIdle: $("cursor-idle"),
    cursorReturn: $<HTMLInputElement>("cursor-return"),
    cursorShapeDelay: $<HTMLInputElement>("cursor-shape-delay"),
    clickStyle: $("click-style"),
    clickSize: $<HTMLInputElement>("click-size"),
    clickSizeField: $("click-size-field"),
    spotlight: $<HTMLInputElement>("spotlight"),
    clickTone: $("click-tone"),
    keysNote: $("keys-note"),
    keysVisible: $<HTMLInputElement>("keys-visible"),
    keysMode: $("keys-mode"),
    keySound: $<HTMLInputElement>("key-sound"),
    autoZoom: $<HTMLButtonElement>("auto-zoom"),
    cutSilences: $<HTMLButtonElement>("cut-silences"),
    silenceMin: $<HTMLInputElement>("silence-min"),
    pauseMode: $("pause-mode"),
    pauseKeep: $<HTMLInputElement>("pause-keep"),
    cutSilencesLabel: $("cut-silences-label"),
    cutFillers: $<HTMLButtonElement>("cut-fillers"),
    cleanupHint: $("cleanup-hint"),
    zoomDefault: $<HTMLInputElement>("zoom-default"),
    selection: $("selection"),
    selectionTitle: $("selection-title"),
    selectionTime: $("selection-time"),
    selectionZoom: $("selection-zoom"),
    selectionTransition: $("selection-transition"),
    transitionKind: $("transition-kind"),
    transitionDuration: $<HTMLInputElement>("transition-duration"),
    transitionDurationField: $("transition-duration-field"),
    selectionDelete: $<HTMLButtonElement>("selection-delete"),
    selectionDeleteLabel: $("selection-delete-label"),
    autoZoomHint: $("auto-zoom-hint"),
    zoomMode: $("zoom-mode"),
    zoomScale: $<HTMLInputElement>("zoom-scale"),
    zoomFocusField: $("zoom-focus-field"),
    zoomFocus: $("zoom-focus"),
    zoomArea: $<HTMLButtonElement>("zoom-area"),
    zoomGlide: $<HTMLButtonElement>("zoom-glide"),
    zoomGlideLabel: $("zoom-glide-label"),
    lensShapeField: $("lens-shape-field"),
    lensShape: $("lens-shape"),
    cursorMotion: $<HTMLInputElement>("cursor-motion"),
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
    webcamMirror: $<HTMLInputElement>("webcam-mirror"),
    webcamBackground: $("webcam-background"),
    webcamZoom: $<HTMLInputElement>("webcam-zoom"),
    webcamLight: $<HTMLInputElement>("webcam-light"),
    webcamWarmth: $<HTMLInputElement>("webcam-warmth"),
    webcamBorder: $<HTMLInputElement>("webcam-border"),
    webcamBorderColors: $("webcam-border-colors"),
    webcamShadow: $<HTMLInputElement>("webcam-shadow"),
    cameraAdd: $("camera-add"),
    tiltAdd: $<HTMLButtonElement>("tilt-add"),
    selectionTilt: $("selection-tilt"),
    tiltAngle: $<HTMLInputElement>("tilt-angle"),
    selectionCamera: $("selection-camera"),
    cameraLayout: $("camera-layout"),
    volumeSystem: $<HTMLInputElement>("volume-system"),
    volumeMic: $<HTMLInputElement>("volume-mic"),
    enhance: $<HTMLInputElement>("enhance"),
    enhanceOptions: $("enhance-options"),
    enhanceLevel: $("enhance-level"),
    enhanceCompare: $("enhance-compare"),
    loudness: $<HTMLInputElement>("loudness"),
    enhanceHint: $("enhance-hint"),
    musicPick: $<HTMLButtonElement>("music-pick"),
    musicLabel: $("music-label"),
    musicRemove: $<HTMLButtonElement>("music-remove"),
    musicFile: $<HTMLInputElement>("music-file"),
    volumeMusic: $<HTMLInputElement>("volume-music"),
    duck: $<HTMLInputElement>("duck"),
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
  /** Dragging the webcam and notes straight on the preview. */
  private direct!: DirectEdit;
  /** While the area editor is open, the preview shows the whole recording without effects. */
  private rawView = false;
  private overlay = new OverlayPainter(1920, 1080);
  private sounds = new SoundPreview();
  private music = new Audio();
  private exportDialog = new ExportDialog();
  private thumbs: { t: number; image: ImageBitmap }[] = [];
  private wave: Float32Array | null = null;
  /** Timeline lanes under the clip: webcam frames (on the webcam's clock) and one waveform per source. */
  private webcamThumbs: { t: number; image: ImageBitmap }[] = [];
  private webcamSpan: { start: number; end: number } | undefined;
  private systemWave: Float32Array | null = null;
  private micWave: Float32Array | null = null;
  /** Voice frames of the microphone file the music ducks under; null while they are being read. */
  private voice: { file: string; frames: Uint8Array | null } | null = null;
  /** The music's ducking gains, for the time map, voice and microphone lane they were worked out from. */
  private duck: { time: TimeMap; frames: Uint8Array; shift: number; cuts: Range[]; gains: Float32Array } | null = null;
  private backgroundKey = "";
  private lastTimelineKey = "";
  /** Playhead time (whole ms) the timeline last showed. */
  private lastTimelineMoment = "";
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
  /** Bumped by every open and close, so a slower earlier open gives up instead of overwriting. */
  private openGen = 0;
  /** Set by the main window: a video dropped anywhere becomes a new take instead of an asset. */
  onVideoDrop: ((file: File) => void) | null = null;
  /** The renderer being created, so concurrent callers share one device. */
  private rendererPromise: Promise<void> | null = null;
  /** The GPU device was lost; the next frame creates the renderer again. */
  private rendererLost = false;
  /** The renderer the overlay canvas was last uploaded to; a new one needs it again. */
  private overlayTarget: Renderer | null = null;
  /** The inspector is out of date; the next frame syncs it once for a whole burst of edits. */
  private inspectorDirty = false;
  /** A seek asked for while the video was still seeking; applied once that one lands. */
  private pendingSeek: number | null = null;
  /** Finds the person in the webcam for a blurred or removed background; made on first use. */
  private matte: WebcamMatte | null = null;
  /** Bumped for every new webcam picture, so a paused preview segments it. */
  private webcamFrames = 0;
  /** The webcam picture and mode the last matte was asked for, and the renderer it went to. */
  private matteKey = "";
  private matteTarget: Renderer | null = null;
  /** A finished matte not yet uploaded; `matteVersion` is bumped with each, so a paused preview redraws. */
  private matteReady: Matte | null = null;
  private matteVersion = 0;
  /** Size of the preview area, kept by a ResizeObserver instead of measured every frame. */
  private previewBox: { width: number; height: number } | null = null;
  /** What the last frame showed while paused; the same again means there is nothing to do. */
  private lastIdleKey = "";
  /** Left-click and key times of the open scene, for the sounds and the timeline. */
  private times: { scene: Scene; clicks: number[]; keys: number[] } | null = null;
  /** Multiplies the preview's playback rate; per user, never saved in the project. */
  private previewSpeed = loadPreviewSpeed();

  constructor() {
    this.buildDrop();
    tuckHints(document.querySelector<HTMLElement>(".inspector")!);
    trackKeyboard();
    this.direct = new DirectEdit(this.ui.canvas, {
      select: (target) => this.select({ track: "notes", id: target.id }),
      change: (target, box, done) => this.directChange(target, box, done),
    });
    this.timeline = new Timeline($<HTMLCanvasElement>("timeline"), {
      seek: (time) => this.seek(time),
      trim: (trim) => this.change((project) => (project.trim = trim), false),
      change: (track, items) => this.change((project) => this.setTrack(project, track, items), false),
      select: (selection) => this.select(selection),
      range: (range) => this.setRange(range),
      add: (track, time) => this.addAt(track, time),
      shiftLane: (key, shift, done) => this.shiftLane(key, shift, done),
      laneCuts: (key, cuts) => this.change((project) => (project.media[key].cuts = cuts), false),
      commit: () => {
        // A split dragged onto or into a cut joins it once the drag ends.
        const cuts = this.scene?.project.cuts;
        if (cuts && absorbSplits(cuts) !== cuts) this.change((p) => (p.cuts = absorbSplits(p.cuts)), false);
        this.save();
      },
    });
    this.buildInspector();
    this.buildMenus();
    this.bindPlayback();
    this.bindShortcuts();
    this.music.loop = true;
    const onWebcamFrame = () => {
      this.webcamFrames++;
      this.ui.webcam.requestVideoFrameCallback(onWebcamFrame);
    };
    this.ui.webcam.requestVideoFrameCallback(onWebcamFrame);
    new ResizeObserver(() => {
      const box = this.ui.preview.getBoundingClientRect();
      this.previewBox = { width: box.width, height: box.height };
    }).observe(this.ui.preview);
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
    // Opening another take before this one finished loading makes this one give up.
    const gen = ++this.openGen;

    const cursor = await fetchJson<{ events: CursorEvent[] }>(joinPath(take.dir, take.cursor));
    if (gen !== this.openGen) return;
    const keys = take.keys ? await fetchJson<{ events: KeyEvent[] }>(joinPath(take.dir, take.keys)) : null;
    if (gen !== this.openGen) return;
    const transcript = await fetchJson<{ words: Word[] }>(joinPath(take.dir, "transcript.json"));
    if (gen !== this.openGen) return;
    const events = cursor?.events ?? [];

    const fallback = defaultProject(take, events);
    // A recording opened for the first time starts with the look and sound picked before recording.
    let project = withSavedLook(fallback);
    // Only a take with no project yet; one that failed to load is left alone.
    let firstOpen = false;
    try {
      const saved = await invoke<string | null>("load_project", { dir: take.dir });
      if (gen !== this.openGen) return;
      if (saved) project = normalizeProject(JSON.parse(saved), fallback);
      else firstOpen = true;
    } catch (error) {
      if (gen !== this.openGen) return;
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
    this.pendingSeek = null;
    this.releaseThumbs();
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
    this.loadSystem();
    if (take.webcam) ui.webcam.src = convertFileSrc(joinPath(take.dir, take.webcam));
    else ui.webcam.removeAttribute("src");
    this.loadMusic();
    ui.video.currentTime = this.scene.time.spans[0]?.start / 1000 || 0;
    this.renderTranscript();
    this.syncInspector();
    await this.ensureRenderer();
    if (gen !== this.openGen) return;
    void this.loadBackground();
    // Voice enhancement picked before recording: the microphone is processed once, then heard.
    const sound = loadSoundLook();
    if (firstOpen && sound.enhance && take.mic) void this.setEnhance(true, sound.enhanceLevel);
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
    void this.loadStrip(take, gen);
  }

  /** Closes the timeline thumbnails (screen and webcam); their bitmaps hold memory until then. */
  private releaseThumbs() {
    for (const thumb of [...this.thumbs, ...this.webcamThumbs]) thumb.image.close();
    this.thumbs = [];
    this.webcamThumbs = [];
    this.webcamSpan = undefined;
    this.systemWave = null;
    this.micWave = null;
    this.voice = null;
    this.duck = null;
    this.lastTimelineKey = "";
  }

  /** Thumbnails and waveforms for the timeline, in the background. */
  private async loadStrip(take: Take, gen: number) {
    const url = (file: string) => convertFileSrc(joinPath(take.dir, file));
    const [video, webcam] = await Promise.all([
      openVideo(url(take.video)).catch(() => null),
      take.webcam ? openVideo(url(take.webcam)).catch(() => null) : null,
    ]);
    if (gen !== this.openGen) return;
    // Read a piece at a time: recordings can be far larger than the memory.
    const system = take.systemFile ? url(take.systemFile) : take.systemAudio ? url(take.video) : null;
    const open = (file: string | null): Promise<AudioSource | null> => (file ? openAudio(file).catch(() => null) : Promise.resolve(null));
    const systemAudio = await open(system);
    const micAudio = await open(take.mic ? url(take.mic) : null);
    // One decoder and one audio reader at a time, to keep memory low.
    const frames = async (source: typeof video) => (source ? thumbnails(source.source, source.track).catch(() => []) : []);
    const wave = (audio: AudioSource | null) => (audio ? waveform([audio], take.durationMs).catch(() => null) : null);
    const [[thumbs, webcamThumbs], [systemWave, micWave]] = await Promise.all([
      (async () => [await frames(video), await frames(webcam)])(),
      (async () => [await wave(systemAudio), await wave(micAudio)])(),
    ]);
    if (gen !== this.openGen) {
      for (const thumb of [...thumbs, ...webcamThumbs]) thumb.image.close();
      return;
    }
    this.releaseThumbs();
    this.thumbs = thumbs;
    this.webcamThumbs = webcamThumbs;
    this.webcamSpan = webcam ? trackSpan(webcam.track) : undefined;
    this.systemWave = systemWave;
    this.micWave = micWave;
    // Each audio source has its own lane, so the clip needs no mixed waveform.
    this.wave = null;
    this.lastTimelineKey = "";
  }

  private ensureRenderer(): Promise<void> {
    if (this.renderer) return Promise.resolve();
    this.rendererPromise ??= this.createRenderer().finally(() => (this.rendererPromise = null));
    return this.rendererPromise;
  }

  private async createRenderer() {
    try {
      const renderer = await Renderer.create(this.ui.canvas);
      this.renderer = renderer;
      this.ui.error.hidden = true;
      this.version++;
      void renderer.lost.then((info) => {
        // A renderer dropped on purpose (destroy) is not this one any more.
        if (this.renderer !== renderer) return;
        console.warn("dispositivo WebGPU perdido", info.reason, info.message);
        this.renderer = null;
        this.overlayTarget = null;
        this.backgroundKey = "";
        this.rendererLost = true;
        this.version++;
      });
    } catch (error) {
      this.ui.error.hidden = false;
      this.ui.error.textContent = `Não foi possível iniciar a renderização: ${error}`;
    }
  }

  /** After the GPU device was lost: a new renderer, with the background image uploaded again. */
  private async recoverRenderer() {
    this.rendererLost = false;
    await this.ensureRenderer();
    if (this.renderer) void this.loadBackground();
    else toast("A prévia parou porque a placa de vídeo foi reiniciada. Reabra a gravação para tentar de novo.");
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

  /** Copies an image into the take's folder and makes it the background. */
  private async useBackgroundFile(file: File) {
    const scene = this.scene;
    if (!scene) return;
    try {
      const name = await saveAsset(scene.take.dir, file, `fundo-${Date.now().toString(36)}.${fileExtension(file, "png")}`);
      this.change((p) => {
        p.background.kind = "image";
        p.background.image = name;
      });
      this.flushSave();
      await this.loadBackground();
      toast(`Imagem de fundo: ${file.name}`, { label: "Desfazer", run: () => this.undo() });
    } catch (error) {
      toast(`Não foi possível usar a imagem: ${error}`);
    }
  }

  /** Copies a sound file into the take's folder and makes it the background music. */
  private async useMusicFile(file: File) {
    const scene = this.scene;
    if (!scene) return;
    try {
      const name = await saveAsset(scene.take.dir, file, `musica-${Date.now().toString(36)}.${fileExtension(file, "mp3")}`);
      this.change((p) => (p.audio.music = name));
      this.flushSave();
      this.loadMusic();
      toast(`Música: ${file.name}`, { label: "Desfazer", run: () => this.undo() });
    } catch (error) {
      toast(`Não foi possível usar a música: ${error}`);
    }
  }

  // ---------- dropping files ----------

  /** Dragging files over the window: a sign says what dropping them will do. */
  private buildDrop() {
    const zone = document.createElement("div");
    zone.className = "drop-zone";
    zone.hidden = true;
    zone.setAttribute("aria-hidden", "true");
    const sign = document.createElement("div");
    sign.className = "drop-sign";
    zone.append(sign);
    document.body.append(zone);
    // dragenter/dragleave fire for every element crossed; a count tells when the pointer left the window.
    let depth = 0;
    // A video is imported as a new take, with or without a take open.
    let video = false;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const hide = () => {
      depth = 0;
      zone.hidden = true;
    };
    window.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      const kinds = Array.from(event.dataTransfer?.items ?? []).map((item) => dropKind(item.type, ""));
      video = Boolean(this.onVideoDrop) && kinds.includes("video");
      const message = video
        ? "Solte para importar o vídeo"
        : !this.scene
          ? "Abra uma gravação para usar a música ou a imagem"
          : kinds.includes("image") && kinds.includes("audio")
            ? "Solte para usar a imagem de fundo e a música"
            : kinds.includes("image")
              ? "Solte para usar como imagem de fundo"
              : kinds.includes("audio")
                ? "Solte para usar como música de fundo"
                : "Solte uma imagem, um som ou um vídeo";
      sign.textContent = message;
      zone.classList.toggle("refuse", !video && (!this.scene || (!kinds.includes("image") && !kinds.includes("audio") && kinds.every((kind) => kind === "other"))));
      zone.hidden = false;
    });
    window.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = this.scene || video ? "copy" : "none";
    });
    window.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) hide();
    });
    window.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      hide();
      const files = Array.from(event.dataTransfer?.files ?? []);
      const movie = files.find((file) => dropKind(file.type, file.name) === "video");
      if (movie && this.onVideoDrop) {
        this.onVideoDrop(movie);
        return;
      }
      if (!this.scene) {
        toast("Abra uma gravação para usar a música ou a imagem.");
        return;
      }
      const image = files.find((file) => dropKind(file.type, file.name) === "image");
      const audio = files.find((file) => dropKind(file.type, file.name) === "audio");
      if (!image && !audio) {
        toast("Use uma imagem (PNG, JPG, WebP) ou um som (MP3, WAV, M4A, OGG, FLAC).");
        return;
      }
      if (image) void this.useBackgroundFile(image);
      if (audio) void this.useMusicFile(audio);
    });
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
    // Drags and sliders change on every pointer move; the inspector catches up once per frame.
    this.inspectorDirty = true;
    this.version++;
    if (save) this.save();
  }

  private setTrack(project: Project, track: ItemKey, items: Range[]) {
    const lane = laneOfCut(track);
    if (lane) project.media[lane].cuts = items;
    else if (track === "cuts") project.cuts = items;
    else if (track === "speed") project.speed = items as SpeedRange[];
    else if (track === "notes") project.notes = items as Note[];
    else if (track === "zoom") project.zoom.segments = items as ZoomSegment[];
    else if (track === "camera") project.cameras = items as CameraRange[];
    else if (track === "tilts") project.tilts = items as TiltRange[];
    else project.blurs = items as BlurRegion[];
  }

  private trackItems(project: Project, track: ItemKey): Range[] {
    const lane = laneOfCut(track);
    if (lane) return project.media[lane].cuts;
    if (track === "notes") return project.notes;
    if (track === "camera") return project.cameras;
    if (track === "tilts") return project.tilts;
    return track === "cuts" ? project.cuts : track === "speed" ? project.speed : track === "zoom" ? project.zoom.segments : project.blurs;
  }

  /** Replaces the whole project (undo/redo) and rebuilds what depends on it. */
  private restore(json: string, write = true) {
    const scene = this.scene;
    if (!scene) return;
    const before = scene.project;
    scene.project = JSON.parse(json);
    if (scene.project.cursor.smoothing !== before.cursor.smoothing || scene.project.cursor.bounce !== before.cursor.bounce) this.rebuildCursorPath();
    refreshTime(scene);
    if (this.selected && !this.trackItems(scene.project, this.selected.track).some((item) => item.id === this.selected!.id)) this.selected = null;
    this.syncInspector();
    this.renderTranscript();
    this.loadMusic();
    this.loadMic();
    // Undo may move a lane back; the companions follow.
    this.syncCompanions(false);
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
    const all = this.trackItems(project, track);
    // A new cut is placed among the real cuts, then takes in the splits it covers.
    const items = track === "cuts" ? all.filter((item) => !isSplit(item)) : all;
    const make = (range: Range): Range => {
      if (track === "zoom") return { ...range, scale: project.zoom.defaultScale, mode: "zoom" } as ZoomSegment;
      if (track === "speed") return { ...range, rate: DEFAULT_SPEED } as SpeedRange;
      if (track === "notes") return newNote(range);
      if (track === "camera") return { ...range, layout: this.nextLayout } as CameraRange;
      if (track === "tilts") return { ...range, angle: newTiltAngle(project.tilt) } as TiltRange;
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
    const ranges = track === "cuts" ? absorbSplits([...result.ranges, ...all.filter(isSplit)].sort((a, b) => a.start - b.start)) : result.ranges;
    this.change((p) => this.setTrack(p, track, ranges));
    this.flushSave();
    this.select({ track, id: result.id });
    if (track === "blurs") this.editBlurArea();
    if (track === "notes") this.focusNoteText();
  }

  /** Layout given to the next camera stretch added by double-click or the menus. */
  private nextLayout: CameraLayout = "full";

  private addCameraAt(layout: CameraLayout, time: number) {
    this.nextLayout = layout;
    this.addAt("camera", time);
    this.nextLayout = "full";
  }

  private setCameraLayout(id: string, layout: CameraLayout) {
    this.change((p) => {
      const range = p.cameras.find((candidate) => candidate.id === id);
      if (range) range.layout = layout;
    });
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

  /** Splits the clip at `time` without removing anything, so the seam can carry a transition. */
  private splitAt(time: number) {
    const scene = this.scene;
    if (!scene) return;
    const { project } = scene;
    const at = Math.round(time);
    if (at <= project.trim.start || at >= project.trim.end) {
      toast("Divida num ponto entre o início e o fim do vídeo");
      return;
    }
    if (scene.time.playable(at) !== at) {
      toast("Esse ponto está num trecho cortado");
      return;
    }
    // A seam already there (another split or a cut's edge) is selected instead of doubled.
    const near = project.cuts.find((cut) => Math.abs(cut.start - at) < 40 || Math.abs(cut.end - at) < 40);
    if (near) {
      this.select({ track: "cuts", id: near.id });
      toast(isSplit(near) ? "Já existe uma divisão aqui; ela foi selecionada" : "Já existe uma emenda de corte aqui; ela foi selecionada");
      return;
    }
    const id = newId();
    this.change((p) => (p.cuts = [...p.cuts, { id, start: at, end: at }].sort((a, b) => a.start - b.start)));
    this.flushSave();
    this.range = null;
    this.select({ track: "cuts", id });
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
      // A merged cut keeps a transition one of the old cuts had.
      const transition = (overlapping as Cut[]).find((cut) => cut.transition)?.transition;
      const cuts = [...items.filter((item) => !overlapping.includes(item)), { id, start, end, ...(transition ? { transition } : {}) }].sort((a, b) => a.start - b.start);
      // Splits on the new cut's edges fold into it too.
      this.change((p) => (p.cuts = absorbSplits(cuts)));
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
      ...this.laneKeys().flatMap((key, index): MenuItem[] => [
        ...(index === 0 ? ["separator" as const] : []),
        { label: LANE_WORDS[key].range, icon: LANE_WORDS[key].icon, action: () => this.cutLane(key, range) },
      ]),
      "separator",
      { label: "Reproduzir o trecho", icon: "play", action: () => { this.seek(range.start); if (this.ui.video.paused) this.togglePlay(); } },
      { label: "Tirar a seleção", icon: "close", shortcut: "Esc", action: () => this.setRange(null) },
    ];
  }

  private deleteSelected() {
    const selection = this.selected;
    if (!selection) return;
    this.selected = null;
    const removed = this.selectedKind(selection);
    this.change((project) => this.setTrack(project, selection.track, this.trackItems(project, selection.track).filter((item) => item.id !== selection.id)));
    this.flushSave();
    const names = {
      webcamCut: LANE_WORDS.webcam.restored,
      systemCut: LANE_WORDS.system.restored,
      micCut: LANE_WORDS.mic.restored,
      camera: "A webcam voltou à bolha",
      tilt: "Inclinação removida",
      cut: "Corte removido", split: "Divisão removida", zoom: "Zoom removido", lens: "Lente removida", blur: "Desfoque removido", speed: "Trecho voltou à velocidade normal", text: "Texto removido", arrow: "Seta removida", box: "Destaque removido" };
    toast(names[removed], { label: "Desfazer", run: () => this.undo() });
  }

  /** The kind of a selected item, for labels: cut, split, speed, zoom, lens, blur, a note kind or a lane cut. */
  private selectedKind(selection: Selection): "cut" | "split" | "speed" | "zoom" | "lens" | "blur" | "camera" | "tilt" | NoteKind | `${MediaKey}Cut` {
    if (!selection) return "cut";
    const lane = laneOfCut(selection.track);
    if (lane) return `${lane}Cut`;
    if (selection.track === "camera") return "camera";
    if (selection.track === "tilts") return "tilt";
    if (selection.track === "cuts") {
      const cut = this.scene?.project.cuts.find((candidate) => candidate.id === selection.id);
      return cut && isSplit(cut) ? "split" : "cut";
    }
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
      if (at.kind === "lane") return this.laneMenu(at.key, at.time, at.cut);
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
    if (track === "camera") {
      const current = (item as CameraRange).layout;
      return [
        ...go,
        "separator",
        ...CAMERA_LAYOUTS.map((layout): MenuItem => ({
          label: layout.id === current ? `${layout.name} (atual)` : layout.name,
          icon: "camera",
          disabled: layout.id === current ? "Já está assim" : false,
          action: () => this.setCameraLayout(id, layout.id),
        })),
        "separator",
        { label: "Voltar à bolha", icon: "trash", danger: true, shortcut: "Delete", action: () => this.deleteSelected() },
      ];
    }
    if (track === "tilts") {
      const angle = (item as TiltRange).angle;
      const set = (value: number) => this.change((p) => {
        const range = p.tilts.find((candidate) => candidate.id === id);
        if (range) range.angle = value;
      });
      return [
        ...go,
        "separator",
        { label: "Inclinar para a esquerda", icon: "visual", disabled: angle < 0 ? "Já está assim" : false, action: () => set(-Math.abs(angle || 12)) },
        { label: "Inclinar para a direita", icon: "visual", disabled: angle > 0 ? "Já está assim" : false, action: () => set(Math.abs(angle || 12)) },
        { label: "Deixar plana neste trecho", icon: "visual", disabled: angle === 0 ? "Já está assim" : false, action: () => set(0) },
        "separator",
        { label: "Remover inclinação", icon: "trash", danger: true, shortcut: "Delete", action: () => this.deleteSelected() },
      ];
    }
    if (isSplit(item)) {
      return [
        { label: "Ir para a divisão", icon: "play", action: () => this.seek(item.start) },
        "separator",
        { label: "Remover divisão", icon: "trash", danger: true, shortcut: "Delete", action: () => this.deleteSelected() },
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
      camera: { label: "Webcam em tela cheia aqui", icon: "camera", action: () => this.addCameraAt("full", time) },
      tilts: { label: "Inclinar a tela aqui", icon: "visual", action: () => this.addAt("tilts", time) },
    };
    const items: MenuItem[] = [add[track]];
    if (track === "cuts") items.push({ label: "Dividir aqui, sem cortar", icon: "cut", shortcut: "D", action: () => this.splitAt(time) });
    if (track === "zoom") items.push({ label: "Adicionar lente aqui", icon: "wand", shortcut: "L", action: () => this.addLensAt(time) });
    if (track === "camera") {
      items.push({ label: "Webcam ao lado da tela aqui", icon: "camera", action: () => this.addCameraAt("side", time) });
      items.push({ label: "Ocultar a webcam aqui", icon: "camera", action: () => this.addCameraAt("hidden", time) });
    }
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
      { label: "Dividir aqui", icon: "cut", shortcut: "D", action: () => this.splitAt(time) },
      { label: "Cortar um trecho aqui", icon: "cut", shortcut: "X", action: () => this.addAt("cuts", time) },
      { label: "Adicionar zoom aqui", icon: "zoom", shortcut: "Z", action: () => this.addAt("zoom", time) },
    ];
  }

  /** The media lanes this take has, in timeline order. */
  private laneKeys(): MediaKey[] {
    const take = this.scene?.take;
    if (!take) return [];
    const keys: MediaKey[] = [];
    if (take.webcam) keys.push("webcam");
    if (take.systemFile || take.systemAudio) keys.push("system");
    if (take.mic) keys.push("mic");
    return keys;
  }

  private laneMenu(key: MediaKey, time: number, cutId?: string): MenuItem[] {
    const scene = this.scene!;
    const edit = scene.project.media[key];
    const words = LANE_WORDS[key];
    const cut = cutId ? edit.cuts.find((candidate) => candidate.id === cutId) : undefined;
    const items: MenuItem[] = [];
    if (cut) {
      this.select({ track: laneCutKey(key), id: cut.id });
      items.push(
        { label: "Ir para o início", icon: "play", action: () => this.seek(cut.start) },
        { label: "Ir para o fim", icon: "play", action: () => this.seek(Math.max(cut.start, cut.end - 1)) },
        "separator",
        { label: "Restaurar este trecho", icon: "undo", shortcut: "Delete", action: () => this.deleteSelected() },
      );
    } else {
      // The dragged stretch if there is one, otherwise a second around the point.
      const range = this.range ?? { start: time - LANE_CUT / 2, end: time + LANE_CUT / 2 };
      items.push({ label: words.here, icon: words.icon, danger: true, action: () => this.cutLane(key, range) });
    }
    if (edit.shift) {
      items.push("separator", {
        label: `Voltar ao sincronismo original (${shiftLabel(edit.shift)})`,
        icon: "undo",
        action: () => {
          this.shiftLane(key, 0, true);
          toast("Sincronismo original restaurado", { label: "Desfazer", run: () => this.undo() });
        },
      });
    }
    items.push("separator", { label: "Ir para este ponto", icon: "play", action: () => this.seek(time) });
    return items;
  }

  /** Removes only one media track over `range`: the webcam hides, a sound goes silent. */
  private cutLane(key: MediaKey, range: { start: number; end: number }) {
    const scene = this.scene;
    if (!scene) return;
    const start = Math.max(0, Math.round(range.start));
    const end = Math.min(scene.take.durationMs, Math.round(range.end));
    if (end - start < 50) return;
    let id = "";
    this.change((p) => {
      const result = mergeRange(p.media[key].cuts, { start, end });
      p.media[key].cuts = result.ranges;
      id = result.id;
    });
    this.flushSave();
    this.range = null;
    this.select({ track: laneCutKey(key), id });
    toast(LANE_WORDS[key].done, { label: "Desfazer", run: () => this.undo() });
  }

  /** Moves a media track in time against the screen; `done` ends a drag, so it is saved. */
  private shiftLane(key: MediaKey, shift: number, done: boolean) {
    this.change((p) => (p.media[key].shift = Math.round(shift)), false);
    if (done) this.flushSave();
    this.syncCompanions(false);
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
      { label: "Dividir aqui", icon: "cut", shortcut: "D", action: () => this.splitAt(t) },
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

  /**
   * Picks the area a zoom shows (`focus`) or the area it glides to (`to`) on the whole recording.
   * The box's size sets the zoom's magnification, so what is framed is what is shown.
   */
  private editZoomArea(which: "focus" | "to") {
    const scene = this.scene;
    const zoom = this.selectedItem<ZoomSegment>();
    if (!scene || !zoom || this.selected?.track !== "zoom") return;
    const id = zoom.id;
    const bounds = scene.project.crop ?? { x: 0, y: 0, width: scene.take.width, height: scene.take.height };
    const width = bounds.width / zoom.scale;
    const height = bounds.height / zoom.scale;
    const center = (which === "to" ? zoom.to : null) ?? zoom.focus ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const rect = { x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2), width: Math.round(width), height: Math.round(height) };
    const title = which === "to" ? "Área para onde o zoom desliza" : "Área do zoom";
    this.openRectEditor(title, rect, false, (result) => {
      if (!result) {
        // Cancelled before any point was set: back to following the cursor.
        this.syncInspector();
        return;
      }
      const point = { x: Math.round(result.x + result.width / 2), y: Math.round(result.y + result.height / 2) };
      // The box fits inside the view: the smaller ratio wins.
      const scale = Math.round(Math.min(4, Math.max(1.2, Math.min(bounds.width / result.width, bounds.height / result.height))) * 10) / 10;
      this.change((p) => {
        const segment = p.zoom.segments.find((candidate) => candidate.id === id);
        if (!segment) return;
        if (which === "to") segment.to = point;
        else {
          segment.focus = point;
          segment.scale = scale;
        }
      });
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
    ui.animatedBackgrounds.replaceChildren(
      ...ANIMATED_BACKGROUNDS.map((preset) => {
        const swatch = document.createElement("button");
        swatch.className = "swatch animated";
        swatch.title = `${preset.name} (animado)`;
        swatch.setAttribute("aria-label", `Fundo animado ${preset.name}`);
        swatch.dataset.id = preset.id;
        swatch.style.backgroundImage = `radial-gradient(circle at 30% 30%, ${preset.accent}, transparent 60%), linear-gradient(${preset.angle + 90}deg, ${preset.from}, ${preset.to})`;
        swatch.addEventListener("click", () =>
          this.change((project) => {
            project.background.kind = "animated";
            project.background.animation = preset.id;
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
        screen.className = `screen ${sample.frame}${sample.aspect === "9:16" ? " vertical" : ""}${sample.tilt ? " tilted" : ""}`;
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
    range(ui.bgSpeed, (p, v) => (p.background.speed = v));
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
    range(ui.webcamZoom, (p, v) => (p.webcam.zoom = v));
    range(ui.webcamLight, (p, v) => (p.webcam.light = v));
    range(ui.webcamWarmth, (p, v) => (p.webcam.warmth = v));
    range(ui.webcamBorder, (p, v) => (p.webcam.border = v));
    range(ui.webcamShadow, (p, v) => (p.webcam.shadow = v));
    ui.webcamBorderColors.replaceChildren(
      ...NOTE_COLORS.map((color) => {
        const swatch = document.createElement("button");
        swatch.className = "swatch";
        swatch.dataset.color = color;
        swatch.style.background = color;
        swatch.setAttribute("aria-label", `Borda ${color}`);
        swatch.addEventListener("click", () => this.change((p) => (p.webcam.borderColor = color)));
        return swatch;
      }),
    );
    ui.tiltAdd.addEventListener("click", () => this.addAt("tilts", this.ui.video.currentTime * 1000));
    range(ui.tiltAngle, (p, v) => {
      const tilt = p.tilts.find((candidate) => candidate.id === this.selected?.id);
      if (tilt) tilt.angle = v;
    });
    for (const button of ui.cameraAdd.querySelectorAll<HTMLButtonElement>("button")) {
      button.addEventListener("click", () => this.addCameraAt(button.dataset.layout as CameraLayout, this.ui.video.currentTime * 1000));
    }
    this.radios(ui.cameraLayout, (value) => {
      if (this.selected?.track === "camera") this.setCameraLayout(this.selected.id, value as CameraLayout);
    });
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
      if (!this.scene) return;
      this.change((p) => (p.cursor.smoothing = Number(ui.smoothing.value)));
      this.rebuildCursorPath();
    });
    this.radios(ui.cursorMovement, (value) => {
      const movement = CURSOR_MOVEMENTS.find((candidate) => candidate.id === value);
      if (!movement || !this.scene) return;
      this.change((p) => (p.cursor.smoothing = movement.smoothing));
      this.rebuildCursorPath();
    });
    ui.cursorBounce.addEventListener("input", () => this.showValue(ui.cursorBounce));
    ui.cursorBounce.addEventListener("change", () => {
      if (!this.scene) return;
      this.change((p) => (p.cursor.bounce = Number(ui.cursorBounce.value)));
      this.rebuildCursorPath();
    });
    range(ui.cursorTilt, (p, v) => (p.cursor.tilt = v));

    toggle(ui.cursorVisible, (p, v) => (p.cursor.visible = v));
    toggle(ui.cursorReturn, (p, v) => (p.cursor.returnHome = v));
    toggle(ui.cursorMotion, (p, v) => (p.cursor.motionBlur = v));
    toggle(ui.spotlight, (p, v) => (p.cursor.spotlight = v));
    toggle(ui.cursorFocus, (p, v) => (p.cursor.focus = v));
    range(ui.cursorShapeDelay, (p, v) => (p.cursor.shapeDelay = v));
    range(ui.clickSize, (p, v) => (p.cursor.clickSize = v));
    this.radios(ui.cursorIdle, (value) => this.change((p) => (p.cursor.hideIdle = Number(value))));
    this.radios(ui.clickStyle, (value) =>
      this.change((p) => {
        p.cursor.clickEffect = value !== "none";
        if (value !== "none") p.cursor.clickStyle = value as ClickStyle;
      }),
    );
    this.radios(ui.clickTone, (value) => {
      this.change((p) => {
        p.audio.clickSound = value !== "none";
        if (value !== "none") p.audio.clickTone = value as ClickTone;
      });
      if (value !== "none") this.sounds.sample(value as ClickTone);
    });
    ui.cursorStyles.replaceChildren(
      ...CURSOR_STYLES.map((style) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "choice";
        button.setAttribute("role", "radio");
        button.dataset.value = style.id;
        const name = document.createElement("span");
        name.textContent = style.name;
        button.append(cursorPreview(style.id, 30), name);
        button.addEventListener("click", () => this.change((p) => (p.cursor.style = style.id)));
        return button;
      }),
    );
    ui.transitionKind.replaceChildren(
      ...[{ id: "none", name: "Nenhuma" }, ...TRANSITIONS].map((transition) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "choice";
        button.setAttribute("role", "radio");
        button.dataset.value = transition.id;
        button.textContent = transition.name;
        button.addEventListener("click", () => this.setTransition(transition.id === "none" ? null : (transition.id as TransitionKind)));
        return button;
      }),
    );
    range(ui.transitionDuration, (p, v) => {
      const cut = p.cuts.find((candidate) => candidate.id === this.selected?.id);
      if (cut?.transition) cut.transition.durationMs = Math.round(v * 1000);
    });
    toggle(ui.keysVisible, (p, v) => (p.keys.visible = v));
    toggle(ui.keySound, (p, v) => (p.audio.keySound = v));
    toggle(ui.webcamVisible, (p, v) => (p.webcam.visible = v));
    toggle(ui.webcamMirror, (p, v) => (p.webcam.mirror = v));
    ui.enhance.addEventListener("change", () => void this.setEnhance(ui.enhance.checked));
    this.radios(ui.enhanceLevel, (value) => void this.setEnhance(true, value as EnhanceLevel));
    // Before/after only changes what the preview plays, never the project.
    this.radios(ui.enhanceCompare, (value) => {
      this.hearOriginal = value === "before";
      this.loadMic();
    });
    toggle(ui.loudness, (p, v) => (p.audio.loudness = v));
    toggle(ui.duck, (p, v) => (p.audio.duck = v));
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
    ui.lensShape.replaceChildren(
      ...LENS_SHAPES.map((shape) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "lens-shape";
        input.value = shape.id;
        label.append(input, shape.name);
        return label;
      }),
    );
    this.radios(ui.lensShape, (value) =>
      this.change((p) => {
        const segment = p.zoom.segments.find((candidate) => candidate.id === this.selected?.id);
        if (segment) segment.shape = value as LensShape;
      }),
    );
    this.radios(ui.zoomFocus, (value) => {
      if (value === "point") this.editZoomArea("focus");
      else
        this.change((p) => {
          const segment = p.zoom.segments.find((candidate) => candidate.id === this.selected?.id);
          if (segment) segment.focus = segment.to = null;
        });
    });
    ui.zoomArea.addEventListener("click", () => this.editZoomArea("focus"));
    ui.zoomGlide.addEventListener("click", () => {
      const zoom = this.selectedItem<ZoomSegment>();
      if (zoom?.to) {
        this.change((p) => {
          const segment = p.zoom.segments.find((candidate) => candidate.id === zoom.id);
          if (segment) segment.to = null;
        });
      } else this.editZoomArea("to");
    });
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
    // A corner puts the webcam back in that corner, forgetting where it was dragged.
    this.radios(ui.webcamCorner, (value) =>
      this.change((p) => {
        p.webcam.corner = value as Corner;
        p.webcam.position = null;
      }),
    );
    this.radios(ui.webcamShape, (value) => this.change((p) => (p.webcam.shape = value as Project["webcam"]["shape"])));
    this.radios(ui.webcamBackground, (value) => this.change((p) => (p.webcam.background = value as Project["webcam"]["background"])));
    this.radios(ui.captionsPosition, (value) => this.change((p) => (p.captions.position = value as Project["captions"]["position"])));

    ui.bgImage.addEventListener("click", () => ui.bgFile.click());
    ui.bgFile.addEventListener("change", () => {
      const file = ui.bgFile.files?.[0];
      ui.bgFile.value = "";
      if (file) void this.useBackgroundFile(file);
    });

    ui.musicPick.addEventListener("click", () => ui.musicFile.click());
    ui.musicFile.addEventListener("change", () => {
      const file = ui.musicFile.files?.[0];
      ui.musicFile.value = "";
      if (file) void this.useMusicFile(file);
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
    ui.addSplit.addEventListener("click", () => this.splitAt(this.ui.video.currentTime * 1000));
    this.showPreviewSpeed();
    ui.previewSpeed.addEventListener("click", () => {
      this.previewSpeed = PREVIEW_SPEEDS[(PREVIEW_SPEEDS.indexOf(this.previewSpeed) + 1) % PREVIEW_SPEEDS.length];
      try {
        localStorage.setItem(PREVIEW_SPEED_KEY, String(this.previewSpeed));
      } catch {
        // Not remembered; it still applies until the app closes.
      }
      this.showPreviewSpeed();
      const scene = this.scene;
      this.setRate(scene ? scene.time.rateAt(this.ui.video.currentTime * 1000) : 1);
    });
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
    ui.pauseKeep.addEventListener("input", () => this.showValue(ui.pauseKeep));
    // How pauses are handled is a habit, not part of one take: remembered on this computer.
    try {
      const saved = JSON.parse(localStorage.getItem(PAUSES_KEY) ?? "{}");
      if (saved.mode) this.setRadio(ui.pauseMode, saved.mode);
      if (saved.minMs) ui.silenceMin.value = String(saved.minMs / 1000);
      if (saved.keepMs) ui.pauseKeep.value = String(saved.keepMs / 1000);
    } catch {
      // Defaults.
    }
    const rememberPauses = () => {
      ui.cutSilencesLabel.textContent = this.pauseMode() === "cut" ? "Cortar pausas" : "Encurtar pausas";
      try {
        localStorage.setItem(PAUSES_KEY, JSON.stringify({ mode: this.pauseMode(), minMs: Number(ui.silenceMin.value) * 1000, keepMs: Number(ui.pauseKeep.value) * 1000 }));
      } catch {
        // Only a convenience.
      }
    };
    for (const control of [ui.pauseMode, ui.silenceMin, ui.pauseKeep]) control.addEventListener("change", rememberPauses);
    rememberPauses();
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

  /**
   * Turns voice enhancement on at `level` (processing the microphone once per level; the app
   * keeps each result) or off.
   */
  private async setEnhance(on: boolean, level = this.scene?.project.audio.enhanceLevel ?? "medium") {
    const scene = this.scene;
    if (!scene?.take.mic) return;
    const ui = this.ui;
    if (on) {
      this.enhancing = true;
      ui.enhance.disabled = true;
      for (const input of ui.enhanceLevel.querySelectorAll("input")) input.disabled = true;
      ui.enhanceHint.hidden = false;
      ui.enhanceHint.textContent = "Melhorando a voz…";
      try {
        await invoke("enhance_voice", { dir: scene.take.dir, level });
      } catch (error) {
        this.enhancing = false;
        ui.enhance.checked = scene.project.audio.enhance;
        ui.enhance.disabled = false;
        for (const input of ui.enhanceLevel.querySelectorAll("input")) input.disabled = false;
        this.setRadio(ui.enhanceLevel, scene.project.audio.enhanceLevel);
        ui.enhanceHint.textContent = `Não foi possível melhorar a voz: ${error}`;
        return;
      }
      this.enhancing = false;
      ui.enhance.disabled = false;
      for (const input of ui.enhanceLevel.querySelectorAll("input")) input.disabled = false;
      // Another recording was opened meanwhile; the processed file stays for this one.
      if (this.scene !== scene) return;
    }
    this.change((p) => {
      p.audio.enhance = on;
      p.audio.enhanceLevel = level;
    });
    // A new level is heard at once.
    this.hearOriginal = false;
    this.setRadio(ui.enhanceCompare, "after");
    this.loadMic();
  }

  /** Plays the microphone as recorded even with enhancement on, to compare. */
  private hearOriginal = false;

  /** The microphone track for preview: the enhanced one when that option is on. */
  private loadMic() {
    const scene = this.scene;
    const mic = this.ui.mic;
    if (!scene?.take.mic) {
      mic.removeAttribute("src");
      return;
    }
    const file = scene.project.audio.enhance && !this.hearOriginal ? enhancedFile(scene.project.audio.enhanceLevel) : scene.take.mic;
    const time = this.ui.video.currentTime - scene.project.media.mic.shift / 1000;
    mic.src = convertFileSrc(joinPath(scene.take.dir, file));
    mic.currentTime = Math.max(0, time);
    if (!this.ui.video.paused && time >= 0) void mic.play();
  }

  /** The system sound's own file, for takes that have one; older takes play it from the video. */
  private loadSystem() {
    const scene = this.scene;
    const system = this.ui.system;
    if (!scene?.take.systemFile) {
      system.removeAttribute("src");
      return;
    }
    const time = this.ui.video.currentTime - scene.project.media.system.shift / 1000;
    system.src = convertFileSrc(joinPath(scene.take.dir, scene.take.systemFile));
    system.currentTime = Math.max(0, time);
    if (!this.ui.video.paused && time >= 0) void system.play();
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

  /** Reruns the cursor's spring after smoothing or bounce changed. */
  private rebuildCursorPath() {
    const scene = this.scene;
    if (scene) scene.cursor = cursorPath(scene.raw, scene.take.durationMs, scene.project.cursor.smoothing, scene.project.cursor.bounce);
  }

  private showValue(input: HTMLInputElement) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 1);
    input.style.setProperty("--fill", `${((Number(input.value) - min) / (max - min || 1)) * 100}%`);
    const output = document.querySelector<HTMLElement>(`[data-value-for="${input.id}"]`);
    if (!output) return;
    const value = Number(input.value);
    const percent = ["padding", "shadow", "cursor-smoothing", "cursor-bounce", "cursor-tilt", "webcam-size", "webcam-shadow", "volume-system", "volume-mic", "volume-music"];
    output.textContent = percent.includes(input.id)
      ? `${Math.round(value * 100)}%`
      : input.id === "webcam-light" || input.id === "webcam-warmth"
        ? lookText(input.id === "webcam-light" ? "light" : "warmth", value)
      : input.id === "radius" || input.id === "bg-blur"
        ? `${value}px`
        : input.id === "tilt" || input.id === "tilt-angle"
          ? `${value}°`
          : input.id === "webcam-border"
            ? `${(value * 100).toFixed(1).replace(".", ",")}%`
            : input.id === "silence-min" || input.id === "pause-keep" || input.id === "cards-duration" || input.id === "transition-duration"
              ? `${value.toFixed(1).replace(".", ",")} s`
              : input.id === "bg-speed"
                ? `${String(value).replace(".", ",")}×`
              : input.id === "cursor-shape-delay"
                ? value
                  ? `${value} ms`
                  : "desligado"
                : `${value.toFixed(input.id === "captions-size" ? 2 : 1).replace(".", ",")}×`;
  }

  private syncInspector() {
    const scene = this.scene;
    if (!scene) return;
    this.inspectorDirty = false;
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
    const animated = project.background.kind === "animated";
    for (const swatch of ui.animatedBackgrounds.querySelectorAll<HTMLElement>(".swatch")) {
      swatch.classList.toggle("selected", animated && swatch.dataset.id === project.background.animation);
    }
    ui.bgSpeedRow.hidden = !animated;
    ui.bgSpeed.value = String(project.background.speed);
    ui.bgImage.classList.toggle("selected", project.background.kind === "image");
    ui.bgBlurRow.hidden = project.background.kind !== "image";
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
    const cursorControls = [ui.cursorVisible, ui.cursorSize, ui.smoothing, ui.cursorBounce, ui.cursorTilt, ui.cursorFocus, ...ui.cursorMovement.querySelectorAll("input"), ui.cursorReturn, ui.cursorShapeDelay, ...ui.cursorIdle.querySelectorAll("input"), ...ui.cursorStyles.querySelectorAll("button")];
    for (const control of cursorControls) (control as HTMLInputElement).disabled = !redrawable;
    const hasClicks = scene.clicks.length > 0;
    for (const control of [ui.spotlight, ui.clickSize, ...ui.clickStyle.querySelectorAll("input"), ...ui.clickTone.querySelectorAll("input")]) control.disabled = !hasClicks;
    for (const group of [ui.clickStyle, ui.clickTone, ui.spotlight.closest("label")!]) group.title = hasClicks ? "" : "Não há cliques nesta gravação";
    ui.cursorVisible.checked = project.cursor.visible;
    ui.cursorSize.value = String(project.cursor.size);
    ui.smoothing.value = String(project.cursor.smoothing);
    // A preset lights up only while the slider sits exactly on its value.
    this.setRadio(ui.cursorMovement, CURSOR_MOVEMENTS.find((movement) => Math.abs(movement.smoothing - project.cursor.smoothing) < 0.001)?.id ?? "");
    ui.cursorBounce.value = String(project.cursor.bounce);
    ui.cursorTilt.value = String(project.cursor.tilt);
    ui.cursorFocus.checked = project.cursor.focus;
    for (const button of ui.cursorStyles.querySelectorAll<HTMLElement>(".choice")) button.setAttribute("aria-checked", String(button.dataset.value === project.cursor.style));
    this.setRadio(ui.cursorIdle, String(project.cursor.hideIdle));
    ui.cursorReturn.checked = project.cursor.returnHome;
    ui.cursorMotion.checked = project.cursor.motionBlur;
    ui.cursorShapeDelay.value = String(project.cursor.shapeDelay);
    this.setRadio(ui.clickStyle, project.cursor.clickEffect ? project.cursor.clickStyle : "none");
    ui.clickSizeField.hidden = !project.cursor.clickEffect;
    ui.clickSize.value = String(project.cursor.clickSize);
    ui.spotlight.checked = project.cursor.spotlight;
    this.setRadio(ui.clickTone, project.audio.clickSound ? project.audio.clickTone : "none");

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
      const titles = { webcamCut: LANE_WORDS.webcam.title, systemCut: LANE_WORDS.system.title, micCut: LANE_WORDS.mic.title, camera: "Câmera neste trecho", tilt: "Inclinação neste trecho", cut: "Corte selecionado", split: "Divisão selecionada", speed: "Trecho acelerado", zoom: "Zoom selecionado", lens: "Lente selecionada", blur: "Desfoque selecionado", text: "Texto selecionado", arrow: "Seta selecionada", box: "Destaque selecionado" };
      const removes = { webcamCut: "Restaurar", systemCut: "Restaurar", micCut: "Restaurar", camera: "Voltar à bolha", tilt: "Remover inclinação", cut: "Remover corte", split: "Remover divisão", speed: "Voltar à velocidade normal", zoom: "Remover zoom", lens: "Remover lente", blur: "Remover desfoque", text: "Remover texto", arrow: "Remover seta", box: "Remover destaque" };
      ui.selectionTitle.textContent = titles[kind];
      ui.selectionDeleteLabel.textContent = removes[kind];
      const seconds = (selected.end - selected.start) / 1000;
      ui.selectionTime.textContent =
        kind === "split"
          ? `Em ${formatTime(selected.start)} · nada é cortado`
          : `${formatTime(selected.start)} – ${formatTime(selected.end)} · ${seconds.toFixed(1).replace(".", ",")} s`;
      ui.selectionZoom.hidden = kind !== "zoom" && kind !== "lens";
      ui.selectionTransition.hidden = kind !== "cut" && kind !== "split";
      if (kind === "cut" || kind === "split") {
        const transition = (selected as Cut).transition;
        for (const button of ui.transitionKind.querySelectorAll<HTMLElement>(".choice")) button.setAttribute("aria-checked", String(button.dataset.value === (transition?.kind ?? "none")));
        ui.transitionDurationField.hidden = !transition;
        ui.transitionDuration.value = String((transition?.durationMs ?? DEFAULT_TRANSITION.durationMs) / 1000);
      }
      ui.blurArea.hidden = kind !== "blur";
      ui.selectionSpeed.hidden = kind !== "speed";
      ui.selectionCamera.hidden = kind !== "camera";
      if (kind === "camera") this.setRadio(ui.cameraLayout, (selected as CameraRange).layout);
      ui.selectionTilt.hidden = kind !== "tilt";
      if (kind === "tilt") ui.tiltAngle.value = String((selected as TiltRange).angle);
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
        const lens = zoom.mode === "lens";
        ui.zoomFocusField.hidden = lens;
        ui.lensShapeField.hidden = !lens;
        this.setRadio(ui.lensShape, zoom.shape ?? "circle");
        this.setRadio(ui.zoomFocus, zoom.focus ? "point" : "cursor");
        ui.zoomArea.hidden = ui.zoomGlide.hidden = !zoom.focus;
        ui.zoomGlideLabel.textContent = zoom.to ? "Sem deslizar" : "Deslizar para outra área…";
      }
    }

    const hasWebcam = Boolean(take.webcam);
    ui.webcamNote.hidden = hasWebcam;
    const webcamControls = [
      ui.webcamVisible, ui.webcamSize, ui.webcamMirror, ui.webcamZoom, ui.webcamLight, ui.webcamWarmth, ui.webcamBorder, ui.webcamShadow,
      ...ui.webcamCorner.querySelectorAll("input"), ...ui.webcamShape.querySelectorAll("input"), ...ui.webcamBackground.querySelectorAll("input"),
      ...ui.webcamBorderColors.querySelectorAll("button"), ...ui.cameraAdd.querySelectorAll("button"),
    ];
    for (const control of webcamControls) (control as HTMLInputElement).disabled = !hasWebcam;
    ui.webcamVisible.checked = project.webcam.visible;
    ui.webcamSize.value = String(project.webcam.size);
    // A dragged webcam is in no corner.
    this.setRadio(ui.webcamCorner, project.webcam.position ? "" : project.webcam.corner);
    this.setRadio(ui.webcamShape, project.webcam.shape);
    this.setRadio(ui.webcamBackground, project.webcam.background);
    ui.webcamMirror.checked = project.webcam.mirror;
    ui.webcamZoom.value = String(project.webcam.zoom);
    ui.webcamLight.value = String(project.webcam.light);
    ui.webcamWarmth.value = String(project.webcam.warmth);
    ui.webcamBorder.value = String(project.webcam.border);
    ui.webcamShadow.value = String(project.webcam.shadow);
    for (const swatch of ui.webcamBorderColors.querySelectorAll<HTMLElement>(".swatch")) swatch.classList.toggle("selected", swatch.dataset.color === project.webcam.borderColor);

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
      this.setRadio(ui.enhanceLevel, project.audio.enhanceLevel);
      ui.enhanceOptions.hidden = !take.mic || !project.audio.enhance;
      ui.enhanceHint.hidden = Boolean(take.mic);
      ui.enhanceHint.textContent = "Disponível quando a gravação tem microfone.";
    }
    ui.loudness.checked = project.audio.loudness;
    ui.loudness.disabled = !take.mic && !take.systemAudio && !project.audio.music;
    ui.volumeMusic.value = String(project.audio.musicVolume);
    ui.volumeMusic.disabled = !project.audio.music;
    ui.duck.checked = project.audio.duck;
    ui.duck.disabled = !project.audio.music || !take.mic;
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
    for (const input of [ui.cardsDuration, ui.noteSize, ui.silenceMin, ui.pauseKeep, ui.padding, ui.radius, ui.shadow, ui.tilt, ui.tiltAngle, ui.bgBlur, ui.bgSpeed, ui.cursorSize, ui.smoothing, ui.cursorBounce, ui.cursorTilt, ui.cursorShapeDelay, ui.clickSize, ui.transitionDuration, ui.zoomDefault, ui.zoomScale, ui.webcamSize, ui.webcamZoom, ui.webcamLight, ui.webcamWarmth, ui.webcamBorder, ui.webcamShadow, ui.volumeSystem, ui.volumeMic, ui.volumeMusic, ui.captionsSize]) {
      this.showValue(input);
    }
    this.video.volume = Math.min(1, project.audio.system);
    this.ui.mic.volume = Math.min(1, project.audio.mic);
    this.ui.system.volume = Math.min(1, project.audio.system);
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
      this.ui.system.pause();
      webcam.pause();
      this.music.pause();
    });
    video.addEventListener("seeked", () => {
      // A newer seek waited for this one; the companions follow when it lands.
      if (this.applyPendingSeek()) return;
      this.syncCompanions(false);
    });
    // A paused preview shows the webcam's new frame once a lane move or seek lands.
    webcam.addEventListener("seeked", () => {
      if (video.paused) this.version++;
    });
  }

  /**
   * Keeps microphone, system sound, webcam and music in step with the main video, each moved by
   * its own shift and silent inside its own cuts.
   */
  private syncCompanions(start: boolean) {
    const scene = this.scene;
    if (!scene) return;
    const { video, mic, webcam, system } = this.ui;
    const { take, project } = scene;
    const media = project.media;
    const t = video.currentTime;
    if (take.mic) this.follow(mic, t - media.mic.shift / 1000, start, 0.08);
    if (take.systemFile) this.follow(system, t - media.system.shift / 1000, start, 0.08);
    if (take.webcam) this.follow(webcam, t - ((take.webcamOffsetMs ?? 0) + media.webcam.shift) / 1000, start, 0.1);
    // Inside a track's own cuts its sound drops to nothing; elsewhere it keeps its volume.
    const silent = (key: MediaKey) => media[key].cuts.some((cut) => t * 1000 >= cut.start && t * 1000 < cut.end);
    const volume = (element: HTMLMediaElement, value: number) => {
      if (element.volume !== value) element.volume = value;
    };
    volume(mic, silent("mic") ? 0 : Math.min(1, project.audio.mic));
    const systemVolume = silent("system") ? 0 : Math.min(1, project.audio.system);
    volume(system, systemVolume);
    // Older takes play the system sound from the video itself.
    volume(video, systemVolume);
    volume(this.music, Math.min(1, project.audio.musicVolume) * this.duckGain(scene, t * 1000));
    if (project.audio.music && this.music.duration) {
      const musicTime = (scene.time.toOutput(t * 1000) / 1000) % this.music.duration;
      if (start || Math.abs(this.music.currentTime - musicTime) > 0.25) this.music.currentTime = musicTime;
    }
    if (start && !video.paused && project.audio.music) void this.music.play();
  }

  /**
   * The music's gain at take time `t` (ms) while ducking under the voice: 1 when off, and until the
   * microphone's voice has been read in the background.
   */
  private duckGain(scene: Scene, t: number): number {
    const { take, project, time } = scene;
    if (!project.audio.duck || !project.audio.music || !take.mic || project.audio.mic <= 0) return 1;
    // Like the export: the enhanced microphone when that is on.
    const file = project.audio.enhance ? enhancedFile(project.audio.enhanceLevel) : take.mic;
    if (this.voice?.file !== file) {
      this.voice = { file, frames: null };
      void this.loadVoice(take, file);
    }
    const frames = this.voice.frames;
    if (!frames) return 1;
    const edit = project.media.mic;
    let duck = this.duck;
    if (!duck || duck.time !== time || duck.frames !== frames || duck.shift !== edit.shift || duck.cuts !== edit.cuts) {
      duck = this.duck = { time, frames, shift: edit.shift, cuts: edit.cuts, gains: duckGains(frames, time, edit) };
    }
    return duckAt(duck.gains, time.toOutput(t));
  }

  /** Reads the voice of a microphone file for ducking, falling back to the recording itself. */
  private async loadVoice(take: Take, file: string) {
    const url = (name: string) => convertFileSrc(joinPath(take.dir, name));
    const open = (name: string) => openAudio(url(name)).catch(() => null);
    const audio = (await open(file)) ?? (take.mic && file !== take.mic ? await open(take.mic) : null);
    const frames = audio ? await voiceLevels(audio, take.durationMs).then(voiceActivity, () => null) : null;
    // Without a readable voice the music stays as it is.
    if (this.voice?.file === file && this.scene?.take === take) this.voice.frames = frames ?? new Uint8Array(0);
  }

  /**
   * Puts a companion track at `time` (s on its own clock). Outside its file it waits paused at the
   * nearest end; inside, it plays along with the video.
   */
  private follow(element: HTMLMediaElement, time: number, start: boolean, tolerance: number) {
    const end = Number.isFinite(element.duration) ? element.duration : Infinity;
    if (time < 0 || time >= end) {
      if (!element.paused) element.pause();
      const edge = time < 0 ? 0 : end;
      if (Number.isFinite(edge) && Math.abs(element.currentTime - edge) > tolerance) element.currentTime = edge;
      return;
    }
    if (start || Math.abs(element.currentTime - time) > tolerance) element.currentTime = time;
    // A file that can't play would fail again every frame; the error is already in the console once.
    if (!this.ui.video.paused && element.paused) element.play().catch(() => undefined);
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
      else if (key === "KeyD") this.splitAt(t);
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
    // Play from where the user last scrubbed to, even if that seek is still waiting.
    if (this.pendingSeek !== null) {
      video.currentTime = this.pendingSeek / 1000;
      this.pendingSeek = null;
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

  /**
   * Sets or clears the transition on the selected cut, then plays the seam so the user sees it.
   */
  private setTransition(kind: TransitionKind | null) {
    const scene = this.scene;
    const id = this.selected?.track === "cuts" ? this.selected.id : null;
    if (!scene || !id) return;
    this.change((p) => {
      const cut = p.cuts.find((candidate) => candidate.id === id);
      if (cut) cut.transition = kind ? { kind, durationMs: cut.transition?.durationMs ?? DEFAULT_TRANSITION.durationMs } : undefined;
    });
    this.flushSave();
    const cut = scene.project.cuts.find((candidate) => candidate.id === id);
    if (!kind || !cut?.transition) return;
    const seam = scene.time.toOutput(cut.start);
    if (seam <= 0 || seam >= scene.time.duration) {
      toast(`A transição aparece quando há vídeo dos dois lados ${isSplit(cut) ? "da divisão" : "do corte"}`);
      return;
    }
    this.seek(scene.time.toSource(Math.max(0, seam - cut.transition.durationMs / 2 - 500)));
    void this.ui.video.play();
  }

  private seek(time: number) {
    if (this.card) this.stopCard();
    // Scrubbing asks for a seek on every pointer move: keep one in flight and only the latest waiting.
    if (this.ui.video.seeking) {
      this.pendingSeek = time;
      return;
    }
    this.pendingSeek = null;
    this.ui.video.currentTime = time / 1000;
  }

  /** Starts the seek that waited for the previous one; true if there was one. */
  private applyPendingSeek() {
    if (this.pendingSeek === null || this.ui.video.seeking) return false;
    const time = this.pendingSeek;
    this.pendingSeek = null;
    this.ui.video.currentTime = time / 1000;
    return true;
  }

  /** Closes the open take (e.g. after it was moved to the Recycle Bin). */
  close() {
    this.flushSave();
    this.ui.video.pause();
    this.rectEditor.close();
    this.openGen++;
    this.pendingSeek = null;
    this.releaseThumbs();
    this.scene = null;
    this.selected = null;
    this.ui.root.hidden = true;
    for (const media of [this.ui.video, this.ui.webcam, this.ui.mic, this.ui.system]) media.removeAttribute("src");
    this.music.removeAttribute("src");
  }

  /** Adds cuts, merging them with cuts they touch. */
  private addCuts(ranges: Span[]) {
    this.change((p) => (p.cuts = mergeCuts(p.cuts, ranges)));
    this.flushSave();
  }

  private pauseMode(): PauseMode {
    return this.ui.pauseMode.querySelector<HTMLInputElement>("input:checked")?.value === "cut" ? "cut" : "speed";
  }

  /**
   * Shortens the long pauses found in the microphone (or the recording's own sound): sped up, so
   * the picture keeps going, or cut, leaving a short breath.
   */
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
      const mode = this.pauseMode();
      const keepMs = Number(ui.pauseKeep.value) * 1000;
      const silences = findSilences(samples, SAMPLE_RATE, spans, Number(ui.silenceMin.value) * 1000, pausePad(mode, keepMs));
      const ranges = mode === "speed" ? pauseSpeeds(silences, keepMs, scene.project.speed) : silences;
      if (!ranges.length) {
        ui.cleanupHint.textContent = "Nenhuma pausa desse tamanho encontrada. Se a gravação não tem fala clara, não há pausas para encurtar.";
        return;
      }
      // Pauses over most of the video mean the sound has no clear speech; changing it all would wreck the edit.
      const kept = spans.reduce((sum, span) => sum + span.end - span.start, 0);
      const quiet = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
      if (quiet > kept * 0.7) {
        ui.cleanupHint.textContent = "Quase todo o áudio parece pausa: a fala não está clara. Nada foi mudado.";
        return;
      }
      // Time the video gets shorter by.
      const saved = mode === "speed"
        ? (ranges as SpeedRange[]).reduce((sum, range) => sum + (range.end - range.start) * (1 - 1 / range.rate), 0)
        : ranges.reduce((sum, range) => sum + range.end - range.start, 0);
      const seconds = `${(saved / 1000).toFixed(1).replace(".", ",")} s`;
      if (mode === "speed") {
        this.change((p) => (p.speed = [...p.speed, ...(ranges as SpeedRange[]).map((range) => ({ id: newId(), start: range.start, end: range.end, rate: range.rate }))].sort((a, b) => a.start - b.start)));
        this.flushSave();
        ui.cleanupHint.textContent = "As pausas aceleradas aparecem na faixa Velocidade e podem ser desfeitas.";
      } else {
        this.addCuts(ranges);
        ui.cleanupHint.textContent = "Os cortes aparecem na timeline e podem ser desfeitos.";
      }
      const count = `${ranges.length} ${ranges.length === 1 ? "pausa" : "pausas"}`;
      toast(`${count} ${mode === "speed" ? "encurtadas" : "cortadas"}: o vídeo ficou ${seconds} mais curto`, { label: "Desfazer", run: () => this.undo() });
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

  /**
   * Plays sped-up stretches faster and silent, with the camera and microphone in step. The preview
   * speed multiplies it (sound stays on and keeps its pitch); music follows the output clock.
   */
  private setRate(rate: number) {
    const { video, mic, webcam } = this.ui;
    const target = rate * this.previewSpeed;
    const muted = rate !== 1;
    if (video.playbackRate === target && video.muted === muted && this.music.playbackRate === this.previewSpeed) return;
    for (const media of [video, mic, webcam, this.ui.system]) media.playbackRate = target;
    this.music.playbackRate = this.previewSpeed;
    video.muted = muted;
    mic.muted = muted;
    this.ui.system.muted = muted;
  }

  private showPreviewSpeed() {
    const button = this.ui.previewSpeed;
    button.textContent = speedLabel(this.previewSpeed);
    button.classList.toggle("active", this.previewSpeed !== 1);
    button.setAttribute("aria-label", `Velocidade da prévia: ${speedLabel(this.previewSpeed)}`);
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
    const box = this.previewBox ?? this.ui.preview.getBoundingClientRect();
    const scale = Math.min(box.width / output.width, (box.height - (this.rectEditor.isOpen ? 48 : 0)) / output.height);
    const cssWidth = Math.max(1, Math.floor(output.width * scale));
    const cssHeight = Math.max(1, Math.floor(output.height * scale));
    const canvas = this.ui.canvas;
    if (canvas.style.width !== `${cssWidth}px`) canvas.style.width = `${cssWidth}px`;
    if (canvas.style.height !== `${cssHeight}px`) canvas.style.height = `${cssHeight}px`;
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

  /**
   * Keeps the webcam matte current when its background is blurred or removed and it is visible:
   * asks the worker for each new picture, one at a time, and uploads each answer as it arrives
   * (a frame or two late while playing, exact once paused). Until the segmenter has loaded, the
   * webcam shows as recorded.
   */
  private updateMatte(renderer: Renderer, state: ReturnType<typeof frameState>) {
    if (this.matteReady) {
      renderer.setWebcamMatte(this.matteReady);
      this.matteReady.blurred?.close();
      this.matteReady = null;
    }
    const webcam = state.webcam;
    const camera = this.ui.webcam;
    if (!webcam || webcam.background === "original" || webcam.opacity <= 0.001) return;
    if (camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !camera.videoWidth) return;
    const blur = webcam.background === "blur";
    const key = `${this.webcamFrames}|${blur}`;
    if (key === this.matteKey && this.matteTarget === renderer) return;
    if (!this.matte) {
      this.matte = new WebcamMatte();
      this.matte.ready().then(
        () => this.matteVersion++,
        (error) => console.error("Recorte da webcam indisponível:", error),
      );
    }
    if (!this.matte.loaded || this.matte.busy) return;
    this.matteKey = key;
    this.matteTarget = renderer;
    this.matte.segment(camera, camera.currentTime * 1000, blur).then(
      (matte) => {
        this.matteReady?.blurred?.close();
        this.matteReady = matte;
        this.matteVersion++;
      },
      (error) => console.error("O recorte da webcam falhou:", error),
    );
  }

  private renderFrame(t: number, key: string) {
    const scene = this.scene!;
    const renderer = this.renderer;
    if (!renderer) return;
    try {
      const output = this.outputFor(scene);
      // The shader samples the overlay by position, so the preview only needs its own resolution.
      this.overlay.resize(output.width, output.height, this.ui.canvas.width / output.width);
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
          motion: null,
          spotlight: 0,
          focusMode: 0,
          webcam: null,
          area: null,
          overlay: false,
          cursor: null,
          clicks: [],
          transition: null,
          blurs: this.selected?.track === "blurs" ? [] : state.blurs,
          background: { ...state.background, padding: 0, radius: 0, shadow: 0 },
        });
      } else {
        const painted = this.overlay.paint(overlayText(scene, t), scene.project, this.cardView());
        if (painted || this.overlayTarget !== renderer) {
          renderer.setOverlay(this.overlay.canvas);
          this.overlayTarget = renderer;
        }
        state = frameState(scene, t, output, this.overlay.visible);
      }
      this.updateMatte(renderer, state);
      if (renderer.render(this.ui.video, state, scene.take.webcam ? this.ui.webcam : null)) this.lastRenderKey = key;
      this.updateDirect(scene, t, output);
    } catch (error) {
      // Show the failure once instead of throwing on every frame.
      this.renderer = null;
      this.overlayTarget = null;
      try {
        renderer.destroy();
      } catch {
        // Already unusable; nothing more to release.
      }
      this.ui.error.hidden = false;
      this.ui.error.textContent = `A renderização falhou: ${error}`;
    }
  }

  /** What can be dragged on the preview at `t`: the webcam bubble and the notes on screen. */
  private updateDirect(scene: Scene, t: number, output: { width: number; height: number }) {
    const { project, take } = scene;
    const targets: DirectTarget[] = [];
    const inLayout = project.cameras.some((range) => t >= range.start && t <= range.end);
    const cut = project.media.webcam.cuts.some((range) => t >= range.start && t <= range.end);
    if (take.webcam && project.webcam.visible && !inLayout && !cut) {
      targets.push({ kind: "webcam", id: "webcam", box: webcamBubble(project, output).rect, round: project.webcam.shape === "circle" });
    }
    for (const note of project.notes) {
      if (t < note.start || t > note.end) continue;
      targets.push({ kind: "note", id: note.id, box: { x: note.x * output.width, y: note.y * output.height, width: note.width * output.width, height: note.height * output.height } });
    }
    const selected = this.selected?.track === "notes" ? this.selected.id : null;
    this.direct.update(output, targets, selected, !this.rawView && !this.rectEditor.isOpen && !this.card);
  }

  /** A drag on the preview moved or resized the webcam or a note. */
  private directChange(target: DirectTarget, box: Rect, done: boolean) {
    const scene = this.scene;
    if (!scene) return;
    const output = this.outputFor(scene);
    this.change((p) => {
      if (target.kind === "webcam") {
        p.webcam.size = Math.min(0.9, Math.max(0.05, box.width / Math.min(output.width, output.height)));
        p.webcam.position = { x: (box.x + box.width / 2) / output.width, y: (box.y + box.height / 2) / output.height };
        return;
      }
      const note = p.notes.find((candidate) => candidate.id === target.id);
      if (note) Object.assign(note, { x: box.x / output.width, y: box.y / output.height, width: box.width / output.width, height: box.height / output.height });
    });
    if (done) this.flushSave();
  }

  private frame() {
    requestAnimationFrame(() => this.frame());
    const scene = this.scene;
    if (!scene || this.ui.root.hidden) return;
    const { video } = this.ui;
    if (this.inspectorDirty) this.syncInspector();
    if (this.pendingSeek !== null) this.applyPendingSeek();
    if (this.rendererLost && !this.rendererPromise) void this.recoverRenderer();
    const { project, take, time } = scene;
    let t = video.currentTime * 1000;

    // Paused with nothing new since the last frame: it still stands.
    const idleKey = `${t}|${this.version}|${video.readyState}|${this.ui.webcam.readyState}|${this.webcamFrames}|${this.matteVersion}|${this.previewBox?.width}|${this.previewBox?.height}|${window.devicePixelRatio}|${this.lastRenderKey}|${this.lastTimelineKey}`;
    if (video.paused && !this.card && idleKey === this.lastIdleKey) return;
    this.lastIdleKey = idleKey;

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
        const times = this.eventTimes(scene);
        this.sounds.update(t, times.clicks, times.keys, { click: project.audio.clickSound, tone: project.audio.clickTone, key: project.audio.keySound });
      }
    }

    const output = this.outputFor(scene);
    const resized = this.layoutCanvas(output);
    const renderKey = `${t}|${this.version}|${video.readyState}|${this.ui.webcam.readyState}|${this.webcamFrames}|${this.matteVersion}`;
    if (!video.paused || this.card || resized || renderKey !== this.lastRenderKey) this.renderFrame(t, renderKey);

    const current = `${formatTime(time.toOutput(t))} `;
    const total = `/ ${formatTime(time.duration)}`;
    const currentNode = this.ui.time.firstChild;
    const totalNode = this.ui.time.lastChild;
    if (currentNode && currentNode.textContent !== current) currentNode.textContent = current;
    if (totalNode && totalNode.textContent !== total) totalNode.textContent = total;

    // Only the playhead moves while playing; the rest of the timeline is rebuilt when the edit changes.
    const moment = t.toFixed(0);
    const key = `${this.version}|${this.thumbs.length}|${this.wave ? 1 : 0}|${this.range?.start}|${this.range?.end}`;
    if (key === this.lastTimelineKey) {
      if (moment !== this.lastTimelineMoment) {
        this.lastTimelineMoment = moment;
        this.timeline.setTime(t);
        this.highlightWord(t);
      }
    } else {
      this.lastTimelineKey = key;
      this.lastTimelineMoment = moment;
      const zoomColor = "#ff9f0a";
      const tracks: Track[] = [
        {
          key: "cuts",
          label: "Cortes",
          color: "#ff453a",
          items: project.cuts,
          text: (item) => {
            const transition = (item as Cut).transition;
            return transition ? `Cortado · ${TRANSITIONS.find((candidate) => candidate.id === transition.kind)?.name ?? ""}` : "Cortado";
          },
        },
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
        { key: "tilts", label: "3D", color: "#ff375f", items: project.tilts, text: (item) => tiltLabel((item as TiltRange).angle) },
        // Only with a webcam: where it leaves its bubble.
        ...(take.webcam
          ? [{ key: "camera" as const, label: "Câmera", color: "#5ac8fa", items: project.cameras, text: (item: Range) => CAMERA_LAYOUTS.find((layout) => layout.id === (item as CameraRange).layout)?.name ?? "" }]
          : []),
      ];
      // Lanes follow what the take recorded, so the layout doesn't jump when their media loads.
      const lanes: MediaLane[] = [];
      const { media } = project;
      const edit = (key: MediaKey) => ({ key, shift: media[key].shift, cuts: media[key].cuts });
      if (take.webcam) {
        lanes.push({ label: "Webcam", kind: "frames", color: "#8e8e93", frames: this.webcamThumbs, offset: take.webcamOffsetMs ?? 0, span: this.webcamSpan, ...edit("webcam") });
      }
      if (take.systemFile || take.systemAudio) {
        // Sound inside the screen's own file (older takes) plays with it, so it can't be moved.
        lanes.push({ label: "Sistema", kind: "wave", color: "#5e5ce6", wave: this.systemWave, muted: project.audio.system <= 0, fixed: !take.systemFile, ...edit("system") });
      }
      if (take.mic) lanes.push({ label: "Microfone", kind: "wave", color: "#66d4cf", wave: this.micWave, muted: project.audio.mic <= 0, ...edit("mic") });
      this.timeline.set({
        duration: take.durationMs,
        time: t,
        trim: project.trim,
        tracks,
        wordCuts: wordCuts(scene),
        clicks: this.eventTimes(scene).clicks,
        markers: take.markers ?? [],
        selected: this.selected,
        thumbnails: this.thumbs,
        waveform: this.wave,
        range: this.range,
        lanes,
      });
      this.highlightWord(t);
    }
  }

  /** Left-click and key times of the scene, sorted; built once per scene. */
  private eventTimes(scene: Scene) {
    if (this.times?.scene !== scene) this.times = { scene, clicks: leftClicks(scene), keys: scene.keys.map((key) => key.t) };
    return this.times;
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
