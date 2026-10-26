/**
 * Editing straight on the preview: the webcam bubble and the texts, arrows and highlights can be
 * dragged to move them, and resized from the handle at their bottom-right corner. Boxes are in
 * output pixels; the preview canvas shows the output scaled to fit.
 */

import type { Rect } from "./project";

export type DirectTarget = { kind: "webcam" | "note"; id: string; box: Rect; round?: boolean };

type Events = {
  /** A note was pressed (to select it before dragging). */
  select(target: DirectTarget): void;
  /** The target moved or was resized to `box`; `done` on release. */
  change(target: DirectTarget, box: Rect, done: boolean): void;
};

/** Size of the resize handle's grab area, in CSS pixels. */
const HANDLE = 14;
/** Smallest size a target can be resized to, in output pixels. */
const MIN_SIZE = 24;

export class DirectEdit {
  private targets: DirectTarget[] = [];
  private selected: string | null = null;
  private output = { width: 1, height: 1 };
  private drag: { target: DirectTarget; mode: "move" | "resize"; x: number; y: number; origin: Rect } | null = null;
  private outline: HTMLElement;
  private enabled = true;
  /** Under the pointer, outlined so it is clear it can be dragged. */
  private hovered: string | null = null;

  constructor(private canvas: HTMLCanvasElement, private events: Events) {
    this.outline = document.createElement("div");
    this.outline.className = "direct-box";
    this.outline.hidden = true;
    this.outline.innerHTML = '<span class="direct-handle"></span>';
    canvas.parentElement!.append(this.outline);
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
    canvas.addEventListener("pointerleave", () => {
      if (this.drag) return;
      this.hovered = null;
      this.showOutline(this.current());
    });
  }

  /** What can be edited in the frame now, and which note is selected. Call with each rendered frame. */
  update(output: { width: number; height: number }, targets: DirectTarget[], selected: string | null, enabled: boolean) {
    this.output = output;
    this.enabled = enabled;
    this.selected = selected;
    // Keep the target being dragged, even if the frame no longer lists it.
    this.targets = this.drag ? targets.map((target) => (target.id === this.drag!.target.id ? { ...target, box: this.drag!.target.box } : target)) : targets;
    this.showOutline(this.current());
  }

  /** The target to outline: the one dragged, else under the pointer, else the selected note. */
  private current() {
    const id = this.drag?.target.id ?? this.hovered ?? this.selected;
    return this.targets.find((target) => target.id === id) ?? null;
  }

  get dragging() {
    return this.drag !== null;
  }

  /** CSS pixels per output pixel. */
  private get scale() {
    return this.canvas.clientWidth / this.output.width;
  }

  private toOutput(event: PointerEvent) {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / this.scale, y: (event.clientY - bounds.top) / this.scale };
  }

  private hit(point: { x: number; y: number }): { target: DirectTarget; mode: "move" | "resize" } | null {
    const grab = HANDLE / this.scale;
    // Topmost first: the webcam is drawn over the notes' layer only in output space, so check it last
    // unless a note is selected.
    const ordered = [...this.targets].sort((a, b) => Number(b.id === this.selected) - Number(a.id === this.selected));
    for (const target of ordered) {
      const { x, y, width, height } = target.box;
      // On a circle the handle sits on the rim, at the bottom-right.
      const corner = target.round ? { x: x + width * 0.854, y: y + height * 0.854 } : { x: x + width, y: y + height };
      if (Math.abs(point.x - corner.x) <= grab && Math.abs(point.y - corner.y) <= grab) return { target, mode: "resize" };
      const inside = target.round
        ? Math.hypot(point.x - (x + width / 2), point.y - (y + height / 2)) <= width / 2
        : point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
      if (inside) return { target, mode: "move" };
    }
    return null;
  }

  private pointerDown(event: PointerEvent) {
    if (!this.enabled || event.button !== 0) return;
    const point = this.toOutput(event);
    const hit = this.hit(point);
    if (!hit) return;
    event.preventDefault();
    if (hit.target.kind === "note") this.events.select(hit.target);
    this.drag = { target: { ...hit.target }, mode: hit.mode, x: point.x, y: point.y, origin: { ...hit.target.box } };
    this.canvas.setPointerCapture(event.pointerId);
  }

  private pointerMove(event: PointerEvent) {
    const point = this.toOutput(event);
    if (!this.drag) {
      const hit = this.enabled ? this.hit(point) : null;
      this.canvas.style.cursor = hit ? (hit.mode === "resize" ? "nwse-resize" : "move") : "";
      if ((hit?.target.id ?? null) !== this.hovered) {
        this.hovered = hit?.target.id ?? null;
        this.showOutline(this.current());
      }
      this.canvas.title = hit ? (hit.target.kind === "webcam" ? "Arraste para mover a webcam; o canto muda o tamanho" : "Arraste para mover; o canto muda o tamanho") : "";
      return;
    }
    const drag = this.drag;
    const dx = point.x - drag.x;
    const dy = point.y - drag.y;
    const { origin } = drag;
    let box: Rect;
    if (drag.mode === "move") {
      box = {
        ...origin,
        x: Math.min(Math.max(origin.x + dx, 0), this.output.width - origin.width),
        y: Math.min(Math.max(origin.y + dy, 0), this.output.height - origin.height),
      };
    } else if (drag.target.round || drag.target.kind === "webcam") {
      // Square shapes stay square.
      const size = Math.max(MIN_SIZE, Math.min(origin.width + Math.max(dx, dy), this.output.width - origin.x, this.output.height - origin.y));
      box = { ...origin, width: size, height: size };
    } else {
      box = {
        ...origin,
        width: Math.max(MIN_SIZE, Math.min(origin.width + dx, this.output.width - origin.x)),
        height: Math.max(MIN_SIZE, Math.min(origin.height + dy, this.output.height - origin.y)),
      };
    }
    drag.target.box = box;
    this.showOutline(drag.target);
    this.events.change(drag.target, box, false);
  }

  private pointerUp(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.events.change(drag.target, drag.target.box, true);
  }

  private showOutline(target: DirectTarget | null) {
    const outline = this.outline;
    if (!target || !this.enabled) {
      outline.hidden = true;
      return;
    }
    const scale = this.scale;
    const { x, y, width, height } = target.box;
    outline.hidden = false;
    outline.classList.toggle("round", Boolean(target.round));
    outline.style.transform = `translate(${x * scale + this.canvas.offsetLeft}px, ${y * scale + this.canvas.offsetTop}px)`;
    outline.style.width = `${width * scale}px`;
    outline.style.height = `${height * scale}px`;
  }
}
