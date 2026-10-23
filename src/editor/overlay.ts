import { BACKGROUNDS, type Note, type Project } from "./project";
import type { CardView, OverlayContent } from "./composition";

type Text = OverlayContent;

const FONT = "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif";

/**
 * Draws notes (text, arrows, highlight boxes), the keys badge and captions into a canvas the size
 * of the output frame. Redraws only when something changes; the renderer uploads the canvas only
 * then. The preview can ask for fewer pixels: drawing stays in output units, scaled down.
 */
export class OverlayPainter {
  readonly canvas: OffscreenCanvas;
  private context: OffscreenCanvasRenderingContext2D;
  private lastKey = "";
  /** The output frame the overlay is laid out in; the canvas is this times `scale`. */
  private size: { width: number; height: number };
  visible = false;

  constructor(width: number, height: number) {
    this.canvas = new OffscreenCanvas(width, height);
    this.context = this.canvas.getContext("2d")!;
    this.size = { width, height };
  }

  /** Returns true when the canvas changed and must be uploaded again. */
  paint(text: Text, project: Project, card: CardView | null = null): boolean {
    const notes = text.notes.map(({ note, opacity }) => [note.kind, note.x, note.y, note.width, note.height, note.text, note.color, note.size, note.direction, Math.round(opacity * 20)]);
    const cardKey = card && [card.card.title, card.card.subtitle, Math.round(card.opacity * 30), project.background.preset];
    const key = JSON.stringify([text.keys, text.caption?.words.map((word) => word.i), text.caption?.current, project.captions, notes, cardKey, this.canvas.width, this.canvas.height]);
    if (key === this.lastKey) return false;
    this.lastKey = key;

    const { context } = this;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.setTransform(this.canvas.width / this.size.width, 0, 0, this.canvas.height / this.size.height, 0, 0);
    // Shadow blur ignores the transform, so it is scaled by hand.
    const blur = this.canvas.width / this.size.width;
    const canvas = this.size;
    const short = Math.min(canvas.width, canvas.height);
    this.visible = Boolean(text.keys || text.caption || text.notes.length || (card && card.opacity > 0));

    for (const { note, opacity } of text.notes) {
      context.save();
      context.globalAlpha = opacity;
      drawNote(context, note, canvas.width, canvas.height, blur);
      context.restore();
    }

    if (text.caption) {
      const size = Math.round(short * 0.042 * project.captions.size);
      context.font = `600 ${size}px ${FONT}`;
      context.textBaseline = "middle";
      const words = text.caption.words.map((word) => word.text.trim());
      const space = context.measureText(" ").width;
      const widths = words.map((word) => context.measureText(word).width);
      const total = widths.reduce((sum, width) => sum + width, 0) + space * (words.length - 1);
      const padX = size * 0.6;
      const padY = size * 0.38;
      const boxWidth = Math.min(canvas.width * 0.92, total + padX * 2);
      const boxHeight = size + padY * 2;
      const x = (canvas.width - boxWidth) / 2;
      const y = project.captions.position === "top" ? short * 0.06 : canvas.height - short * 0.06 - boxHeight - (text.keys ? size * 2 : 0);
      context.fillStyle = "rgba(10, 10, 12, 0.72)";
      context.beginPath();
      context.roundRect(x, y, boxWidth, boxHeight, size * 0.35);
      context.fill();
      let cursor = (canvas.width - total) / 2;
      words.forEach((word, index) => {
        context.fillStyle = index === text.caption!.current ? "#ffd60a" : "#ffffff";
        context.fillText(word, cursor, y + boxHeight / 2);
        cursor += widths[index] + space;
      });
    }

    if (text.keys) {
      const size = Math.round(short * 0.032);
      context.font = `600 ${size}px ${FONT}`;
      context.textBaseline = "middle";
      const width = context.measureText(text.keys).width;
      const padX = size * 0.7;
      const boxWidth = Math.min(canvas.width * 0.9, width + padX * 2);
      const boxHeight = size * 1.9;
      const x = (canvas.width - boxWidth) / 2;
      const y = canvas.height - short * 0.05 - boxHeight;
      context.fillStyle = "rgba(10, 10, 12, 0.78)";
      context.beginPath();
      context.roundRect(x, y, boxWidth, boxHeight, boxHeight / 2);
      context.fill();
      context.strokeStyle = "rgba(255, 255, 255, 0.14)";
      context.lineWidth = Math.max(1, size * 0.05);
      context.stroke();
      context.fillStyle = "#ffffff";
      context.textAlign = "center";
      context.fillText(text.keys, canvas.width / 2, y + boxHeight / 2, boxWidth - padX * 2);
      context.textAlign = "start";
    }

    if (card && card.opacity > 0) {
      context.save();
      context.globalAlpha = card.opacity;
      drawCard(context, card.card, project, canvas.width, canvas.height, blur);
      context.restore();
    }
    return true;
  }

  /** Lays the overlay out in a `width` × `height` frame, drawn at `scale` times that many pixels. */
  resize(width: number, height: number, scale = 1) {
    const pixels = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
    if (this.size.width === width && this.size.height === height && this.canvas.width === pixels.width && this.canvas.height === pixels.height) return;
    this.size = { width, height };
    this.canvas.width = pixels.width;
    this.canvas.height = pixels.height;
    this.lastKey = "";
  }
}

