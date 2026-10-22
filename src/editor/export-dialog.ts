import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { toast } from "../toast";
import type { Scene } from "./composition";
import { sceneSource, totalDuration } from "./composition";
import { AUDIO_BITRATE, cappedBitrate, ExportCancelled, exportVideo, hasAudio, videoBitrate, type ExportOptions, type ExportProgress } from "./exporter";
import { outputSize, type Aspect } from "./project";

/** Ready-made settings per destination. Sizes and rates are capped by the recording. */
export const PRESETS: { id: string; name: string; format?: "mp4"; side?: number; fps?: number; aspect?: Aspect; maxBytes?: number }[] = [
  { id: "custom", name: "Personalizado" },
  { id: "youtube", name: "YouTube", format: "mp4", side: 1920, fps: 60 },
  { id: "vertical", name: "Reels, TikTok e Shorts (vertical 9:16)", format: "mp4", side: 1920, fps: 30, aspect: "9:16" },
  { id: "whatsapp", name: "WhatsApp (até 16 MB)", format: "mp4", side: 1280, fps: 30, maxBytes: 16e6 },
  { id: "discord", name: "Discord (até 10 MB)", format: "mp4", side: 1280, fps: 30, maxBytes: 10e6 },
];

const FORMATS = {
  mp4: {
    resolutions: [
      ["1280", "720p · HD"],
      ["1920", "1080p · Full HD"],
      ["2560", "1440p · QHD"],
      ["3840", "2160p · 4K"],
    ],
    resolution: "1920",
    fps: [["30", "30 fps"], ["60", "60 fps"], ["120", "120 fps"]],
  },
  gif: {
    resolutions: [
      ["480", "Pequeno · 480 px"],
      ["640", "Médio · 640 px"],
      ["960", "Grande · 960 px"],
    ],
    resolution: "640",
    fps: [["10", "10 fps"], ["15", "15 fps"], ["20", "20 fps"]],
  },
} as const;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const CHECK_ICON = '<svg class="i"><use href="#i-check" /></svg>';
const ERROR_ICON = '<svg class="i"><use href="#i-close" /></svg>';

