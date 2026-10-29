/**
 * Panels that open beside the source cards before recording: the webcam's look (background,
 * light, color, mirror) shown live, and the microphone's and the system sound's level, volume
 * and voice enhancement. The choices are saved, and each new recording's project starts with
 * them; the editor changes them per recording.
 */

import { WebcamMatte, type Matte } from "./editor/matte";
import {
  loadSoundLook,
  loadWebcamLook,
  lookText,
  NEUTRAL_LOOK,
  NEUTRAL_SOUND,
  saveSoundLook,
  saveWebcamLook,
  WEBCAM_BACKGROUNDS,
  type EnhanceLevel,
  type SoundLook,
  type WebcamLook,
} from "./editor/project";
import { webcamGrade } from "./editor/renderer";

const BACKGROUND_NAMES: Record<WebcamLook["background"], string> = { original: "Original", blur: "Desfocar", remove: "Remover" };
const ENHANCE_NAMES: Record<EnhanceLevel, string> = { light: "Leve", medium: "Média", strong: "Forte" };
/** Width the camera preview is worked at; its height follows the camera. */
const STAGE_WIDTH = 320;

/** The device a card records, and how many there are to pick from. */
type Device = () => { name: string; devices: number };

/** Only one panel is open at a time. */
let current: CardPanel | null = null;

abstract class CardPanel {
  protected panel: HTMLElement | null = null;

  constructor(
    protected anchor: HTMLElement,
    private title: string,
  ) {}

  get isOpen() {
    return this.panel !== null;
  }

  toggle() {
    if (this.panel) this.close();
    else this.open();
  }