/** One note, in a frame of `width` × `height` pixels; `blur` scales the shadow to the canvas. */
function drawNote(context: OffscreenCanvasRenderingContext2D, note: Note, width: number, height: number, blur = 1) {
  const short = Math.min(width, height);
  const x = note.x * width;
  const y = note.y * height;
  const w = note.width * width;
  const h = note.height * height;
  context.shadowColor = "rgba(0, 0, 0, 0.45)";
  context.shadowBlur = short * 0.012 * blur;

  if (note.kind === "box") {
    const line = Math.max(3, short * 0.006 * note.size);
    context.strokeStyle = note.color;
    context.lineWidth = line;
    context.beginPath();
    context.roundRect(x, y, w, h, Math.min(w, h) * 0.12);
    context.stroke();
    return;
  }

  if (note.kind === "arrow") {
    const line = Math.max(4, short * 0.008 * note.size);
    const fromLeft = note.direction === "se" || note.direction === "ne";
    const fromTop = note.direction === "se" || note.direction === "sw";
    const from = { x: fromLeft ? x : x + w, y: fromTop ? y : y + h };
    const to = { x: fromLeft ? x + w : x, y: fromTop ? y + h : y };
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = line * 3.6;
    // The shaft stops where the head starts, so the tip stays sharp.
    const neck = { x: to.x - Math.cos(angle) * head * 0.8, y: to.y - Math.sin(angle) * head * 0.8 };
    context.strokeStyle = note.color;
    context.fillStyle = note.color;
    context.lineWidth = line;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(neck.x, neck.y);
    context.stroke();
    context.beginPath();
    context.moveTo(to.x, to.y);
    context.lineTo(to.x - Math.cos(angle - 0.45) * head, to.y - Math.sin(angle - 0.45) * head);
    context.lineTo(to.x - Math.cos(angle + 0.45) * head, to.y - Math.sin(angle + 0.45) * head);
    context.closePath();
    context.fill();
    return;
  }

  // Text: a dark pill sized to the text, centered in the note's box, one line per line break.
  const lines = (note.text || " ").split("\n");
  let size = Math.round(short * 0.05 * note.size);
  context.font = `700 ${size}px ${FONT}`;
  const widest = Math.max(...lines.map((line) => context.measureText(line).width));
  // Shrinks to fit the box width.
  if (widest > w * 0.92) {
    size = Math.max(10, Math.floor((size * w * 0.92) / widest));
    context.font = `700 ${size}px ${FONT}`;
  }
  const lineHeight = size * 1.2;
  const textWidth = Math.max(...lines.map((line) => context.measureText(line).width));
  const padX = size * 0.6;
  const padY = size * 0.35;
  const boxWidth = textWidth + padX * 2;
  const boxHeight = lineHeight * lines.length + padY * 2;
  const left = x + (w - boxWidth) / 2;
  const top = y + (h - boxHeight) / 2;
  context.fillStyle = "rgba(10, 10, 12, 0.78)";
  context.beginPath();
  context.roundRect(left, top, boxWidth, boxHeight, size * 0.35);
  context.fill();
  context.shadowColor = "transparent";
  context.fillStyle = note.color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  lines.forEach((line, index) => context.fillText(line, x + w / 2, top + padY + lineHeight * (index + 0.5)));
  context.textAlign = "start";
}

/** A full-frame title screen on the style's gradient. */
function drawCard(context: OffscreenCanvasRenderingContext2D, card: CardView["card"], project: Project, width: number, height: number, blur = 1) {
  const preset = BACKGROUNDS.find((background) => background.id === project.background.preset) ?? BACKGROUNDS[0];
  const angle = (preset.angle * Math.PI) / 180;
  const reach = (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height) / 2;
  const gradient = context.createLinearGradient(width / 2 - Math.cos(angle) * reach, height / 2 - Math.sin(angle) * reach, width / 2 + Math.cos(angle) * reach, height / 2 + Math.sin(angle) * reach);
  gradient.addColorStop(0, preset.from);
  gradient.addColorStop(1, preset.to);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  // Light text on dark backgrounds, dark text on light ones.
  const light = luminance(preset.from) + luminance(preset.to) > 1.2;
  const short = Math.min(width, height);
  const title = card.title.trim();
  const subtitle = card.subtitle.trim();
  let titleSize = Math.round(short * 0.085);
  context.font = `700 ${titleSize}px ${FONT}`;
  const titleWidth = context.measureText(title).width;
  if (titleWidth > width * 0.86) {
    titleSize = Math.floor((titleSize * width * 0.86) / titleWidth);
    context.font = `700 ${titleSize}px ${FONT}`;
  }
  const subtitleSize = Math.round(short * 0.04);
  const gap = subtitle && title ? subtitleSize * 0.9 : 0;
  const blockHeight = (title ? titleSize : 0) + gap + (subtitle ? subtitleSize : 0);
  let y = (height - blockHeight) / 2;
  context.textAlign = "center";
  context.textBaseline = "top";
  context.shadowColor = light ? "transparent" : "rgba(0, 0, 0, 0.25)";
  context.shadowBlur = short * 0.02 * blur;
  if (title) {
    context.fillStyle = light ? "#111114" : "#ffffff";
    context.fillText(title, width / 2, y, width * 0.9);
    y += titleSize + gap;
  }
  if (subtitle) {
    context.font = `500 ${subtitleSize}px ${FONT}`;
    context.fillStyle = light ? "rgba(17, 17, 20, 0.7)" : "rgba(255, 255, 255, 0.82)";
    context.fillText(subtitle, width / 2, y, width * 0.9);
  }
  context.textAlign = "start";
  context.textBaseline = "alphabetic";
}

/** 0 (black) to 1 (white). */
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
