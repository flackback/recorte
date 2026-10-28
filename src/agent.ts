import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { createScene, refreshTime, type Scene } from "./editor/composition";
import type { Editor } from "./editor/editor";
import { findSilences } from "./editor/cleanup";
import { PRESETS } from "./editor/export-dialog";
import { ExportCancelled, exportBatch, maxFps, type ExportOptions } from "./editor/exporter";
import { ASPECTS, defaultProject, normalizeProject, type Aspect } from "./editor/project";
import { LANGUAGES, preferredLanguage, SAMPLE_RATE, speech, transcribe } from "./editor/transcribe";
import { toast } from "./toast";
import { joinPath, takeName, type CursorEvent, type KeyEvent, type Take, type Word } from "./types";

/**
 * Answers requests from the MCP server, relayed by the app's local control channel: reload an
 * edit made on disk, open a take, and run exports and transcriptions as jobs that can be polled.
 */

type Request = { id: number; kind: string; payload: Record<string, unknown> | null };

type Job = {
  id: string;
  kind: "export" | "transcribe";
  takeId: string;
  state: "running" | "done" | "error" | "cancelled";
  phase: string;
  done: number;
  total: number;
  message: string;
  result: unknown;
  startedAt: number;
  abort?: AbortController;
};

export type AgentHost = {
  editor: Editor;
  /** Reloads the take list (titles may have changed) and returns it. */
  refresh(): Promise<Take[]>;
  /** Opens a take in the editor and brings the window forward. */
  open(id: string): Promise<void>;
};

const KEEP_JOBS = 20;
const PHASES = { preparing: "Preparando", audio: "Mixando o áudio", video: "Renderizando quadros", finishing: "Finalizando o arquivo" };

const jobs = new Map<string, Job>();
let nextJob = 1;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(convertFileSrc(path), { cache: "no-store" });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

/** The take with its saved edit, as the editor would open it. */
async function loadScene(take: Take): Promise<Scene> {
  const cursor = await readJson<{ events: CursorEvent[] }>(joinPath(take.dir, take.cursor));
  const keys = take.keys ? await readJson<{ events: KeyEvent[] }>(joinPath(take.dir, take.keys)) : null;
  const transcript = await readJson<{ words: Word[] }>(joinPath(take.dir, "transcript.json"));
  const events = cursor?.events ?? [];
  const fallback = defaultProject(take, events);
  const saved = await invoke<string | null>("load_project", { dir: take.dir });
  const project = saved ? normalizeProject(JSON.parse(saved), fallback) : fallback;
  const scene = createScene(take, project, events, keys?.events ?? [], transcript?.words ?? []);
  refreshTime(scene);
  return scene;
}

function publicJob(job: Job) {
  const { abort: _abort, ...rest } = job;
  return { ...rest, elapsedMs: Math.round(performance.now() - job.startedAt) };
}

function addJob(kind: Job["kind"], takeId: string): Job {
  const job: Job = { id: `j${nextJob++}`, kind, takeId, state: "running", phase: "Preparando", done: 0, total: 0, message: "", result: null, startedAt: performance.now() };
  jobs.set(job.id, job);
  for (const old of [...jobs.values()]) {
    if (jobs.size <= KEEP_JOBS) break;
    if (old.state !== "running") jobs.delete(old.id);
  }
  return job;
}

const running = (kind: Job["kind"]) => [...jobs.values()].some((job) => job.kind === kind && job.state === "running");

