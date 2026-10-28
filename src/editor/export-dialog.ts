import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { toast } from "../toast";
import type { Scene } from "./composition";
import { sceneSource, totalDuration } from "./composition";
import {
  AUDIO_BITRATE,
  cappedBitrate,
  ExportCancelled,
  exportBatch,
  hasAudio,
  hevcSupported,
  maxFps,
  videoBitrate,
  type BatchProgress,
  type ExportOptions,
  type VideoCodec,
} from "./exporter";
import { ASPECTS, outputSize, type Aspect } from "./project";

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

/** Aspects offered as extra files; the edit's own aspect is added in front when it isn't one of them. */
const BATCH_ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

/** Whether this computer encodes HEVC at all (at 720p30), asked once, to word why it's off. */
let hevcAnywhere: Promise<boolean> | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Replaces a select's options, keeping `value` when offered (else the last option). */
function fill(select: HTMLSelectElement, options: [string, string][], value: string) {
  select.replaceChildren(...options.map(([optionValue, label]) => new Option(label, optionValue)));
  select.value = options.some(([optionValue]) => optionValue === value) ? value : options[options.length - 1][0];
}

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
    aspects: $("export-aspects"),
    codecField: $("export-codec-field"),
    codec: $("export-codec"),
    codecHint: $("export-codec-hint"),
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
  /** Aspects to export, in the chips' order; the first one labels the resolutions. */
  private aspects: Aspect[] = [];
  /** Bumped on every HEVC check, so a slow answer for old settings is ignored. */
  private hevcCheck = 0;

  constructor() {
    const ui = this.ui;
    ui.preset.replaceChildren(...PRESETS.map((preset) => new Option(preset.name, preset.id)));
    ui.preset.addEventListener("change", () => this.applyPreset(ui.preset.value));
    ui.format.addEventListener("change", () => {
      // GIF has no destination preset.
      if (this.format === "gif") this.setPreset(PRESETS[0]);
      this.applyFormat();
    });
    ui.resolution.addEventListener("change", () => {
      this.applyRates();
      this.updateSummary();
    });
    ui.fps.addEventListener("change", () => this.updateSummary());
    ui.codec.addEventListener("change", () => this.updateSummary());
    ui.aspects.addEventListener("change", (event) => this.pickAspect(event.target as HTMLInputElement));
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
    // Each export starts from the edit's own aspect and H.264.
    const own = scene.project.aspect;
    const choices = BATCH_ASPECTS.includes(own) ? BATCH_ASPECTS : [own, ...BATCH_ASPECTS];
    this.ui.aspects.replaceChildren(
      ...choices.map((aspect) => {
        const chip = document.createElement("label");
        chip.className = "chip";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = aspect;
        chip.append(input, ASPECTS.find((candidate) => candidate.id === aspect)?.name ?? aspect);
        return chip;
      }),
    );
    this.preset = PRESETS[0];
    this.ui.preset.value = PRESETS[0].id;
    this.setAspects([own]);
    this.ui.codec.querySelector<HTMLInputElement>('input[value="h264"]')!.checked = true;
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

  /** Picks a destination; one with its own aspect selects just that, leaving it goes back to the edit's. */
  private setPreset(preset: (typeof PRESETS)[number]) {
    const before = this.preset;
    this.preset = preset;
    this.ui.preset.value = preset.id;
    if (preset.aspect) this.setAspects([preset.aspect]);
    else if (before.aspect && this.scene) this.setAspects([this.scene.project.aspect]);
  }

  private setAspects(aspects: Aspect[]) {
    this.aspects = aspects;
    for (const input of this.ui.aspects.querySelectorAll("input")) input.checked = aspects.includes(input.value as Aspect);
  }

  /** A chip was toggled: at least one aspect stays on, and turning off a destination's own aspect leaves it. */
  private pickAspect(input: HTMLInputElement) {
    const checked = [...this.ui.aspects.querySelectorAll("input")].filter((candidate) => candidate.checked).map((candidate) => candidate.value as Aspect);
    if (!checked.length) {
      input.checked = true;
      return;
    }
    this.aspects = checked;
    if (this.preset.aspect && !checked.includes(this.preset.aspect)) {
      this.preset = PRESETS[0];
      this.ui.preset.value = PRESETS[0].id;
    }
    this.applyFormat(true);
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
    this.applyRates();
    pickAtMost(this.ui.fps, preset.fps);
    this.updateSummary();
  }

  /** The first aspect to export, which the resolution labels describe. */
  private get aspect(): Aspect {
    return this.aspects[0] ?? this.scene!.project.aspect;
  }

  private get codec(): VideoCodec {
    return this.ui.codec.querySelector<HTMLInputElement>("input:checked")?.value === "hevc" ? "hevc" : "h264";
  }

  private get format(): ExportOptions["format"] {
    return this.ui.format.querySelector<HTMLInputElement>("input:checked")?.value === "gif" ? "gif" : "mp4";
  }

  /** Fills resolution and fps choices for the chosen format, keeping sensible defaults (or the current size, with `keep`). */
  private applyFormat(keep = false) {
    const scene = this.scene;
    if (!scene) return;
    const format = FORMATS[this.format];

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
    const current = this.ui.resolution.value;
    fill(this.ui.resolution, resolutions, keep && resolutions.some(([value]) => value === current) ? current : pick[0]);

    if (!keep) this.ui.fps.replaceChildren();
    this.applyRates();
    this.ui.codecField.hidden = this.format === "gif";
    this.ui.start.textContent = this.format === "gif" ? "Exportar GIF" : "Exportar vídeo";
    this.updateSummary();
  }

  /**
   * Fills the frame rates for the chosen format and size, keeping the current one when it stays
   * available: no more frames than were recorded, and no 120 fps above 1440p.
   */
  private applyRates() {
    const scene = this.scene;
    if (!scene) return;
    const gif = this.format === "gif";
    const takeFps = scene.take.fps;
    const limit = gif ? Infinity : Math.min(takeFps, maxFps(Number(this.ui.resolution.value)));
    const rates = FORMATS[this.format].fps.filter(([value]) => Number(value) <= limit).map(([value, name]): [string, string] => [value, name]);
    fill(this.ui.fps, rates.length ? rates : [[String(takeFps), `${takeFps} fps`]], this.ui.fps.value || (gif ? "15" : String(takeFps)));
  }

  private options(): ExportOptions {
    const format = this.format;
    return {
      format,
      longSide: Number(this.ui.resolution.value),
      fps: Number(this.ui.fps.value),
      aspect: this.aspect,
      maxBytes: this.preset.maxBytes,
      codec: format === "mp4" ? this.codec : undefined,
    };
  }

  /** Output sizes of the files to export, in order. */
  private sizes(longSide: number) {
    const source = sceneSource(this.scene!);
    return this.aspects.map((aspect) => outputSize(aspect, source, longSide));
  }

  private updateSummary() {
    this.renderSummary();
    void this.checkHevc();
  }

  private renderSummary() {
    const scene = this.scene;
    if (!scene) return;
    const { longSide, fps, format } = this.options();
    const outputs = this.sizes(longSide);
    const sizes = outputs.map((output) => `${output.width}×${output.height}`).join(", ");
    const duration = totalDuration(scene);
    if (format === "gif") {
      this.ui.summary.textContent = `GIF · ${sizes} · ${formatDuration(duration)} · sem som${duration > 30000 ? " · GIFs longos ficam grandes" : ""}`;
      return;
    }
    const codec = this.codec;
    const sound = hasAudio(scene);
    const { maxBytes } = this.preset;
    const rates = outputs.map((output) => {
      const rate = videoBitrate(output.width, output.height, fps, codec);
      return maxBytes ? Math.min(rate, cappedBitrate(maxBytes, duration / 1000, sound)) : rate;
    });
    const bits = rates.reduce((sum, rate) => sum + (rate + (sound ? AUDIO_BITRATE : 0)) * (duration / 1000), 0);
    // Below this, text on screen turns blurry (HEVC holds up to about half).
    const tooLong = maxBytes !== undefined && Math.min(...rates) < (codec === "hevc" ? 300_000 : 600_000);
    const many = outputs.length > 1;
    const size = maxBytes ? `até ${formatSize(maxBytes)}${many ? " cada" : ""}` : `cerca de ${formatSize(bits / 8)}${many ? " no total" : ""}`;
    this.ui.summary.textContent =
      `MP4 · ${codec === "hevc" ? "HEVC" : "H.264"}${sound ? " + áudio" : ""} · ${sizes} · ${formatDuration(duration)} · ${size}` +
      (tooLong ? " · vídeo longo para esse limite: a imagem fica com menos qualidade" : "");
  }

  /** Offers HEVC only when this computer can encode it at every chosen size and rate. */
  private async checkHevc() {
    const scene = this.scene;
    if (!scene || this.format !== "mp4") return;
    const check = ++this.hevcCheck;
    const fps = Number(this.ui.fps.value);
    const supported = await hevcSupported(this.sizes(Number(this.ui.resolution.value)), fps);
    const anywhere = supported || (await (hevcAnywhere ??= hevcSupported([{ width: 1280, height: 720 }], 30)));
    if (check !== this.hevcCheck || this.scene !== scene) return;
    const hevc = this.ui.codec.querySelector<HTMLInputElement>('input[value="hevc"]')!;
    hevc.disabled = !supported;
    this.ui.codecHint.hidden = supported;
    this.ui.codecHint.textContent = anywhere ? "HEVC indisponível nesse tamanho ou fps." : "Este computador não codifica HEVC.";
    if (!supported && hevc.checked) {
      this.ui.codec.querySelector<HTMLInputElement>('input[value="h264"]')!.checked = true;
      this.renderSummary();
    }
  }

  private setProgress(progress: BatchProgress, startedVideo: number) {
    const ui = this.ui;
    const labels = { preparing: "Preparando…", audio: "Mixando o áudio…", video: "Renderizando quadros…", finishing: "Finalizando o arquivo…" };
    if (ui.cancel.disabled) return;
    ui.phase.textContent = (progress.files > 1 ? `Formato ${progress.file} de ${progress.files} · ` : "") + labels[progress.phase];
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
    let file = 1;
    const aspects = [...this.aspects];
    try {
      const { paths, fellBack } = await exportBatch(
        scene,
        this.options(),
        aspects,
        (progress) => {
          file = progress.file;
          if (progress.phase === "video" && progress.done <= 5) startedVideo = performance.now();
          this.setProgress(progress, startedVideo);
        },
        abort.signal,
      );
      if (fellBack) toast("HEVC falhou neste computador: exportado em H.264");
      this.savedPath = paths[0];
      const names = paths.map((path) => path.split("\\").pop() ?? path);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      ui.result.className = "result success";
      ui.result.innerHTML = `${CHECK_ICON}<div><strong></strong><p></p></div>`;
      ui.result.querySelector("strong")!.textContent = paths.length > 1 ? `${paths.length} arquivos exportados em ${seconds} s` : `Exportado em ${seconds} s`;
      ui.result.querySelector("p")!.textContent = names.join("\n");
      ui.result.querySelector("p")!.title = paths.join("\n");
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
        const reason = error instanceof Error ? error.message : String(error);
        ui.result.querySelector("p")!.textContent = aspects.length > 1 ? `Formato ${file} de ${aspects.length} (${aspects[file - 1]}): ${reason}` : reason;
        ui.reveal.hidden = true;
        this.show("done");
        ui.dismiss.focus();
      }
    } finally {
      this.abort = null;
    }
  }
}