  open() {
    if (this.panel) return;
    current?.close();
    current = this;
    const panel = document.createElement("div");
    panel.className = "card-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", this.title);
    this.panel = panel;
    this.build(panel);
    document.body.append(panel);
    this.anchor.setAttribute("aria-expanded", "true");
    this.place();
    document.addEventListener("pointerdown", this.onOutside, true);
    document.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.place);
    this.opened();
  }

  close() {
    if (!this.panel) return;
    this.closed();
    this.panel.remove();
    this.panel = null;
    if (current === this) current = null;
    this.anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.onOutside, true);
    document.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.place);
  }

  /** Builds the panel again, with the saved values. */
  protected rebuild() {
    const panel = this.panel;
    if (!panel) return;
    this.closed();
    panel.replaceChildren();
    this.build(panel);
    this.place();
    this.opened();
  }

  /** The device list changed: the device row shows the one in use. */
  refresh(device: Device) {
    const name = this.panel?.querySelector(".card-panel-device span");
    if (name) name.textContent = device().name;
  }

  protected abstract build(panel: HTMLElement): void;
  protected opened() {}
  protected closed() {}

  /** A row that opens the device menu, when there is more than one device. */
  protected deviceRow(device: Device, icon: string, title: string, pick: (anchor: HTMLElement) => void) {
    const { name, devices } = device();
    if (devices < 2) return null;
    const row = document.createElement("button");
    row.className = "card-panel-device";
    row.innerHTML = `<svg class="i"><use href="#${icon}" /></svg><span></span><svg class="i device-chevron"><use href="#i-chevron" /></svg>`;
    row.querySelector("span")!.textContent = name;
    row.title = title;
    row.addEventListener("click", () => pick(row));
    return row;
  }

  protected choice<T extends string>(title: string, values: T[], names: Record<T, string>, value: T, change: (value: T) => void) {
    const field = document.createElement("div");
    field.className = "field";
    field.innerHTML = `<span></span><div class="segmented small" role="radiogroup"></div>`;
    field.querySelector("span")!.textContent = title;
    const group = field.querySelector(".segmented")!;
    group.setAttribute("aria-label", title);
    const name = `card-panel-${Math.random().toString(36).slice(2)}`;
    for (const option of values) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = name;
      input.value = option;
      input.checked = option === value;
      input.addEventListener("change", () => change(option));
      label.append(input, names[option]);
      group.append(label);
    }
    return field;
  }

  /** A slider; a double click puts it back to `neutral`. */
  protected slider(title: string, range: { min: number; max: number; step: number; neutral: number }, value: number, text: (value: number) => string, change: (value: number) => void) {
    const label = document.createElement("label");
    label.className = "slider";
    label.innerHTML = `<span><span></span> <output></output></span><input type="range" />`;
    label.querySelector("span > span")!.textContent = title;
    const input = label.querySelector("input")!;
    const output = label.querySelector("output")!;
    Object.assign(input, { min: String(range.min), max: String(range.max), step: String(range.step), value: String(value) });
    const show = () => {
      output.textContent = text(Number(input.value));
      input.style.setProperty("--fill", `${((Number(input.value) - range.min) / (range.max - range.min)) * 100}%`);
    };
    show();
    input.addEventListener("input", () => {
      show();
      change(Number(input.value));
    });
    input.addEventListener("dblclick", () => {
      input.value = String(range.neutral);
      show();
      change(range.neutral);
    });
    return label;
  }

  protected toggleRow(title: string, checked: boolean, change: (checked: boolean) => void) {
    const label = document.createElement("label");
    label.className = "switch";
    label.innerHTML = `<input type="checkbox" /><span></span>`;
    label.querySelector("span")!.textContent = title;
    const input = label.querySelector("input")!;
    input.checked = checked;
    input.addEventListener("change", () => change(input.checked));
    return label;
  }

  /** A large level bar, filled by the app's level polling like the card's. */
  protected meterRow(label: string, hint: string) {
    const box = document.createElement("div");
    box.className = "card-panel-meter";
    box.innerHTML = `<span class="meter"><span class="meter-track"><span class="meter-cover"></span></span></span><p class="hint"></p>`;
    box.querySelector<HTMLElement>(".meter")!.dataset.label = label;
    box.querySelector("p")!.textContent = hint;
    return box;
  }

  /** The level bar while the panel is open. */
  get meter() {
    return this.panel?.querySelector<HTMLElement>(".card-panel-meter .meter") ?? null;
  }

  protected foot(reset: () => void) {
    const foot = document.createElement("div");
    foot.className = "card-panel-foot";
    foot.innerHTML = `<p class="hint">Vale para as próximas gravações. No editor, você muda cada gravação.</p>`;
    const button = document.createElement("button");
    button.className = "link-button";
    button.textContent = "Restaurar";
    button.addEventListener("click", () => {
      reset();
      this.rebuild();
    });
    foot.append(button);
    return foot;
  }

  protected place = () => {
    const panel = this.panel;
    if (!panel) return;
    const card = this.anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    // Beside the panel the card is in, level with the card and kept on screen; under it when the
    // window is too narrow.
    const side = this.anchor.closest(".sidebar")?.getBoundingClientRect().right ?? card.right;
    const beside = side + 8 + width <= window.innerWidth - 8;
    const left = beside ? side + 8 : Math.max(8, Math.min(card.left, window.innerWidth - width - 8));
    const wanted = beside ? card.top : card.bottom + 6;
    const top = Math.max(8, Math.min(wanted, window.innerHeight - height - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  private onOutside = (event: PointerEvent) => {
    const target = event.target as Element;
    // Clicks on the card toggle it; the device menu opens from the panel.
    if (this.panel?.contains(target) || this.anchor.contains(target) || target.closest(".context-menu")) return;
    this.close();
  };

  private onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || document.querySelector(".context-menu")) return;
    event.preventDefault();
    this.close();
    this.anchor.focus();
  };
}

// ---------- sound ----------

/** Volumes and voice enhancement, shared by the microphone's and the system sound's panels. */
let sound: SoundLook = loadSoundLook();

function changeSound(patch: Partial<SoundLook>) {
  sound = { ...sound, ...patch };
  saveSoundLook(sound);
}

const VOLUME = { min: 0, max: 2, step: 0.05, neutral: 1 };
const percent = (value: number) => `${Math.round(value * 100)}%`;

export class MicPanel extends CardPanel {
  constructor(
    anchor: HTMLElement,
    private device: Device,
    private pick: (anchor: HTMLElement) => void,
  ) {
    super(anchor, "Ajustes do microfone");
  }