function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${(total % 60).toString().padStart(2, "0")}`;
}

function formatSize(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function formatEta(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.ceil(ms / 1000);
  return seconds < 60 ? `Faltam cerca de ${seconds} s` : `Faltam cerca de ${Math.ceil(seconds / 60)} min`;
}

/** The export sheet: options, progress with cancel, then the result. */
export class ExportDialog {
  private ui = {
    modal: $("export-modal"),
    setup: $("export-setup"),
    running: $("export-running"),
    done: $("export-done"),
    preset: $<HTMLSelectElement>("export-preset"),
    format: $("export-format"),
    resolution: $<HTMLSelectElement>("export-resolution"),
    fps: $<HTMLSelectElement>("export-fps"),
    summary: $("export-summary"),
    start: $<HTMLButtonElement>("export-start"),
    close: $<HTMLButtonElement>("export-close"),
    progress: $("export-progress"),
    bar: $("export-bar"),
    phase: $("export-phase"),
    percent: $("export-percent"),
    eta: $("export-eta"),
    cancel: $<HTMLButtonElement>("export-cancel"),
    result: $("export-result"),
    dismiss: $<HTMLButtonElement>("export-dismiss"),
    reveal: $<HTMLButtonElement>("export-reveal"),
  };
  private scene: Scene | null = null;
  private abort: AbortController | null = null;
  private savedPath: string | null = null;
  private returnFocus: HTMLElement | null = null;
  private preset = PRESETS[0];

  constructor() {
    const ui = this.ui;
    ui.preset.replaceChildren(...PRESETS.map((preset) => new Option(preset.name, preset.id)));
    ui.preset.addEventListener("change", () => this.applyPreset(ui.preset.value));
    ui.format.addEventListener("change", () => {
      // GIF has no destination preset.
      if (this.format === "gif") this.setPreset(PRESETS[0]);
      this.applyFormat();
    });
    ui.resolution.addEventListener("change", () => this.updateSummary());
    ui.fps.addEventListener("change", () => this.updateSummary());
    ui.start.addEventListener("click", () => void this.run());
    ui.close.addEventListener("click", () => this.close());
    ui.dismiss.addEventListener("click", () => this.close());
    ui.cancel.addEventListener("click", () => {
      ui.cancel.disabled = true;
      ui.phase.textContent = "Cancelando…";
      this.abort?.abort();
    });
    ui.reveal.addEventListener("click", () => {
      if (this.savedPath) void revealItemInDir(this.savedPath);
    });
    ui.modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.abort) this.close();
      event.stopPropagation();
    });
    // Clicking the dimmed backdrop closes the sheet, except while exporting.
    ui.modal.addEventListener("click", (event) => {
      if (event.target === ui.modal && !this.abort) this.close();
    });
  }

  get isOpen() {
    return !this.ui.modal.hidden;
  }

  open(scene: Scene) {
    if (this.abort) return;
    this.scene = scene;
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.show("setup");
    this.setPreset(PRESETS[0]);
    this.applyFormat();
    this.ui.modal.hidden = false;
    this.ui.start.focus();
  }

  private close() {
    this.ui.modal.hidden = true;
    this.scene = null;
    this.returnFocus?.focus();
  }

  private show(view: "setup" | "running" | "done") {
    this.ui.setup.hidden = view !== "setup";
    this.ui.running.hidden = view !== "running";
    this.ui.done.hidden = view !== "done";
  }

  private setPreset(preset: (typeof PRESETS)[number]) {
    this.preset = preset;
    this.ui.preset.value = preset.id;
  }

  /** Fills format, resolution and frame rate from a destination, within what was recorded. */
  private applyPreset(id: string) {
    const preset = PRESETS.find((candidate) => candidate.id === id) ?? PRESETS[0];
    this.setPreset(preset);
    if (preset.format) {
      const radio = this.ui.format.querySelector<HTMLInputElement>(`input[value="${preset.format}"]`);
      if (radio) radio.checked = true;
    }
    this.applyFormat();
    const pickAtMost = (select: HTMLSelectElement, limit: number | undefined) => {
      if (limit === undefined) return;
      const values = [...select.options].map((option) => Number(option.value));
      const best = values.filter((value) => value <= limit).pop() ?? values[0];
      select.value = String(best);
    };
    pickAtMost(this.ui.resolution, preset.side);
    pickAtMost(this.ui.fps, preset.fps);
    this.updateSummary();
  }

  private get aspect(): Aspect {
    return this.preset.aspect ?? this.scene!.project.aspect;
  }

  private get format(): ExportOptions["format"] {
    return this.ui.format.querySelector<HTMLInputElement>("input:checked")?.value === "gif" ? "gif" : "mp4";
  }

  /** Fills resolution and fps choices for the chosen format, keeping sensible defaults. */
  private applyFormat() {
    const scene = this.scene;
    if (!scene) return;
    const format = FORMATS[this.format];
    const fill = (select: HTMLSelectElement, options: [string, string][], value: string) => {
      select.replaceChildren(...options.map(([optionValue, label]) => new Option(label, optionValue)));
      select.value = options.some(([optionValue]) => optionValue === value) ? value : options[options.length - 1][0];
    };

    // Only sizes up to the recording itself (enlarging adds blur, not detail), labeled with the real
    // output size so 1:1 and 9:16 aren't described as "1080p".
    const source = sceneSource(scene);
    const sourceLong = Math.max(source.width, source.height);
    const sides = format.resolutions.map(([value]) => Number(value)).filter((side) => side < sourceLong - 8);
    const label = (side: number, original: boolean) => {
      const size = outputSize(this.aspect, source, side);
      return `${size.width} × ${size.height}${original ? " · original" : ""}`;
    };
    const resolutions: [string, string][] = [...sides.map((side): [string, string] => [String(side), label(side, false)])];
    if (this.format === "mp4" || sourceLong <= Number(format.resolutions[format.resolutions.length - 1][0])) {
      resolutions.push([String(Math.round(sourceLong / 2) * 2), label(Math.round(sourceLong / 2) * 2, true)]);
    }
    const preferred = Math.min(sourceLong, Number(format.resolution));
    const pick = resolutions.filter(([value]) => Number(value) <= preferred).pop() ?? resolutions[0];
    fill(this.ui.resolution, resolutions, pick[0]);

    // No more frames than were recorded.
    const takeFps = scene.take.fps;
    const rates = format.fps.filter(([value]) => this.format === "gif" || Number(value) <= takeFps).map(([value, name]): [string, string] => [value, name]);
    fill(this.ui.fps, rates.length ? rates : [[String(takeFps), `${takeFps} fps`]], this.format === "gif" ? "15" : String(takeFps));
    this.ui.start.textContent = this.format === "gif" ? "Exportar GIF" : "Exportar vídeo";
    this.updateSummary();
  }

  private options(): ExportOptions {
    return { format: this.format, longSide: Number(this.ui.resolution.value), fps: Number(this.ui.fps.value), aspect: this.preset.aspect, maxBytes: this.preset.maxBytes };
  }

  private updateSummary() {
    const scene = this.scene;
    if (!scene) return;
    const { longSide, fps, format } = this.options();
    const output = outputSize(this.aspect, sceneSource(scene), longSide);
    const duration = totalDuration(scene);
    if (format === "gif") {
      this.ui.summary.textContent = `GIF · ${output.width}×${output.height} · ${formatDuration(duration)} · sem som${duration > 30000 ? " · GIFs longos ficam grandes" : ""}`;
      return;
    }
    const sound = hasAudio(scene);
    const { maxBytes } = this.preset;
    let rate = videoBitrate(output.width, output.height, fps);
    if (maxBytes) rate = Math.min(rate, cappedBitrate(maxBytes, duration / 1000, sound));
    const bits = (rate + (sound ? AUDIO_BITRATE : 0)) * (duration / 1000);
    // Below this, text on screen turns blurry.
    const tooLong = maxBytes !== undefined && rate < 600_000;
    this.ui.summary.textContent =
      `MP4 · H.264${sound ? " + áudio" : ""} · ${output.width}×${output.height} · ${formatDuration(duration)} · ${maxBytes ? "até" : "cerca de"} ${formatSize(bits / 8)}` +
      (tooLong ? " · vídeo longo para esse limite: a imagem fica com menos qualidade" : "");
  }

  private setProgress(progress: ExportProgress, startedVideo: number) {
    const ui = this.ui;
    const labels = { preparing: "Preparando…", audio: "Mixando o áudio…", video: "Renderizando quadros…", finishing: "Finalizando o arquivo…" };
    if (ui.cancel.disabled) return;
    ui.phase.textContent = labels[progress.phase];
    const determinate = progress.phase === "video";
    ui.progress.classList.toggle("indeterminate", !determinate);
    if (!determinate) {
      ui.bar.style.width = "";
      ui.percent.textContent = progress.phase === "finishing" ? "100%" : "";
      ui.eta.innerHTML = "&nbsp;";
      return;
    }
    const fraction = progress.done / progress.total;
    const percent = Math.floor(fraction * 100);
    ui.bar.style.width = `${fraction * 100}%`;
    ui.percent.textContent = `${percent}%`;
    ui.progress.setAttribute("aria-valuenow", String(percent));
    const elapsed = performance.now() - startedVideo;
    // Wait for a few frames before estimating; the first ones include warm-up.
    ui.eta.textContent = progress.done > 30 ? formatEta((elapsed / progress.done) * (progress.total - progress.done)) || " " : " ";
  }

  private async run() {
    const scene = this.scene;
    if (!scene || this.abort) return;
    const ui = this.ui;
    const abort = new AbortController();
    this.abort = abort;
    ui.cancel.disabled = false;
    ui.bar.style.width = "0%";
    ui.percent.textContent = "";
    this.show("running");
    ui.cancel.focus();

    const started = performance.now();
    let startedVideo = started;
    try {
      const path = await exportVideo(
        scene,
        this.options(),
        (progress) => {
          if (progress.phase === "video" && progress.done <= 5) startedVideo = performance.now();
          this.setProgress(progress, startedVideo);
        },
        abort.signal,
      );
      this.savedPath = path;
      const name = path.split("\\").pop() ?? path;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      ui.result.className = "result success";
      ui.result.innerHTML = `${CHECK_ICON}<div><strong></strong><p></p></div>`;
      ui.result.querySelector("strong")!.textContent = `Exportado em ${seconds} s`;
      ui.result.querySelector("p")!.textContent = name;
      ui.result.querySelector("p")!.title = path;
      ui.reveal.hidden = false;
      this.show("done");
      ui.reveal.focus();
    } catch (error) {
      if (error instanceof ExportCancelled || abort.signal.aborted) {
        this.close();
        toast("Exportação cancelada");
      } else {
        console.error("exportação falhou", error);
        ui.result.className = "result error";
        ui.result.innerHTML = `${ERROR_ICON}<div><strong>A exportação falhou</strong><p></p></div>`;
        ui.result.querySelector("p")!.textContent = error instanceof Error ? error.message : String(error);
        ui.reveal.hidden = true;
        this.show("done");
        ui.dismiss.focus();
      }
    } finally {
      this.abort = null;
    }
  }
}
