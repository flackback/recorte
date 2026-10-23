/**
 * Drawing on screen while recording: shared by the floating bar (which owns the choices) and the
 * transparent overlay (which draws and is captured with the screen).
 */

export type DrawTool = "mouse" | "pen" | "line" | "arrow" | "dashed" | "rect" | "ellipse" | "marker" | "text";

export type DrawConfig = { tool: DrawTool; color: string; width: number; fade: boolean };

/** `icon` is SVG markup on a 24×24 grid. */
export const DRAW_TOOLS: { id: DrawTool; name: string; key: string; icon: string }[] = [
  { id: "mouse", name: "Usar o mouse", key: "Esc", icon: '<path d="M6 3.5 18 10l-5.4 1.6L10.5 17Z" />' },
  { id: "pen", name: "Caneta", key: "P", icon: '<path d="m4 20 4-1 11-11-3-3L5 16Z" />' },
  { id: "line", name: "Linha", key: "L", icon: '<path d="M5 19 19 5" />' },
  { id: "arrow", name: "Seta", key: "A", icon: '<path d="M5 19 19 5M11 5h8v8" />' },
  { id: "dashed", name: "Seta tracejada", key: "D", icon: '<path d="M5 19l2.2-2.2M9.6 14.4l2.2-2.2M14.2 9.8l2.2-2.2M11 5h8v8" />' },
  { id: "rect", name: "Retângulo", key: "R", icon: '<rect x="4" y="6" width="16" height="12" rx="2.5" />' },
  { id: "ellipse", name: "Círculo", key: "E", icon: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5" />' },
  { id: "marker", name: "Marca-texto", key: "M", icon: '<path d="M4 20h7M14 4l6 6-9 9H7v-4Z" />' },
  { id: "text", name: "Texto", key: "T", icon: '<path d="M5 7V5h14v2M12 5v14M9 19h6" />' },
];

export const DRAW_COLORS: { id: string; name: string }[] = [
  { id: "#ff3b30", name: "Vermelho" },
  { id: "#ffd60a", name: "Amarelo" },
  { id: "#30d158", name: "Verde" },
  { id: "#0a84ff", name: "Azul" },
  { id: "#ffffff", name: "Branco" },
];

export const DRAW_WIDTHS: { id: number; name: string }[] = [
  { id: 3, name: "Fino" },
  { id: 5, name: "Médio" },
  { id: 9, name: "Grosso" },
];

/** With "sumir sozinho" on, a drawing stays this long, then fades out over FADE_OUT. */
export const FADE_AFTER = 3000;
export const FADE_OUT = 500;

export const DEFAULT_DRAW: DrawConfig = { tool: "mouse", color: "#ff3b30", width: 5, fade: false };