  protected build(panel: HTMLElement) {
    const row = this.deviceRow(this.device, "i-mic", "Trocar o microfone", this.pick);
    if (row) panel.append(row);
    panel.append(this.meterRow("Microfone", "Fale como na gravação: a barra deve passar do meio sem chegar ao vermelho."));
    panel.append(this.slider("Volume", VOLUME, sound.mic, percent, (mic) => changeSound({ mic })));
    const level = this.choice("Intensidade", ["light", "medium", "strong"] as EnhanceLevel[], ENHANCE_NAMES, sound.enhanceLevel, (enhanceLevel) => changeSound({ enhanceLevel }));
    level.hidden = !sound.enhance;
    panel.append(
      this.toggleRow("Melhorar a voz (tirar ruído)", sound.enhance, (enhance) => {
        changeSound({ enhance });
        level.hidden = !enhance;
        // Taller or shorter now: kept on screen.
        this.place();
      }),
      level,
    );
    panel.append(this.foot(() => changeSound({ mic: NEUTRAL_SOUND.mic, enhance: NEUTRAL_SOUND.enhance, enhanceLevel: NEUTRAL_SOUND.enhanceLevel })));
  }
}

export class SoundPanel extends CardPanel {
  constructor(anchor: HTMLElement) {
    super(anchor, "Ajustes do som do sistema");
  }

  protected build(panel: HTMLElement) {
    panel.append(this.meterRow("Som do sistema", "Toque um vídeo ou uma música no computador para ver o nível."));
    panel.append(this.slider("Volume", VOLUME, sound.system, percent, (system) => changeSound({ system })));
    panel.append(this.foot(() => changeSound({ system: NEUTRAL_SOUND.system })));
  }
}

// ---------- recording options ----------

/** The recording options (keys, cursor, countdown, zoom, fps): their controls move into the panel while it is open. */
export class OptionsPanel extends CardPanel {
  private home: HTMLElement | null = null;

  constructor(
    anchor: HTMLElement,
    private body: HTMLElement,
  ) {
    super(anchor, "Opções da gravação");
  }

  protected build(panel: HTMLElement) {
    this.home ??= this.body.parentElement;
    this.body.hidden = false;
    panel.append(this.body);
  }

  protected closed() {
    this.body.hidden = true;
    this.home?.append(this.body);
  }
}

// ---------- webcam ----------

export class CamLook extends CardPanel {
  look = loadWebcamLook();
  private canvas: HTMLCanvasElement | null = null;
  private frame = 0;
  private grade = webcamGrade(this.look.light, this.look.warmth);
  private matte: WebcamMatte | null = null;
  private latest: { mask: Uint8Array; width: number; height: number; blurred: Uint8ClampedArray | null } | null = null;
  private backdrop: Uint8ClampedArray | null = null;
  private scratch = document.createElement("canvas");

  constructor(
    anchor: HTMLElement,
    /** The live camera preview the panel draws from. */
    private video: HTMLVideoElement,
    private device: Device,
    private pick: (anchor: HTMLElement) => void,
  ) {
    super(anchor, "Ajustes da webcam");
    this.showBadge();
  }

  protected build(panel: HTMLElement) {
    const stage = document.createElement("div");
    stage.className = "card-panel-stage";
    this.canvas = document.createElement("canvas");
    stage.append(this.canvas);
    panel.append(stage);
    const row = this.deviceRow(this.device, "i-camera", "Trocar a webcam", this.pick);
    if (row) panel.append(row);
    panel.append(
      this.choice("Fundo", WEBCAM_BACKGROUNDS, BACKGROUND_NAMES, this.look.background, (background) => this.change({ background })),
      this.slider("Luz", { min: -1, max: 1, step: 0.05, neutral: 0 }, this.look.light, (value) => lookText("light", value), (light) => this.change({ light })),
      this.slider("Cor", { min: -1, max: 1, step: 0.05, neutral: 0 }, this.look.warmth, (value) => lookText("warmth", value), (warmth) => this.change({ warmth })),
      this.toggleRow("Espelhar", this.look.mirror, (mirror) => this.change({ mirror })),
      this.foot(() => this.change({ ...NEUTRAL_LOOK })),
    );
  }

  protected opened() {
    this.frame = requestAnimationFrame(this.draw);
    if (this.look.background !== "original") this.startMatte();
  }

  protected closed() {
    cancelAnimationFrame(this.frame);
    this.canvas = null;
    this.stopMatte();
  }

  private change(patch: Partial<WebcamLook>) {
    const before = this.look.background;
    this.look = { ...this.look, ...patch };
    saveWebcamLook(this.look);
    this.grade = webcamGrade(this.look.light, this.look.warmth);
    this.showBadge();
    if (this.look.background !== before) {
      if (this.look.background === "original") this.stopMatte();
      else this.startMatte();
      // The blurred copy is only made for blurring.
      this.latest = null;
    }
  }