export function startAgent(host: AgentHost) {
  const findTake = async (id: unknown) => {
    const take = (await host.refresh()).find((candidate) => candidate.id === id);
    if (!take) throw new Error(`gravação não encontrada: ${String(id)}`);
    return take;
  };

  async function exportJob(take: Take, options: ExportOptions, aspects: Aspect[]) {
    if (running("export")) throw new Error("já existe uma exportação em andamento");
    if (host.editor.currentTakeId === take.id) host.editor.flush();
    const scene = await loadScene(take);
    const job = addJob("export", take.id);
    const abort = new AbortController();
    job.abort = abort;
    toast(`A IA está exportando “${takeName(take)}”…`);
    exportBatch(scene, options, aspects, (progress) => {
      job.phase = (progress.files > 1 ? `Formato ${progress.file} de ${progress.files} · ` : "") + PHASES[progress.phase];
      job.done = progress.done;
      job.total = progress.total;
    }, abort.signal)
      .then(({ paths, codec, fellBack }) => {
        const path = paths[0];
        job.state = "done";
        job.result = { path, paths, codec, fellBack };
        if (fellBack) toast("HEVC falhou neste computador: exportado em H.264");
        const name = paths.length > 1 ? `${paths.length} arquivos` : path.split("\\").pop();
        toast(`Exportado: ${name}`, { label: "Mostrar na pasta", run: () => void revealItemInDir(path) });
      })
      .catch((error) => {
        const cancelled = error instanceof ExportCancelled || abort.signal.aborted;
        job.state = cancelled ? "cancelled" : "error";
        job.message = cancelled ? "exportação cancelada" : error instanceof Error ? error.message : String(error);
        toast(cancelled ? "Exportação da IA cancelada" : `A exportação da IA falhou: ${job.message}`);
      });
    return { jobId: job.id };
  }

  async function transcribeJob(take: Take, language: string) {
    if (running("transcribe")) throw new Error("já existe uma transcrição em andamento");
    const job = addJob("transcribe", take.id);
    toast(`A IA está transcrevendo “${takeName(take)}”…`);
    (async () => {
      const words = await transcribe(take, (message) => (job.phase = message), language);
      // Word cuts point into the old transcript, so they are cleared, as in the editor.
      const open = host.editor.currentTakeId === take.id;
      if (open) host.editor.flush();
      const scene = await loadScene(take);
      scene.project.deletedWords = [];
      scene.project.captions.visible = words.length > 0;
      await invoke("save_project", { dir: take.dir, json: JSON.stringify(scene.project, null, 2) });
      if (open) {
        host.editor.setWords(take.id, words);
        await host.editor.reloadProject();
      }
      job.state = "done";
      job.result = { words: words.length };
      toast(words.length ? `Transcrição pronta: ${words.length} palavras` : "Nenhuma fala encontrada");
    })().catch((error) => {
      job.state = "error";
      job.message = error instanceof Error ? error.message : String(error);
      toast(`A transcrição da IA falhou: ${job.message}`);
    });
    return { jobId: job.id };
  }

  async function handle(kind: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (kind) {
      case "status":
        return { openTake: host.editor.currentTakeId, jobs: [...jobs.values()].filter((job) => job.state === "running").map(publicJob) };
      case "flush":
        host.editor.flush();
        return {};
      case "reload": {
        const takes = await host.refresh();
        const open = host.editor.currentTakeId === payload.takeId;
        if (!open) return { open, changed: false };
        const take = takes.find((candidate) => candidate.id === payload.takeId);
        if (take) host.editor.setTitle(takeName(take));
        const changed = await host.editor.reloadProject();
        if (changed) toast(String(payload.summary || "A IA alterou a edição"), { label: "Desfazer", run: () => host.editor.undo() });
        return { open, changed };
      }
      case "open":
        await findTake(payload.takeId);
        await host.open(String(payload.takeId));
        return {};
      case "export": {
        const take = await findTake(payload.takeId);
        const preset = PRESETS.find((candidate) => candidate.id === payload.preset);
        const longSide = Number(payload.longSide);
        const options: ExportOptions = {
          format: payload.format === "gif" ? "gif" : "mp4",
          longSide,
          // Whole frame rates only (the MP4 muxer rejects 29.97), within what the encoder handles.
          fps: Math.min(Math.round(Number(payload.fps)), maxFps(longSide)),
          aspect: preset?.aspect,
          maxBytes: preset?.maxBytes,
          codec: payload.codec === "hevc" ? "hevc" : "h264",
        };
        if (!(options.longSide >= 160) || !(options.fps >= 1)) throw new Error("resolução ou fps inválidos");
        const aspects = Array.isArray(payload.aspects) ? payload.aspects.filter((aspect): aspect is Aspect => ASPECTS.some((known) => known.id === aspect)) : [];
        return exportJob(take, options, aspects);
      }
      case "silences": {
        // Decoding audio needs the WebView, so the MCP server asks the app.
        const take = await findTake(payload.takeId);
        if (host.editor.currentTakeId === take.id) host.editor.flush();
        const scene = await loadScene(take);
        const spans = scene.time.spans.map(({ start, end }) => ({ start, end }));
        return { silences: findSilences(await speech(take), SAMPLE_RATE, spans, Number(payload.minMs) || 800, Number(payload.padMs ?? 150)) };
      }
      case "transcribe": {
        const language = LANGUAGES.some(([code]) => code === payload.language) ? String(payload.language) : preferredLanguage();
        return transcribeJob(await findTake(payload.takeId), language);
      }
      case "job": {
        const job = jobs.get(String(payload.jobId));
        if (!job) throw new Error("tarefa não encontrada");
        return publicJob(job);
      }
      case "cancel": {
        const job = jobs.get(String(payload.jobId));
        if (!job) throw new Error("tarefa não encontrada");
        if (job.kind !== "export") throw new Error("só a exportação pode ser cancelada");
        job.abort?.abort();
        return {};
      }
      default:
        throw new Error(`pedido desconhecido: ${kind}`);
    }
  }

  void listen<Request>("agent-request", async (event) => {
    const { id, kind, payload } = event.payload;
    try {
      const result = await handle(kind, payload ?? {});
      await invoke("agent_reply", { id, ok: true, result: result ?? {} });
    } catch (error) {
      await invoke("agent_reply", { id, ok: false, result: error instanceof Error ? error.message : String(error) });
    }
  });
}
