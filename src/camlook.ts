/**
 * The webcam card's panel: how the camera looks in new recordings (background, light, color,
 * mirror), shown live on the camera before recording. The look is saved, and each new
 * recording's project starts with it; the editor's Webcam tab changes it per recording.
 */

import { WebcamMatte, type Matte } from "./editor/matte";
import { loadWebcamLook, lookText, NEUTRAL_LOOK, saveWebcamLook, WEBCAM_BACKGROUNDS, type WebcamLook } from "./editor/project";
import { webcamGrade } from "./editor/renderer";

const BACKGROUND_NAMES: Record<WebcamLook["background"], string> = { original: "Original", blur: "Desfocar", remove: "Remover" };
/** Width the preview is worked at; its height follows the camera. */
const STAGE_WIDTH = 320;

type Options = {
  /** The card the panel opens under. */
  anchor: HTMLElement;
  /** The live camera preview the panel draws from. */
  video: HTMLVideoElement;
  /** The camera in use, and how many there are. */
  camera: () => { name: string; devices: number };
  /** Opens the camera menu under `anchor`. */
  pickCamera: (anchor: HTMLElement) => void;
};

export class CamLook {
  look = loadWebcamLook();
  private panel: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private frame = 0;
  private grade = webcamGrade(this.look.light, this.look.warmth);
  private matte: WebcamMatte | null = null;
  private latest: { mask: Uint8Array; width: number; height: number; blurred: Uint8ClampedArray | null } | null = null;
  private backdrop: Uint8ClampedArray | null = null;
  private scratch = document.createElement("canvas");

  constructor(private options: Options) {
    this.showBadge();
  }

  get isOpen() {
    return this.panel !== null;
  }

  toggle() {
    if (this.panel) this.close();
    else this.open();
  }

  open() {
    if (this.panel) return;
    const panel = document.createElement("div");
    panel.className = "cam-look";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Ajustes da webcam");

    const stage = document.createElement("div");
    stage.className = "cam-look-stage";
    this.canvas = document.createElement("canvas");
    stage.append(this.canvas);
    panel.append(stage);

    const { name, devices } = this.options.camera();
    if (devices > 1) {
      const device = document.createElement("button");
      device.className = "cam-look-device";
      device.innerHTML = `<svg class="i"><use href="#i-camera" /></svg><span></span><svg class="i device-chevron"><use href="#i-chevron" /></svg>`;
      device.querySelector("span")!.textContent = name;
      device.title = "Trocar a webcam";
      device.addEventListener("click", () => this.options.pickCamera(device));
      panel.append(device);
    }

    const background = document.createElement("div");
    background.className = "field";
    background.innerHTML = `<span>Fundo</span><div class="segmented small" role="radiogroup" aria-label="Fundo da webcam"></div>`;
    const choices = background.querySelector(".segmented")!;
    for (const value of WEBCAM_BACKGROUNDS) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "cam-look-background";
      input.value = value;
      input.checked = this.look.background === value;
      input.addEventListener("change", () => this.change({ background: value }));
      label.append(input, BACKGROUND_NAMES[value]);
      choices.append(label);
    }
    panel.append(background);

    panel.append(this.slider("light", "Luz"), this.slider("warmth", "Cor"));

    const mirror = document.createElement("label");
    mirror.className = "switch";
    mirror.innerHTML = `<input type="checkbox" /><span>Espelhar</span>`;
    const mirrorInput = mirror.querySelector("input")!;
    mirrorInput.checked = this.look.mirror;
    mirrorInput.addEventListener("change", () => this.change({ mirror: mirrorInput.checked }));
    panel.append(mirror);

    const foot = document.createElement("div");
    foot.className = "cam-look-foot";
    foot.innerHTML = `<p class="hint">Vale para as próximas gravações. No editor, a aba Webcam muda cada gravação.</p>`;
    const reset = document.createElement("button");
    reset.className = "link-button";
    reset.textContent = "Restaurar";
    reset.addEventListener("click", () => {
      this.change({ ...NEUTRAL_LOOK });
      this.close();
      this.open();
    });
    foot.append(reset);
    panel.append(foot);

    document.body.append(panel);
    this.panel = panel;
    this.options.anchor.setAttribute("aria-expanded", "true");
    this.place();
    document.addEventListener("pointerdown", this.onOutside, true);
    document.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.place);
    this.frame = requestAnimationFrame(this.draw);
    if (this.look.background !== "original") this.startMatte();
  }

  close() {
    if (!this.panel) return;
    cancelAnimationFrame(this.frame);
    this.panel.remove();
    this.panel = null;
    this.canvas = null;
    this.options.anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.onOutside, true);
    document.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.place);
    this.stopMatte();
  }

  /** The camera list changed: the camera row shows the new one. */
  refresh() {
    if (!this.panel) return;
    const name = this.panel.querySelector(".cam-look-device span");
    if (name) name.textContent = this.options.camera().name;
  }

  private slider(key: "light" | "warmth", title: string) {
    const label = document.createElement("label");
    label.className = "slider";
    label.innerHTML = `<span>${title} <output></output></span><input type="range" min="-1" max="1" step="0.05" />`;
    const input = label.querySelector("input")!;
    const output = label.querySelector("output")!;
    const show = () => {
      output.textContent = lookText(key, Number(input.value));
      input.style.setProperty("--fill", `${((Number(input.value) + 1) / 2) * 100}%`);
    };
    input.value = String(this.look[key]);
    show();
    input.addEventListener("input", () => {
      show();
      this.change({ [key]: Number(input.value) });
    });
    // A double click puts it back to the middle.
    input.addEventListener("dblclick", () => {
      input.value = "0";
      show();
      this.change({ [key]: 0 });
    });
    return label;
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
    this.options.video.style.transform = this.look.mirror ? "scaleX(-1)" : "none";
  }

  private place = () => {
    const panel = this.panel;
    if (!panel) return;
    const card = this.options.anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(8, Math.min(card.left, window.innerWidth - width - 8));
    // Under the card, or above it when there is no room below.
    const below = card.bottom + 6;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, card.top - 6 - height);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  private onOutside = (event: PointerEvent) => {
    const target = event.target as Element;
    // Clicks on the card toggle it; the camera menu opens from the panel.
    if (this.panel?.contains(target) || this.options.anchor.contains(target) || target.closest(".context-menu")) return;
    this.close();
  };

  private onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || document.querySelector(".context-menu")) return;
    event.preventDefault();
    this.close();
    this.options.anchor.focus();
  };

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
  private requestMatte(video: HTMLVideoElement, width: number, height: number) {
    const matte = this.matte;
    if (!matte || matte.busy) return;
    const blur = this.look.background === "blur";
    matte
      .segment(video, video.currentTime * 1000, blur)
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
    const video = this.options.video;
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
    const image = context.getImageData(0, 0, width, height);
    const pixels = image.data;
    const [red, green, blue] = this.grade;

    const background = this.look.background;
    if (background !== "original") this.requestMatte(video, width, height);
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