  /** The small preview in the card mirrors as the recording will. */
  private showBadge() {
    this.video.style.transform = this.look.mirror ? "scaleX(-1)" : "none";
  }

  private startMatte() {
    if (this.matte) return;
    this.matte = new WebcamMatte();
    this.matte.ready().catch(() => {
      // Without the segmenter the preview shows the camera as is.
      this.stopMatte();
    });
  }

  private stopMatte() {
    this.matte?.close();
    this.matte = null;
    this.latest = null;
  }

  /** Asks for the next matte while none is being made; the preview uses the latest one. */
  private requestMatte(width: number, height: number) {
    const matte = this.matte;
    if (!matte || matte.busy) return;
    const blur = this.look.background === "blur";
    matte
      .segment(this.video, this.video.currentTime * 1000, blur)
      .then((result: Matte) => {
        if (matte !== this.matte) {
          result.blurred?.close();
          return;
        }
        let blurred: Uint8ClampedArray | null = null;
        if (result.blurred) {
          const context = this.scratchContext(width, height);
          context.drawImage(result.blurred, 0, 0, width, height);
          blurred = context.getImageData(0, 0, width, height).data;
          result.blurred.close();
        }
        this.latest = { mask: result.mask, width: result.width, height: result.height, blurred };
      })
      .catch(() => undefined);
  }

  private scratchContext(width: number, height: number) {
    if (this.scratch.width !== width || this.scratch.height !== height) {
      this.scratch.width = width;
      this.scratch.height = height;
      this.backdrop = null;
    }
    return this.scratch.getContext("2d", { willReadFrequently: true })!;
  }

  /** What shows behind a removed background: a gradient like the video's background. */
  private backdropPixels(width: number, height: number) {
    if (this.backdrop) return this.backdrop;
    const context = this.scratchContext(width, height);
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#5b8cff");
    gradient.addColorStop(1, "#b05cf0");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    this.backdrop = context.getImageData(0, 0, width, height).data;
    return this.backdrop;
  }

  private draw = () => {
    this.frame = requestAnimationFrame(this.draw);
    const canvas = this.canvas;
    const video = this.video;
    if (!canvas || video.readyState < 2 || !video.videoWidth) return;
    const width = STAGE_WIDTH;
    const height = Math.round((STAGE_WIDTH * video.videoHeight) / video.videoWidth);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.style.transform = this.look.mirror ? "scaleX(-1)" : "none";
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(video, 0, 0, width, height);
    const background = this.look.background;
    // Nothing to change: the camera as drawn.
    if (background === "original" && this.look.light === 0 && this.look.warmth === 0) return;
    const image = context.getImageData(0, 0, width, height);
    const pixels = image.data;
    const [red, green, blue] = this.grade;
    if (background !== "original") this.requestMatte(width, height);
    const matte = background === "original" ? null : this.latest;
    const behind = !matte ? null : background === "blur" ? matte.blurred : this.backdropPixels(width, height);

    for (let y = 0, i = 0; y < height; y++) {
      const row = matte ? Math.min(matte.height - 1, Math.floor((y * matte.height) / height)) * matte.width : 0;
      for (let x = 0; x < width; x++, i += 4) {
        let r = red[pixels[i]];
        let g = green[pixels[i + 1]];
        let b = blue[pixels[i + 2]];
        if (matte && behind) {
          // The shader's smoothstep(0.25, 0.75, mask): who is the person, softly at the edge.
          const m = matte.mask[row + Math.min(matte.width - 1, Math.floor((x * matte.width) / width))] / 255;
          const k = Math.min(1, Math.max(0, (m - 0.25) / 0.5));
          const person = k * k * (3 - 2 * k);
          const graded = background === "blur";
          const br = graded ? red[behind[i]] : behind[i];
          const bg = graded ? green[behind[i + 1]] : behind[i + 1];
          const bb = graded ? blue[behind[i + 2]] : behind[i + 2];
          r = br + (r - br) * person;
          g = bg + (g - bg) * person;
          b = bb + (b - bb) * person;
        }
        pixels[i] = r;
        pixels[i + 1] = g;
        pixels[i + 2] = b;
      }
    }
    context.putImageData(image, 0, 0);
  };
}
