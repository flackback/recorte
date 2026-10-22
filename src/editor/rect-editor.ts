import type { Rect } from "./project";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MIN = 24;

type Options = {
  title: string;
  video: { width: number; height: number };
  rect: Rect;
  /** Shows "Vídeo inteiro", which applies null. */
  allowReset: boolean;
  onApply: (rect: Rect | null) => void;
  onClose: () => void;
};

/**
 * Drag a rectangle over the preview while it shows the whole recording: used to crop and to place
 * blurred areas. Works in video pixels; the preview canvas shows the full frame meanwhile.
 */
export class RectEditor {
  private ui = {
    layer: $("rect-editor"),
    box: $("rect-box"),
    toolbar: $("rect-toolbar"),
    title: $("rect-title"),
    reset: $<HTMLButtonElement>("rect-reset"),
    cancel: $<HTMLButtonElement>("rect-cancel"),
    apply: $<HTMLButtonElement>("rect-apply"),
  };
  private options: Options | null = null;
  private rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private drag: { mode: string; startX: number; startY: number; origin: Rect } | null = null;

  constructor() {
    const ui = this.ui;
    ui.layer.addEventListener("pointerdown", (event) => this.pointerDown(event));
    ui.layer.addEventListener("pointermove", (event) => this.pointerMove(event));
    ui.layer.addEventListener("pointerup", () => (this.drag = null));
    ui.cancel.addEventListener("click", () => this.close());
    ui.reset.addEventListener("click", () => {
      this.options?.onApply(null);
      this.close();
    });
    ui.apply.addEventListener("click", () => {
      this.options?.onApply({ ...this.rect });
      this.close();
    });
    window.addEventListener("keydown", (event) => {
      if (!this.options) return;
      if (event.key === "Escape") this.close();
      if (event.key === "Enter") ui.apply.click();
    });
    new ResizeObserver(() => this.place()).observe(ui.layer);
  }

  get isOpen() {
    return this.options !== null;
  }

  open(options: Options) {
    this.options = options;
    this.rect = { ...options.rect };
    this.ui.title.textContent = options.title;
    this.ui.reset.hidden = !options.allowReset;
    this.ui.layer.hidden = false;
    this.ui.toolbar.hidden = false;
    this.place();
    this.ui.apply.focus();
  }

  close() {
    const options = this.options;
    this.options = null;
    this.drag = null;
    this.ui.layer.hidden = true;
    this.ui.toolbar.hidden = true;
    options?.onClose();
  }

  /** Video pixels per CSS pixel of the layer. */
  private get scale() {
    const video = this.options?.video ?? { width: 1, height: 1 };
    return video.width / Math.max(1, this.ui.layer.clientWidth);
  }

  private place() {
    if (!this.options) return;
    const s = this.scale;
    const box = this.ui.box.style;
    box.left = `${this.rect.x / s}px`;
    box.top = `${this.rect.y / s}px`;
    box.width = `${this.rect.width / s}px`;
    box.height = `${this.rect.height / s}px`;
  }

  private pointerDown(event: PointerEvent) {
    if (!this.options) return;
    const target = event.target as HTMLElement;
    const mode = target.dataset.handle ?? (target === this.ui.box ? "move" : "draw");
    const s = this.scale;
    const layerRect = this.ui.layer.getBoundingClientRect();
    const px = (event.clientX - layerRect.left) * s;
    const py = (event.clientY - layerRect.top) * s;
    if (mode === "draw") this.rect = { x: px, y: py, width: 0, height: 0 };
    this.drag = { mode, startX: px, startY: py, origin: { ...this.rect } };
    this.ui.layer.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private pointerMove(event: PointerEvent) {
    const drag = this.drag;
    const options = this.options;
    if (!drag || !options) return;
    const layerRect = this.ui.layer.getBoundingClientRect();
    const s = this.scale;
    const px = Math.min(options.video.width, Math.max(0, (event.clientX - layerRect.left) * s));
    const py = Math.min(options.video.height, Math.max(0, (event.clientY - layerRect.top) * s));
    const dx = px - drag.startX;
    const dy = py - drag.startY;
    const o = drag.origin;
    let { x, y, width, height } = o;

    if (drag.mode === "move") {
      x = Math.min(Math.max(0, o.x + dx), options.video.width - o.width);
      y = Math.min(Math.max(0, o.y + dy), options.video.height - o.height);
    } else if (drag.mode === "draw") {
      x = Math.min(drag.startX, px);
      y = Math.min(drag.startY, py);
      width = Math.abs(px - drag.startX);
      height = Math.abs(py - drag.startY);
    } else {
      const left = drag.mode.includes("w") ? Math.min(o.x + dx, o.x + o.width - MIN) : o.x;
      const top = drag.mode.includes("n") ? Math.min(o.y + dy, o.y + o.height - MIN) : o.y;
      const right = drag.mode.includes("e") ? Math.max(o.x + o.width + dx, o.x + MIN) : o.x + o.width;
      const bottom = drag.mode.includes("s") ? Math.max(o.y + o.height + dy, o.y + MIN) : o.y + o.height;
      x = Math.max(0, left);
      y = Math.max(0, top);
      width = Math.min(options.video.width, right) - x;
      height = Math.min(options.video.height, bottom) - y;
    }
    // Even sizes keep the encoder happy when the crop becomes the output.
    this.rect = { x: Math.round(x), y: Math.round(y), width: Math.max(MIN, Math.round(width / 2) * 2), height: Math.max(MIN, Math.round(height / 2) * 2) };
    this.place();
  }
}
