import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import * as z from "zod";

import {
  absorbSplits,
  ASPECTS,
  autoZooms,
  BACKGROUNDS,
  cardLength,
  defaultProject,
  isSplit,
  mergeCuts,
  newId,
  newNote,
  NOTE_COLORS,
  outputSize,
  sourceSize,
  SPEEDS,
  STYLES,
  type BlurRegion,
  type Note,
  type Project,
  type Range,
  type SpeedRange,
  type ZoomSegment,
} from "../src/editor/project";
import { fillerWords } from "../src/editor/cleanup";
import type { Take, Word } from "../src/types";
import { appRequest, tryApp } from "./app";
import * as store from "./store";

/**
 * MCP server for Recorte: lets an AI client read takes (transcript, clicks, keys), edit them
 * (cuts, word cuts, zooms, blur, styles, settings) and export or transcribe through the app.
 */

const VERSION = "1.0.0";

const INSTRUCTIONS = `O Recorte grava a tela e edita vídeos. Use este fluxo:
1. Chame list_takes para ver as gravações. "latest" indica a mais recente.
2. Chame get_take e get_transcript para entender o conteúdo.
3. Edite com as ferramentas de corte, zoom, desfoque, estilo e ajustes.
4. Chame export_video para gerar o MP4 ou o GIF.

Regras:
- Todos os tempos estão em milissegundos, na linha do tempo da gravação original (antes dos cortes).
- Coordenadas de cliques e áreas estão em pixels do vídeo gravado.
- Cada edição é salva no project.json da gravação. Se o editor do app estiver com a gravação aberta, ele mostra a mudança na hora. O usuário pode desfazer com Ctrl+Z no editor. Você pode desfazer com undo_last_edit.
- transcribe, export_video, open_in_editor e a melhoria de voz precisam do app aberto.
- Para tirar pausas: chame remove_silences (pelo áudio, precisa do app) ou find_pauses (pela transcrição) e depois add_cuts.
- Para hesitações ("hã", "hum", "é" longo): chame cut_fillers.
- Para uma transição sem tirar nada do vídeo: chame split_at e depois set_transition com o id da divisão.
- Trechos lentos (digitação, carregamento) podem ser acelerados com add_speed, sem cortar.
- Textos, setas e destaques: add_note. Posição em frações (0 a 1) do quadro final.
- Abertura e encerramento: set_title_cards.
- Marcas feitas durante a gravação (Alt+Shift+M) aparecem em get_take, campo markers.
- Para tirar palavras (por exemplo "é", "hã", "tipo", repetições): chame get_transcript e depois cut_words com os índices.
- Sem transcrição, chame transcribe antes.`;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const server = new McpServer({ name: "recorte", title: "Recorte", version: VERSION }, { instructions: INSTRUCTIONS });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  run: (args: z.infer<z.ZodObject<Shape>>, extra: Extra) => Promise<unknown>,
  readOnly = false,
) {
  const handler = async (args: z.infer<z.ZodObject<Shape>>, extra: Extra): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await run(args, extra), null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: message(error) }] };
    }
  };
  server.registerTool(
    name,
    { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } },
    handler as never,
  );
}

// ---------- shared pieces ----------

const takeArg = z.string().describe('Id da gravação, parte do nome dela, ou "latest" para a mais recente.');
const ms = (what: string) => z.number().describe(`${what}, em ms na linha do tempo da gravação original`);
const idList = z.array(z.string()).describe("Ids dos itens, como aparecem em get_take.");

const round = (value: number) => Math.round(value);
const seconds = (value: number) => `${(value / 1000).toFixed(1).replace(".", ",")} s`;

function span(take: Take, start: number, end: number) {
  const s = Math.max(0, round(start));
  const e = Math.min(take.durationMs, round(end));
  if (!(e - s >= 50)) throw new Error(`Trecho inválido: ${start}–${end} ms. A gravação vai de 0 a ${take.durationMs} ms.`);
  return { start: s, end: e };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && a.end > b.start;

function matchedStyle(project: Project) {
  return STYLES.find((style) => style.matches(project))?.id ?? null;
}

/** Length of the finished video: opening card, the edit, closing card. */
const finalDuration = (project: Project, words: Word[] | null) =>
  round(cardLength(project.cards.intro) + store.timeMap(project, words).duration + cardLength(project.cards.outro));

function overview(take: Take, project: Project, words: Word[] | null) {
  return {
    durationMs: round(take.durationMs),
    editedDurationMs: finalDuration(project, words),
    trim: { start: round(project.trim.start), end: round(project.trim.end) },
    cuts: project.cuts.filter((cut) => !isSplit(cut)).length,
    splits: project.cuts.filter(isSplit).length,
    cutWords: project.deletedWords.length,
    zooms: project.zoom.segments.filter((segment) => segment.mode === "zoom").length,
    lenses: project.zoom.segments.filter((segment) => segment.mode === "lens").length,
    blurs: project.blurs.length,
    spedUp: project.speed.length,
    notes: project.notes.length,
    intro: Boolean(cardLength(project.cards.intro)),
    outro: Boolean(cardLength(project.cards.outro)),
    aspect: project.aspect,
    style: matchedStyle(project),
  };
}

/** Loads the latest edit, applies `mutate`, saves it and tells the open editor. */
async function edit(ref: string, mutate: (project: Project, context: { take: Take; words: Word[] | null }) => string | Promise<string>) {
  const take = await store.findTake(ref);
  // The editor may hold changes not yet saved; this makes it save them first.
  await tryApp("flush", { takeId: take.id });
  const { project } = await store.loadProject(take);
  const words = await store.loadWords(take);
  const summary = await mutate(project, { take, words });
  const changed = await store.saveProject(take, project, summary);
  const app = changed ? await tryApp<{ open: boolean; changed: boolean }>("reload", { takeId: take.id, summary: `IA: ${summary}` }) : null;
  return {
    take: take.id,
    change: changed ? summary : `Nada mudou (${summary}).`,
    editor: !changed ? undefined : !app ? "O app está fechado. A edição aparece quando a gravação for aberta." : app.open ? "O editor aberto mostra a mudança." : "Salvo. O editor não está com esta gravação aberta.",
    ...overview(take, project, words),
  };
}

async function takeSummary(take: Take) {
  const { project, saved } = await store.loadProject(take);
  const words = await store.loadWords(take);
  return {
    id: take.id,
    name: store.takeName(take),
    createdAt: take.createdAt,
    source: `${take.sourceKind === "window" ? "janela" : "tela"}: ${take.sourceName}`,
    video: `${take.width}×${take.height} a ${take.fps} fps`,
    durationMs: round(take.durationMs),
    editedDurationMs: finalDuration(project, words),
    tracks: { systemAudio: take.systemAudio, microphone: Boolean(take.mic), webcam: Boolean(take.webcam), keys: Boolean(take.keys) },
    transcript: words ? words.length : null,
    edited: saved,
  };
}

// ---------- reading ----------

tool(
  "list_takes",
  "Lista as gravações, da mais recente para a mais antiga, com duração, faixas gravadas e se já têm transcrição ou edição.",
  { limit: z.number().int().min(1).max(200).optional().describe("Máximo de gravações. Padrão: 30.") },
  async ({ limit }) => {
    const takes = (await store.listTakes()).slice(0, limit ?? 30);
    return { folder: await store.takesRoot(), takes: await Promise.all(takes.map(takeSummary)) };
  },
  true,
);

tool(
  "get_take",
  "Mostra uma gravação e a edição completa dela (project.json): cortes, divisões (campo splits; em project.cuts têm start igual a end), palavras cortadas, zooms, lentes, desfoques, fundo, cursor, áudio e legendas, com os ids dos itens. Mostra também os estilos, fundos e proporções disponíveis.",
  { take: takeArg },
  async ({ take: ref }) => {
    const take = await store.findTake(ref);
    const { project } = await store.loadProject(take);
    const words = await store.loadWords(take);
    const map = store.timeMap(project, words);
    return {
      take: await takeSummary(take),
      folder: take.dir,
      crop: take.crop ?? null,
      pausedWhileRecording: take.pauses ?? [],
      markers: (take.markers ?? []).map(round),
      project,
      keptSpans: map.spans.map((kept) => ({ start: round(kept.start), end: round(kept.end), outputStart: round(kept.output + cardLength(project.cards.intro)), rate: kept.rate })),
      // Splits live in project.cuts with start === end; listed here on their own.
      splits: project.cuts
        .filter(isSplit)
        .map((split) => ({ id: split.id, atMs: round(split.start), outputMs: round(map.toOutput(split.start) + cardLength(project.cards.intro)), transition: split.transition ?? null })),
      style: matchedStyle(project),
      available: {
        styles: STYLES.map(({ id, name, description }) => ({ id, name, description })),
        backgrounds: BACKGROUNDS.map(({ id, name }) => ({ id, name })),
        aspects: ASPECTS.map(({ id }) => id),
        speeds: SPEEDS,
        noteColors: NOTE_COLORS,
        frames: ["none", "window"],
      },
    };
  },
  true,
);

tool(
  "get_transcript",
  "Mostra a transcrição palavra por palavra: índice, início, fim, texto e se a palavra já foi cortada. Use os índices em cut_words.",
  { take: takeArg, from: ms("Início do intervalo").optional(), to: ms("Fim do intervalo").optional() },
  async ({ take: ref, from, to }) => {
    const take = await store.findTake(ref);
    const words = await store.loadWords(take);
    if (!words) return { available: false, hint: "Esta gravação não tem transcrição. Chame transcribe (precisa do app aberto)." };
    const { project } = await store.loadProject(take);
    const deleted = new Set(project.deletedWords);
    const chosen = words.filter((word) => word.t1 >= (from ?? 0) && word.t0 <= (to ?? Infinity));
    return {
      available: true,
      count: chosen.length,
      text: chosen.filter((word) => !deleted.has(word.i)).map((word) => word.text).join(" "),
      words: chosen.map((word) => ({ i: word.i, start: word.t0, end: word.t1, text: word.text, cut: deleted.has(word.i) || undefined })),
    };
  },
  true,
);

tool(
  "get_activity",
  "Mostra os cliques, a rolagem e as teclas da gravação, com tempo e posição em pixels do vídeo. Ajuda a decidir onde pôr zoom e cortes.",
  {
    take: takeArg,
    from: ms("Início do intervalo").optional(),
    to: ms("Fim do intervalo").optional(),
    limit: z.number().int().min(1).max(5000).optional().describe("Máximo de itens por lista. Padrão: 500."),
  },
  async ({ take: ref, from, to, limit }) => {
    const take = await store.findTake(ref);
    const inside = (t: number) => t >= (from ?? 0) && t <= (to ?? Infinity);
    const max = limit ?? 500;
    const events = (await store.loadCursor(take)).filter((event) => inside(event.t));
    const keys = (await store.loadKeys(take)).filter((event) => inside(event.t));
    const buttons = { l: "esquerdo", r: "direito", m: "meio" };
    return {
      video: { width: take.width, height: take.height },
      clicks: events.filter((event) => event.k === "d").slice(0, max).map((event) => ({ t: round(event.t), x: round(event.x), y: round(event.y), button: buttons[event.b ?? "l"] })),
      scrolls: events.filter((event) => event.k === "w").slice(0, max).map((event) => ({ t: round(event.t), x: round(event.x), y: round(event.y), delta: event.w })),
      keys: take.keys ? keys.slice(0, max).map((event) => ({ t: round(event.t), key: [...event.m, event.n].join("+") })) : "As teclas não foram gravadas nesta gravação.",
    };
  },
  true,
);

tool(
  "find_pauses",
  "Encontra pausas na fala pela transcrição: o silêncio antes da primeira palavra, entre palavras e depois da última. Devolve trechos prontos para add_cuts, com uma folga para a fala não ficar colada.",
  {
    take: takeArg,
    minMs: z.number().min(200).optional().describe("Pausa mínima. Padrão: 700 ms."),
    padMs: z.number().min(0).max(1000).optional().describe("Folga mantida de cada lado da pausa. Padrão: 150 ms."),
  },
  async ({ take: ref, minMs, padMs }) => {
    const take = await store.findTake(ref);
    const words = await store.loadWords(take);
    if (!words?.length) throw new Error("Esta gravação não tem transcrição. Chame transcribe primeiro.");
    const { project } = await store.loadProject(take);
    const min = minMs ?? 700;
    const pad = padMs ?? 150;
    const deleted = new Set(project.deletedWords);
    const kept = words.filter((word) => !deleted.has(word.i) && word.t1 > project.trim.start && word.t0 < project.trim.end).sort((a, b) => a.t0 - b.t0);
    const pauses: { start: number; end: number; durationMs: number; after: string | null; before: string | null }[] = [];
    const add = (start: number, end: number, after: Word | null, before: Word | null) => {
      if (end - start < min) return;
      const range = { start: round(after ? start + pad : start), end: round(before ? end - pad : end) };
      if (range.end - range.start < 100) return;
      if (project.cuts.some((cut) => cut.start <= range.start && cut.end >= range.end)) return;
      pauses.push({ ...range, durationMs: range.end - range.start, after: after?.text ?? null, before: before?.text ?? null });
    };
    if (!kept.length) return { pauses: [], note: "Todas as palavras estão cortadas." };
    add(project.trim.start, kept[0].t0, null, kept[0]);
    for (let index = 1; index < kept.length; index++) add(kept[index - 1].t1, kept[index].t0, kept[index - 1], kept[index]);
    add(kept[kept.length - 1].t1, project.trim.end, kept[kept.length - 1], null);
    return {
      pauses,
      totalMs: pauses.reduce((sum, pause) => sum + pause.durationMs, 0),
      note: "Os tempos da transcrição são aproximados. Confira antes de cortar pausas curtas.",
    };
  },
  true,
);

// ---------- editing ----------

tool(
  "set_trim",
  "Define onde o vídeo começa e termina. O que fica antes e depois sai do vídeo exportado.",
  { take: takeArg, start: ms("Novo início").optional(), end: ms("Novo fim").optional() },
  ({ take, start, end }) =>
    edit(take, (project, { take: meta }) => {
      const next = { start: round(start ?? project.trim.start), end: round(end ?? project.trim.end) };
      next.start = Math.max(0, next.start);
      next.end = Math.min(meta.durationMs, next.end);
      if (next.end - next.start < 500) throw new Error("O vídeo precisa ficar com pelo menos 0,5 s.");
      project.trim = next;
      return `vídeo de ${seconds(next.start)} a ${seconds(next.end)}`;
    }),
);

tool(
  "add_cuts",
  "Corta trechos do meio do vídeo. Trechos que se tocam viram um só corte.",
  { take: takeArg, ranges: z.array(z.object({ start: ms("Início do corte"), end: ms("Fim do corte") })).min(1) },
  ({ take, ranges }) =>
    edit(take, (project, { take: meta }) => {
      const spans = ranges.map((range) => span(meta, range.start, range.end));
      project.cuts = mergeCuts(project.cuts, spans);
      const total = spans.reduce((sum, range) => sum + range.end - range.start, 0);
      return `${spans.length} ${spans.length === 1 ? "trecho cortado" : "trechos cortados"} (${seconds(total)})`;
    }),
);

tool(
  "remove_cuts",
  "Desfaz cortes do meio do vídeo: os indicados por id, ou todos. Também remove divisões (de split_at) pelo id.",
  { take: takeArg, ids: idList.optional(), all: z.boolean().optional().describe("true remove todos os cortes; as divisões ficam.") },
  ({ take, ids, all }) =>
    edit(take, (project) => {
      if (all) {
        const count = project.cuts.filter((cut) => !isSplit(cut)).length;
        project.cuts = project.cuts.filter(isSplit);
        return plural(count, "corte removido", "cortes removidos");
      }
      if (!ids?.length) throw new Error("Informe ids ou all: true.");
      const missing = ids.filter((id) => !project.cuts.some((cut) => cut.id === id));
      if (missing.length) throw new Error(`Cortes ou divisões não encontrados: ${missing.join(", ")}.`);
      const removed = project.cuts.filter((cut) => ids.includes(cut.id));
      project.cuts = project.cuts.filter((cut) => !ids.includes(cut.id));
      const splits = removed.filter(isSplit).length;
      return [removed.length - splits ? plural(removed.length - splits, "corte removido", "cortes removidos") : "", splits ? plural(splits, "divisão removida", "divisões removidas") : ""].filter(Boolean).join(", ");
    }),
);

tool(
  "split_at",
  "Divide o vídeo num ponto sem cortar nada. A emenda da divisão aceita transição (set_transition com o id devolvido), como a de um corte.",
  { take: takeArg, atMs: ms("Ponto da divisão") },
  async ({ take, atMs }) => {
    let id = "";
    const result = await edit(take, (project, { words }) => {
      const at = round(atMs);
      if (at <= project.trim.start || at >= project.trim.end) throw new Error(`O ponto precisa ficar entre ${round(project.trim.start)} e ${round(project.trim.end)} ms.`);
      if (store.timeMap(project, words).playable(at) !== at) throw new Error(`O ponto ${at} ms está num trecho cortado.`);
      const near = project.cuts.find((cut) => Math.abs(cut.start - at) < 40 || Math.abs(cut.end - at) < 40);
      if (near) throw new Error(`Já existe uma emenda aqui: ${isSplit(near) ? "divisão" : "corte"} ${near.id}. Use esse id em set_transition.`);
      id = newId();
      project.cuts = [...project.cuts, { id, start: at, end: at }].sort((a, b) => a.start - b.start);
      return `divisão em ${seconds(at)}`;
    });
    return { id, ...result };
  },
);

tool(
  "set_camera_layout",
  "Muda a webcam num trecho: tela cheia (full), ao lado da tela (side) ou oculta (hidden). Fora desses trechos ela fica na bolha. A troca é animada. Com remove, tira os trechos indicados (ids) ou todos.",
  {
    take: takeArg,
    start: ms("Início do trecho").optional(),
    end: ms("Fim do trecho").optional(),
    layout: z.enum(["full", "side", "hidden"]).optional(),
    remove: z.array(z.string()).optional().describe("Ids de trechos a tirar (de get_take, campo cameras)."),
    removeAll: z.boolean().optional(),
  },
  ({ take, start, end, layout, remove, removeAll }) =>
    edit(take, (project, { take: meta }) => {
      if (!meta.webcam) throw new Error("Esta gravação não tem webcam.");
      project.cameras ??= [];
      if (removeAll) project.cameras = [];
      if (remove?.length) project.cameras = project.cameras.filter((range) => !remove.includes(range.id));
      if (start === undefined && end === undefined) return removeAll || remove?.length ? "trechos da câmera removidos" : "nada mudou";
      if (start === undefined || end === undefined || !layout) throw new Error("Informe start, end e layout.");
      const range = span(meta, start, end);
      // A new stretch replaces the ones it overlaps.
      project.cameras = [...project.cameras.filter((other) => other.end <= range.start || other.start >= range.end), { id: newId(), ...range, layout }].sort((a, b) => a.start - b.start);
      return `câmera ${layout} de ${seconds(range.start)} a ${seconds(range.end)}`;
    }),
);

tool(
  "set_transition",
  "Põe, troca ou tira a transição na emenda de um corte ou de uma divisão (split_at). A transição tira o trecho de antes e traz o de depois: esmaecer (fade), zoom com desfoque (zoomblur), girar (flip), queimar (burn), desintegrar (dissolve) ou onda (wave).",
  {
    take: takeArg,
    cut: z.string().describe("Id do corte ou da divisão (de get_take ou split_at)."),
    kind: z.enum(["none", "fade", "zoomblur", "flip", "burn", "dissolve", "wave"]).describe("none tira a transição."),
    durationMs: z.number().min(300).max(2000).optional().describe("Duração total, metade antes e metade depois da emenda. Padrão 700."),
  },
  ({ take, cut: id, kind, durationMs }) =>
    edit(take, (project) => {
      const cut = project.cuts.find((candidate) => candidate.id === id);
      if (!cut) throw new Error(`Corte ou divisão não encontrado: ${id}.`);
      if (kind === "none") {
        delete cut.transition;
        return "transição removida";
      }
      cut.transition = { kind, durationMs: durationMs ?? cut.transition?.durationMs ?? 700 };
      return `transição ${kind} de ${seconds(cut.transition.durationMs)}`;
    }),
);

function wordIds(words: Word[] | null, list: number[] | undefined, from: number | undefined, to: number | undefined) {
  if (!words) throw new Error("Esta gravação não tem transcrição. Chame transcribe primeiro.");
  const ids = new Set(list ?? []);
  if (from !== undefined || to !== undefined) {
    const first = from ?? to!;
    const last = to ?? from!;
    for (let i = Math.min(first, last); i <= Math.max(first, last); i++) ids.add(i);
  }
  if (!ids.size) throw new Error("Informe words, ou from e to.");
  const known = new Set(words.map((word) => word.i));
  const missing = [...ids].filter((id) => !known.has(id));
  if (missing.length) throw new Error(`Palavras não encontradas: ${missing.slice(0, 20).join(", ")}.`);
  return [...ids];
}

const wordShape = {
  take: takeArg,
  words: z.array(z.number().int()).optional().describe("Índices das palavras (campo i de get_transcript)."),
  from: z.number().int().optional().describe("Primeiro índice de uma sequência."),
  to: z.number().int().optional().describe("Último índice de uma sequência."),
};

tool(
  "cut_words",
  "Corta palavras da fala pelos índices da transcrição. O tempo de cada palavra sai do vídeo.",
  wordShape,
  ({ take, words, from, to }) =>
    edit(take, (project, context) => {
      const ids = wordIds(context.words, words, from, to);
      project.deletedWords = [...new Set([...project.deletedWords, ...ids])].sort((a, b) => a - b);
      const text = context.words!.filter((word) => ids.includes(word.i)).map((word) => word.text).join(" ");
      return `${ids.length} ${ids.length === 1 ? "palavra cortada" : "palavras cortadas"}: “${text.slice(0, 80)}”`;
    }),
);

tool(
  "restore_words",
  "Devolve ao vídeo palavras cortadas: as indicadas, ou todas.",
  { ...wordShape, all: z.boolean().optional().describe("true restaura todas as palavras.") },
  ({ take, words, from, to, all }) =>
    edit(take, (project, context) => {
      if (all) {
        const count = project.deletedWords.length;
        project.deletedWords = [];
        return plural(count, "palavra restaurada", "palavras restauradas");
      }
      const ids = wordIds(context.words, words, from, to);
      project.deletedWords = project.deletedWords.filter((id) => !ids.includes(id));
      return `${ids.length} ${ids.length === 1 ? "palavra restaurada" : "palavras restauradas"}`;
    }),
);

const scaleArg = z.number().min(1.2).max(4).describe("Aumento, de 1,2 a 4. Padrão: o aumento padrão da edição.");

tool(
  "add_zoom",
  'Adiciona um zoom num trecho. mode "zoom" aproxima a câmera e segue o cursor; mode "lens" mostra uma lupa em volta do cursor. Zooms e lentes não podem se sobrepor.',
  { take: takeArg, start: ms("Início"), end: ms("Fim"), scale: scaleArg.optional(), mode: z.enum(["zoom", "lens"]).optional() },
  ({ take, start, end, scale, mode }) =>
    edit(take, (project, { take: meta }) => {
      const range = span(meta, start, end);
      const clash = project.zoom.segments.find((segment) => overlaps(segment, range));
      if (clash) throw new Error(`Já existe ${clash.mode === "lens" ? "uma lente" : "um zoom"} em ${round(clash.start)}–${round(clash.end)} ms (id ${clash.id}). Ajuste com update_item ou remova antes.`);
      const segment: ZoomSegment = { id: newId(), ...range, scale: scale ?? project.zoom.defaultScale, mode: mode ?? "zoom" };
      project.zoom.segments = [...project.zoom.segments, segment].sort((a, b) => a.start - b.start);
      return `${segment.mode === "lens" ? "lente" : "zoom"} de ${segment.scale}× em ${seconds(range.start)}–${seconds(range.end)} (id ${segment.id})`;
    }),
);

tool(
  "auto_zoom",
  "Gera zooms automáticos em volta dos grupos de cliques. Substitui os zooms existentes e mantém as lentes.",
  { take: takeArg, scale: scaleArg.optional() },
  ({ take, scale }) =>
    edit(take, async (project, { take: meta }) => {
      if (scale !== undefined) project.zoom.defaultScale = scale;
      const segments = autoZooms(await store.loadCursor(meta), meta.durationMs, project.zoom.defaultScale);
      if (!segments.length) throw new Error("Nenhum clique encontrado nesta gravação.");
      const lenses = project.zoom.segments.filter((segment) => segment.mode === "lens");
      project.zoom.segments = [...segments, ...lenses].sort((a, b) => a.start - b.start);
      return `${segments.length} ${segments.length === 1 ? "zoom gerado" : "zooms gerados"} a partir dos cliques`;
    }),
);

tool(
  "remove_zooms",
  "Remove zooms e lentes: os indicados por id, todos, ou todos de um tipo.",
  { take: takeArg, ids: idList.optional(), all: z.boolean().optional(), mode: z.enum(["zoom", "lens"]).optional().describe("Com all: true, remove só este tipo.") },
  ({ take, ids, all, mode }) =>
    edit(take, (project) => {
      const before = project.zoom.segments.length;
      if (all) project.zoom.segments = mode ? project.zoom.segments.filter((segment) => segment.mode !== mode) : [];
      else {
        if (!ids?.length) throw new Error("Informe ids ou all: true.");
        const missing = ids.filter((id) => !project.zoom.segments.some((segment) => segment.id === id));
        if (missing.length) throw new Error(`Zooms não encontrados: ${missing.join(", ")}.`);
        project.zoom.segments = project.zoom.segments.filter((segment) => !ids.includes(segment.id));
      }
      return plural(before - project.zoom.segments.length, "zoom ou lente removido", "zooms ou lentes removidos");
    }),
);

const areaShape = {
  x: z.number().describe("Esquerda, em pixels do vídeo."),
  y: z.number().describe("Topo, em pixels do vídeo."),
  width: z.number().min(8).describe("Largura, em pixels do vídeo."),
  height: z.number().min(8).describe("Altura, em pixels do vídeo."),
};

function area(take: Take, value: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(0, Math.min(take.width - 8, round(value.x)));
  const y = Math.max(0, Math.min(take.height - 8, round(value.y)));
  return { x, y, width: Math.max(8, Math.min(take.width - x, round(value.width))), height: Math.max(8, Math.min(take.height - y, round(value.height))) };
}

tool(
  "add_blur",
  "Desfoca uma área do vídeo durante um trecho, para esconder dados sensíveis. Desfoques não podem se sobrepor no tempo.",
  { take: takeArg, start: ms("Início"), end: ms("Fim"), ...areaShape },
  ({ take, start, end, x, y, width, height }) =>
    edit(take, (project, { take: meta }) => {
      const range = span(meta, start, end);
      const clash = project.blurs.find((blur) => overlaps(blur, range));
      if (clash) throw new Error(`Já existe um desfoque em ${round(clash.start)}–${round(clash.end)} ms (id ${clash.id}). Ajuste com update_item ou remova antes.`);
      const blur: BlurRegion = { id: newId(), ...range, ...area(meta, { x, y, width, height }) };
      project.blurs = [...project.blurs, blur].sort((a, b) => a.start - b.start);
      return `desfoque de ${blur.width}×${blur.height} px em ${seconds(range.start)}–${seconds(range.end)} (id ${blur.id})`;
    }),
);

tool(
  "remove_blurs",
  "Remove desfoques: os indicados por id, ou todos.",
  { take: takeArg, ids: idList.optional(), all: z.boolean().optional() },
  ({ take, ids, all }) =>
    edit(take, (project) => {
      const before = project.blurs.length;
      if (all) project.blurs = [];
      else {
        if (!ids?.length) throw new Error("Informe ids ou all: true.");
        const missing = ids.filter((id) => !project.blurs.some((blur) => blur.id === id));
        if (missing.length) throw new Error(`Desfoques não encontrados: ${missing.join(", ")}.`);
        project.blurs = project.blurs.filter((blur) => !ids.includes(blur.id));
      }
      return plural(before - project.blurs.length, "desfoque removido", "desfoques removidos");
    }),
);

tool(
  "update_item",
  "Altera um corte, trecho acelerado, zoom, lente ou desfoque existente pelo id: tempo, velocidade, aumento, tipo ou área. Para textos, setas e destaques use update_note.",
  {
    take: takeArg,
    id: z.string(),
    start: ms("Novo início").optional(),
    end: ms("Novo fim").optional(),
    scale: scaleArg.optional().describe("Só para zoom e lente."),
    mode: z.enum(["zoom", "lens"]).optional().describe("Só para zoom e lente."),
    area: z.object(areaShape).optional().describe("Só para desfoque."),
    rate: z.number().min(1.1).max(16).optional().describe("Só para trecho acelerado."),
  },
  ({ take, id, start, end, scale, mode, area: newArea, rate }) =>
    edit(take, (project, { take: meta }) => {
      const cut = project.cuts.find((item) => item.id === id);
      const segment = project.zoom.segments.find((item) => item.id === id);
      const blur = project.blurs.find((item) => item.id === id);
      const fast = project.speed.find((item) => item.id === id);
      const item = cut ?? segment ?? blur ?? fast;
      if (!item) throw new Error(`Item não encontrado: ${id}. Veja os ids em get_take.`);
      if (cut && isSplit(cut)) {
        // A split only moves; landing on or in a cut folds it into that cut.
        const at = round(Math.min(meta.durationMs, Math.max(0, start ?? end ?? cut.start)));
        cut.start = cut.end = at;
        project.cuts = absorbSplits([...project.cuts].sort((a, b) => a.start - b.start));
        return project.cuts.includes(cut) ? `divisão movida para ${seconds(at)}` : `divisão em ${seconds(at)} ficou dentro de um corte e foi juntada a ele`;
      }
      const range = span(meta, start ?? item.start, end ?? item.end);
      if (cut) {
        // Listed first, the cut keeps its id and transition when it merges with others.
        project.cuts = mergeCuts([{ ...cut, ...range }, ...project.cuts.filter((other) => other !== cut)], [range]);
        return `corte ajustado para ${seconds(range.start)}–${seconds(range.end)}`;
      }
      const siblings: Range[] = segment ? project.zoom.segments : fast ? project.speed : project.blurs;
      const clash = siblings.find((other) => other.id !== id && overlaps(other, range));
      if (clash) throw new Error(`O novo tempo encosta em outro item (${clash.id}, ${round(clash.start)}–${round(clash.end)} ms).`);
      Object.assign(item, range);
      if (fast) {
        if (rate !== undefined) fast.rate = rate;
        project.speed.sort((a, b) => a.start - b.start);
        return `trecho acelerado: ${fast.rate}× em ${seconds(range.start)}–${seconds(range.end)}`;
      }
      if (segment) {
        if (scale !== undefined) segment.scale = scale;
        if (mode) segment.mode = mode;
        project.zoom.segments.sort((a, b) => a.start - b.start);
        return `${segment.mode === "lens" ? "lente" : "zoom"} ajustado: ${segment.scale}× em ${seconds(range.start)}–${seconds(range.end)}`;
      }
      if (newArea) Object.assign(blur!, area(meta, newArea));
      project.blurs.sort((a, b) => a.start - b.start);
      return `desfoque ajustado em ${seconds(range.start)}–${seconds(range.end)}`;
    }),
);

tool(
  "add_speed",
  "Acelera um trecho (digitação, carregamento), sem cortar. O som do trecho acelerado fica mudo. Trechos acelerados não podem se sobrepor.",
  { take: takeArg, start: ms("Início"), end: ms("Fim"), rate: z.number().min(1.1).max(16).optional().describe("Velocidade. Padrão: 2. Opções do editor: 1,5; 2; 4; 8.") },
  ({ take, start, end, rate }) =>
    edit(take, (project, { take: meta }) => {
      const range = span(meta, start, end);
      const clash = project.speed.find((other) => overlaps(other, range));
      if (clash) throw new Error(`Já existe um trecho acelerado em ${round(clash.start)}–${round(clash.end)} ms (id ${clash.id}). Ajuste com update_item ou remova antes.`);
      const fast: SpeedRange = { id: newId(), ...range, rate: rate ?? 2 };
      project.speed = [...project.speed, fast].sort((a, b) => a.start - b.start);
      return `trecho de ${seconds(range.end - range.start)} acelerado ${fast.rate}× (fica com ${seconds((range.end - range.start) / fast.rate)}, id ${fast.id})`;
    }),
);

tool(
  "remove_speeds",
  "Volta trechos acelerados à velocidade normal: os indicados por id, ou todos.",
  { take: takeArg, ids: idList.optional(), all: z.boolean().optional() },
  ({ take, ids, all }) =>
    edit(take, (project) => {
      const before = project.speed.length;
      if (all) project.speed = [];
      else {
        if (!ids?.length) throw new Error("Informe ids ou all: true.");
        const missing = ids.filter((id) => !project.speed.some((item) => item.id === id));
        if (missing.length) throw new Error(`Trechos acelerados não encontrados: ${missing.join(", ")}.`);
        project.speed = project.speed.filter((item) => !ids.includes(item.id));
      }
      return plural(before - project.speed.length, "trecho voltou à velocidade normal", "trechos voltaram à velocidade normal");
    }),
);

const fraction = (what: string) => z.number().min(0).max(1).describe(`${what}, de 0 a 1 do quadro final`);
const noteShape = {
  text: z.string().max(200).optional().describe("Texto (só para kind text). Use \\n para quebrar a linha."),
  x: fraction("Esquerda").optional(),
  y: fraction("Topo").optional(),
  width: fraction("Largura").optional(),
  height: fraction("Altura").optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe(`Cor em hexadecimal. Sugestões: ${NOTE_COLORS.join(", ")}.`),
  size: z.number().min(0.5).max(2.5).optional().describe("Tamanho do texto ou espessura da linha. Padrão: 1."),
  direction: z.enum(["se", "sw", "ne", "nw"]).optional().describe("Para onde a seta aponta: se (baixo-direita), sw, ne, nw. A seta cruza a caixa de um canto ao oposto."),
};

function applyNote(note: Note, values: Partial<Note>) {
  for (const [key, value] of Object.entries(values)) if (value !== undefined) (note as Record<string, unknown>)[key] = value;
  // Keeps the box inside the frame.
  note.width = Math.min(note.width, 1);
  note.height = Math.min(note.height, 1);
  note.x = Math.max(0, Math.min(1 - note.width, note.x));
  note.y = Math.max(0, Math.min(1 - note.height, note.y));
}

tool(
  "add_note",
  "Adiciona um texto, uma seta ou um destaque (retângulo) sobre o vídeo, durante um trecho. Fica fixo no quadro final, mesmo com zoom. Sem posição, usa uma posição padrão (texto no alto, centralizado).",
  { take: takeArg, start: ms("Início"), end: ms("Fim"), kind: z.enum(["text", "arrow", "box"]).describe("text, arrow (seta) ou box (destaque)."), ...noteShape },
  ({ take, start, end, kind, ...values }) =>
    edit(take, (project, { take: meta }) => {
      const note = newNote({ id: newId(), ...span(meta, start, end) }, kind);
      applyNote(note, values);
      project.notes = [...project.notes, note].sort((a, b) => a.start - b.start);
      const label = kind === "text" ? `texto “${note.text.slice(0, 40)}”` : kind === "arrow" ? "seta" : "destaque";
      return `${label} em ${seconds(note.start)}–${seconds(note.end)} (id ${note.id})`;
    }),
);

tool(
  "update_note",
  "Altera um texto, seta ou destaque pelo id: tempo, tipo, texto, posição, cor, tamanho ou direção.",
  { take: takeArg, id: z.string(), start: ms("Novo início").optional(), end: ms("Novo fim").optional(), kind: z.enum(["text", "arrow", "box"]).optional(), ...noteShape },
  ({ take, id, start, end, ...values }) =>
    edit(take, (project, { take: meta }) => {
      const note = project.notes.find((item) => item.id === id);
      if (!note) throw new Error(`Texto, seta ou destaque não encontrado: ${id}. Veja os ids em get_take (project.notes).`);
      Object.assign(note, span(meta, start ?? note.start, end ?? note.end));
      applyNote(note, values);
      project.notes.sort((a, b) => a.start - b.start);
      return `${note.kind === "text" ? "texto" : note.kind === "arrow" ? "seta" : "destaque"} ajustado`;
    }),
);

tool(
  "remove_notes",
  "Remove textos, setas e destaques: os indicados por id, ou todos.",
  { take: takeArg, ids: idList.optional(), all: z.boolean().optional() },
  ({ take, ids, all }) =>
    edit(take, (project) => {
      const before = project.notes.length;
      if (all) project.notes = [];
      else {
        if (!ids?.length) throw new Error("Informe ids ou all: true.");
        const missing = ids.filter((id) => !project.notes.some((item) => item.id === id));
        if (missing.length) throw new Error(`Não encontrados: ${missing.join(", ")}.`);
        project.notes = project.notes.filter((item) => !ids.includes(item.id));
      }
      return plural(before - project.notes.length, "item removido", "itens removidos");
    }),
);

const cardShape = z
  .object({
    enabled: z.boolean().optional(),
    title: z.string().max(80).optional(),
    subtitle: z.string().max(120).optional(),
  })
  .optional();

tool(
  "set_title_cards",
  "Liga, desliga ou muda a tela de abertura e a de encerramento. Elas usam o fundo do estilo e entram no vídeo exportado.",
  { take: takeArg, intro: cardShape.describe("Tela de abertura."), outro: cardShape.describe("Tela de encerramento."), seconds: z.number().min(1).max(6).optional().describe("Duração de cada tela. Padrão: 2,5.") },
  ({ take, intro, outro, seconds: length }) =>
    edit(take, (project) => {
      for (const [card, values] of [[project.cards.intro, intro], [project.cards.outro, outro]] as const) {
        for (const [key, value] of Object.entries(values ?? {})) if (value !== undefined) (card as Record<string, unknown>)[key] = value;
      }
      if (length !== undefined) project.cards.intro.durationMs = project.cards.outro.durationMs = Math.round(length * 1000);
      const state = (card: Project["cards"]["intro"], off: string) => (cardLength(card) ? `“${card.title || card.subtitle}”` : off);
      return `abertura ${state(project.cards.intro, "desligada")}, encerramento ${state(project.cards.outro, "desligado")}`;
    }),
);

tool(
  "remove_silences",
  "Encontra os silêncios pelo áudio (microfone ou som da gravação) e corta. Não precisa de transcrição, mas precisa do app aberto. Com dryRun: true, só mostra os trechos.",
  {
    take: takeArg,
    minMs: z.number().min(300).max(10000).optional().describe("Silêncio mínimo. Padrão: 800 ms."),
    padMs: z.number().min(0).max(1000).optional().describe("Folga mantida perto da fala. Padrão: 150 ms."),
    dryRun: z.boolean().optional(),
  },
  async ({ take: ref, minMs, padMs, dryRun }) => {
    const take = await store.findTake(ref);
    if (!take.mic && !take.systemAudio) throw new Error("Esta gravação não tem áudio.");
    const { silences } = await appRequest<{ silences: { start: number; end: number }[] }>("silences", { takeId: take.id, minMs: minMs ?? 800, padMs: padMs ?? 150 });
    const total = silences.reduce((sum, range) => sum + range.end - range.start, 0);
    if (dryRun || !silences.length) return { take: take.id, silences, totalMs: total, cut: false };
    return edit(take.id, (project) => {
      project.cuts = mergeCuts(project.cuts, silences);
      return `${plural(silences.length, "silêncio cortado", "silêncios cortados")} (${seconds(total)})`;
    });
  },
);

tool(
  "cut_fillers",
  "Corta hesitações da transcrição: “hã”, “ãh”, “hum”, “uh” e “é” longo. O “é” curto (verbo) fica. O Whisper às vezes omite hesitações; confira com get_transcript.",
  { take: takeArg },
  ({ take }) =>
    edit(take, (project, { words }) => {
      if (!words?.length) throw new Error("Esta gravação não tem transcrição. Chame transcribe primeiro.");
      const found = fillerWords(words, project.deletedWords);
      if (!found.length) return "nenhuma hesitação encontrada";
      project.deletedWords = [...new Set([...project.deletedWords, ...found])].sort((a, b) => a - b);
      const text = words.filter((word) => found.includes(word.i)).map((word) => word.text).join(", ");
      return `${plural(found.length, "hesitação cortada", "hesitações cortadas")}: ${text.slice(0, 80)}`;
    }),
);

tool(
  "apply_style",
  "Aplica um estilo pronto: fundo, margem, cantos, sombra, proporção, moldura, inclinação e cursor. Não mexe em cortes nem zooms.",
  { take: takeArg, style: z.enum(STYLES.map((style) => style.id) as [string, ...string[]]).describe(STYLES.map((style) => `${style.id}: ${style.description}`).join("; ")) },
  ({ take, style }) =>
    edit(take, (project) => {
      const chosen = STYLES.find((candidate) => candidate.id === style)!;
      chosen.apply(project);
      return `estilo “${chosen.name}” aplicado`;
    }),
);

const settingsShape = {
  aspect: z.enum(ASPECTS.map((aspect) => aspect.id) as [string, ...string[]]).optional().describe("Proporção do vídeo final. auto mantém a da gravação."),
  crop: z.object(areaShape).nullable().optional().describe("Parte da gravação que fica no vídeo, em pixels. null mostra tudo."),
  background: z
    .object({
      preset: z.enum(BACKGROUNDS.map((background) => background.id) as [string, ...string[]]).optional().describe("Fundo em degradê. Escolher um preset troca um fundo de imagem pelo degradê."),
      padding: z.number().min(0).max(0.2).optional().describe("Margem em volta do vídeo, de 0 a 0,2."),
      radius: z.number().min(0).max(48).optional().describe("Cantos arredondados, em px."),
      shadow: z.number().min(0).max(1).optional(),
      blur: z.number().min(0).max(40).optional().describe("Desfoque da imagem de fundo."),
    })
    .optional(),
  frame: z.enum(["none", "window"]).optional().describe("Moldura: nenhuma ou janela."),
  tilt: z.number().min(-20).max(20).optional().describe("Inclinação 3D em graus. 0 é reto."),
  cursor: z
    .object({
      visible: z.boolean().optional(),
      size: z.number().min(0.6).max(3).optional(),
      smoothing: z.number().min(0).max(1).optional(),
      style: z.enum(["classic", "light", "dot", "pizza", "melon", "rocket"]).optional().describe("Estilo: clássico (escuro), claro, ponto, pizza, melancia ou foguete."),
      hideIdle: z.number().min(0).max(10000).optional().describe("Esconde o cursor parado depois de tantos ms. 0 nunca esconde."),
      returnHome: z.boolean().optional().describe("No fim, o cursor volta ao ponto de início (para vídeos em loop)."),
      shapeDelay: z.number().min(0).max(1000).optional().describe("Ignora trocas de forma (mão, barra de texto) mais curtas que tantos ms."),
      clickEffect: z.boolean().optional().describe("Efeito ao clicar."),
      clickStyle: z.enum(["ring", "liquid"]).optional().describe("Efeito do clique: anel ou líquido."),
      clickSize: z.number().min(0.5).max(3).optional().describe("Tamanho do efeito do clique."),
      spotlight: z.boolean().optional().describe("Destaque em volta do cursor ao clicar."),
    })
    .optional(),
  keys: z.object({ visible: z.boolean().optional(), mode: z.enum(["shortcuts", "all"]).optional() }).optional().describe("Teclas na tela."),
  webcam: z
    .object({
      visible: z.boolean().optional(),
      size: z.number().min(0.05).max(0.9).optional(),
      corner: z.enum(["br", "bl", "tr", "tl"]).optional().describe("Canto. Escolher um canto esquece a posição livre."),
      position: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().optional().describe("Centro da bolha em frações do quadro final (0 a 1); null volta ao canto."),
      shape: z.enum(["circle", "rounded", "square"]).optional(),
      mirror: z.boolean().optional().describe("Espelhar a imagem da câmera."),
      zoom: z.number().min(1).max(2.5).optional().describe("Aproximar a imagem dentro da bolha."),
      border: z.number().min(0).max(0.06).optional().describe("Largura da borda, em fração do tamanho da bolha."),
      borderColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      shadow: z.number().min(0).max(1).optional(),
    })
    .optional(),
  audio: z
    .object({
      system: z.number().min(0).max(2).optional().describe("Volume do som do sistema."),
      mic: z.number().min(0).max(2).optional().describe("Volume do microfone."),
      musicVolume: z.number().min(0).max(1).optional(),
      clickSound: z.boolean().optional(),
      clickTone: z.enum(["tick", "soft", "mech"]).optional().describe("Som do clique: clique, suave ou mecânico."),
      keySound: z.boolean().optional(),
      enhance: z.boolean().optional().describe("Melhorar a voz: remove ruído e nivela o microfone. Ligar precisa do app aberto na primeira vez."),
    })
    .optional(),
  captions: z.object({ visible: z.boolean().optional(), size: z.number().min(0.6).max(1.8).optional(), position: z.enum(["bottom", "top"]).optional() }).optional(),
  defaultZoomScale: scaleArg.optional().describe("Aumento padrão de zooms novos."),
};

const defined = <T extends object>(value: T | undefined) =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item !== undefined)) as Partial<T>;

tool(
  "update_settings",
  "Ajusta a aparência e o áudio: proporção, recorte, fundo, moldura, inclinação, cursor, teclas, webcam, volumes, melhoria de voz e legendas. Mande só o que quer mudar.",
  { take: takeArg, ...settingsShape },
  ({ take, ...settings }) =>
    edit(take, async (project, { take: meta, words }) => {
      const changes: string[] = [];
      if (settings.aspect) {
        project.aspect = settings.aspect as Project["aspect"];
        changes.push(`proporção ${settings.aspect}`);
      }
      if (settings.crop !== undefined) {
        project.crop = settings.crop ? area(meta, settings.crop) : null;
        changes.push(settings.crop ? "recorte" : "sem recorte");
      }
      if (settings.background) {
        const background = defined(settings.background);
        project.background = { ...project.background, ...background };
        if (background.preset) project.background.kind = "gradient";
        changes.push("fundo");
      }
      if (settings.frame) {
        project.frame = settings.frame;
        changes.push(`moldura ${settings.frame}`);
      }
      if (settings.tilt !== undefined) {
        project.tilt = settings.tilt;
        changes.push(`inclinação ${settings.tilt}°`);
      }
      if (settings.cursor) {
        project.cursor = { ...project.cursor, ...defined(settings.cursor) };
        changes.push("cursor");
      }
      if (settings.keys) {
        if (settings.keys.visible && !meta.keys) throw new Error("As teclas não foram gravadas nesta gravação.");
        project.keys = { ...project.keys, ...defined(settings.keys) };
        changes.push("teclas");
      }
      if (settings.webcam) {
        if (settings.webcam.visible && !meta.webcam) throw new Error("Esta gravação não tem webcam.");
        const webcam = defined(settings.webcam);
        project.webcam = { ...project.webcam, ...webcam };
        if (webcam.corner && webcam.position === undefined) project.webcam.position = null;
        changes.push("webcam");
      }
      if (settings.audio) {
        const audio = defined(settings.audio);
        if (audio.enhance) {
          if (!meta.mic) throw new Error("Esta gravação não tem microfone.");
          // The enhanced track is made once by the app, then reused.
          if (!store.fileExists(meta, "mic.enhanced.wav")) await appRequest("enhance", { dir: meta.dir }, 15 * 60_000);
        }
        project.audio = { ...project.audio, ...audio };
        changes.push("áudio");
      }
      if (settings.captions) {
        if (settings.captions.visible && !words?.length) throw new Error("Esta gravação não tem transcrição. Chame transcribe primeiro.");
        project.captions = { ...project.captions, ...defined(settings.captions) };
        changes.push("legendas");
      }
      if (settings.defaultZoomScale !== undefined) {
        project.zoom.defaultScale = settings.defaultZoomScale;
        changes.push(`aumento padrão ${settings.defaultZoomScale}×`);
      }
      if (!changes.length) throw new Error("Nenhum ajuste informado.");
      return `ajustes: ${changes.join(", ")}`;
    }),
);

const IMAGE_TYPES = [".png", ".jpg", ".jpeg", ".webp"];
const AUDIO_TYPES = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];
/** A new name each time, so the editor sees the change instead of reusing the old file. */
const assetName = (base: string) => `${base}-${Date.now().toString(36)}`;

tool(
  "set_background_image",
  "Usa uma imagem do computador como fundo do vídeo (PNG, JPG ou WebP). file null volta para o degradê.",
  { take: takeArg, file: z.string().nullable().describe("Caminho completo da imagem, ou null."), blur: z.number().min(0).max(40).optional() },
  ({ take, file, blur }) =>
    edit(take, async (project, { take: meta }) => {
      if (blur !== undefined) project.background.blur = blur;
      if (file === null) {
        project.background.kind = "gradient";
        return "fundo em degradê";
      }
      project.background.image = await store.importAsset(meta, file, assetName("background"), IMAGE_TYPES);
      project.background.kind = "image";
      return `imagem de fundo: ${file.split(/[\\/]/).pop()}`;
    }),
);

tool(
  "set_music",
  "Põe uma música de fundo, que se repete e some no final (MP3, WAV, M4A, AAC, OGG ou FLAC). file null tira a música.",
  { take: takeArg, file: z.string().nullable().describe("Caminho completo do arquivo de áudio, ou null."), volume: z.number().min(0).max(1).optional() },
  ({ take, file, volume }) =>
    edit(take, async (project, { take: meta }) => {
      if (volume !== undefined) project.audio.musicVolume = volume;
      if (file === null) {
        project.audio.music = null;
        return "sem música";
      }
      project.audio.music = await store.importAsset(meta, file, assetName("music"), AUDIO_TYPES);
      return `música: ${file.split(/[\\/]/).pop()}`;
    }),
);

tool(
  "undo_last_edit",
  "Desfaz a última edição feita por esta ferramenta (MCP). Recusa se a edição mudou depois, no editor.",
  { take: takeArg },
  async ({ take: ref }) => {
    const take = await store.findTake(ref);
    await tryApp("flush", { takeId: take.id });
    const label = await store.undoLastEdit(take);
    await tryApp("reload", { takeId: take.id, summary: `IA desfez: ${label}` });
    const { project } = await store.loadProject(take);
    return { take: take.id, undone: label, ...overview(take, project, await store.loadWords(take)) };
  },
);

tool(
  "reset_edit",
  "Volta a edição ao começo: sem cortes, com os zooms automáticos e o estilo padrão. Pode ser desfeito com undo_last_edit.",
  { take: takeArg },
  ({ take }) =>
    edit(take, async (project, { take: meta }) => {
      Object.assign(project, defaultProject(meta, await store.loadCursor(meta)));
      return "edição reiniciada";
    }),
);

tool(
  "rename_take",
  "Muda o nome da gravação na lista do app. Um nome vazio volta para o nome da fonte.",
  { take: takeArg, title: z.string().max(120) },
  async ({ take: ref, title }) => {
    const take = await store.findTake(ref);
    await store.renameTake(take, title);
    await tryApp("reload", { takeId: take.id });
    return { take: take.id, name: store.takeName({ ...take, title: title.trim() || null }) };
  },
);

// ---------- app ----------

type JobView = { id: string; state: "running" | "done" | "error" | "cancelled"; phase: string; done: number; total: number; message: string; result: unknown; elapsedMs: number };

const sleep = (time: number) => new Promise((resolve) => setTimeout(resolve, time));

/** Polls a job in the app, reporting progress to the client, until it ends. */
async function waitJob(jobId: string, extra: Extra, timeoutMs: number, cancellable: boolean): Promise<JobView> {
  const started = Date.now();
  const token = extra._meta?.progressToken;
  let tick = 0;
  let last = "";
  for (;;) {
    if (extra.signal.aborted) {
      if (cancellable) await tryApp("cancel", { jobId });
      throw new Error("Cancelado.");
    }
    const job = await appRequest<JobView>("job", { jobId }, 15_000).catch((error) => {
      throw message(error) === "tarefa não encontrada" ? new Error("A janela do Recorte foi recarregada e a tarefa parou. Tente de novo.") : error;
    });
    if (job.state !== "running") return job;
    const status = job.total ? `${job.phase} ${Math.floor((job.done / job.total) * 100)}%` : job.phase;
    if (token !== undefined && status !== last) {
      last = status;
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++tick, message: status } }).catch(() => {});
    }
    if (Date.now() - started > timeoutMs) {
      if (cancellable) await tryApp("cancel", { jobId });
      throw new Error("A tarefa demorou demais e foi interrompida.");
    }
    await sleep(1000);
  }
}

tool(
  "app_status",
  "Diz se o app Recorte está aberto, qual gravação o editor mostra e quais tarefas estão rodando.",
  {},
  async () => {
    const status = await tryApp<{ openTake: string | null; jobs: unknown[] }>("status");
    return status ? { running: true, ...status } : { running: false, hint: "Abra o Recorte para exportar, transcrever ou ver as edições na hora." };
  },
  true,
);

tool(
  "open_in_editor",
  "Abre a gravação no editor do app e traz a janela para a frente, para o usuário ver o resultado.",
  { take: takeArg },
  async ({ take: ref }) => {
    const take = await store.findTake(ref);
    await appRequest("open", { takeId: take.id });
    return { take: take.id, opened: true };
  },
);

tool(
  "transcribe",
  "Transcreve a fala da gravação com o Whisper, no próprio computador. Precisa do app aberto. Na primeira vez, baixa o modelo (cerca de 80 MB). Os cortes de palavras anteriores são apagados, porque os índices mudam.",
  {
    take: takeArg,
    language: z.enum(["pt", "en", "es", "fr", "de", "it"]).optional().describe("Idioma da fala. Padrão: o último usado no app, ou o idioma do Windows."),
  },
  async ({ take: ref, language }, extra) => {
    const take = await store.findTake(ref);
    if (!take.mic && !take.systemAudio) throw new Error("Esta gravação não tem áudio.");
    const { jobId } = await appRequest<{ jobId: string }>("transcribe", { takeId: take.id, language });
    const job = await waitJob(jobId, extra, 30 * 60_000, false);
    if (job.state !== "done") throw new Error(`A transcrição falhou: ${job.message}`);
    const words = await store.loadWords(take);
    return { take: take.id, words: words?.length ?? 0, seconds: Math.round(job.elapsedMs / 1000), next: "Chame get_transcript para ler o texto." };
  },
);

const even = (value: number) => Math.round(value / 2) * 2;

/** Same destinations as the app's export dialog. */
const PRESET_LIMITS: Record<string, { side: number; fps: number; aspect?: Project["aspect"] }> = {
  youtube: { side: 1920, fps: 60 },
  vertical: { side: 1920, fps: 30, aspect: "9:16" },
  whatsapp: { side: 1280, fps: 30 },
  discord: { side: 1280, fps: 30 },
};

tool(
  "export_video",
  "Exporta o vídeo editado em MP4 (H.264 com áudio) ou GIF, com a mesma imagem da prévia. Precisa do app aberto. Espera terminar e devolve o caminho do arquivo.",
  {
    take: takeArg,
    preset: z.enum(["youtube", "vertical", "whatsapp", "discord"]).optional().describe("Destino: youtube (1080p), vertical (9:16 para Reels, TikTok e Shorts), whatsapp (até 16 MB) ou discord (até 10 MB). Preenche formato, resolução e fps."),
    format: z.enum(["mp4", "gif"]).optional().describe("Padrão: mp4."),
    resolution: z.number().int().optional().describe("Lado maior do vídeo, em px. MP4: 1280, 1920, 2560, 3840 ou o tamanho original. GIF: 480, 640 ou 960. Nunca maior que a gravação. Padrão: 1920 (MP4) ou 640 (GIF)."),
    fps: z.number().int().optional().describe("MP4: 30, 60 ou 120, até o fps da gravação. GIF: 10, 15 ou 20. Padrão: o fps da gravação (MP4) ou 15 (GIF)."),
  },
  async ({ take: ref, preset, format: chosenFormat, resolution, fps }, extra) => {
    const destination = preset ? PRESET_LIMITS[preset] : null;
    const format = destination ? "mp4" : (chosenFormat ?? "mp4");
    const take = await store.findTake(ref);
    await tryApp("flush", { takeId: take.id });
    const { project } = await store.loadProject(take);
    const words = await store.loadWords(take);
    if (store.timeMap(project, words).duration < 100) throw new Error("Nada para exportar: o vídeo editado está vazio.");

    // The same choices the export dialog offers.
    const source = sourceSize(project, take);
    const original = even(Math.max(source.width, source.height));
    const sides = (format === "gif" ? [480, 640, 960] : [1280, 1920, 2560, 3840]).filter((side) => side < original - 8);
    if (format === "mp4" || original <= 960) sides.push(original);
    const longSide = resolution ?? sides.filter((side) => side <= (destination?.side ?? (format === "gif" ? 640 : 1920))).pop() ?? sides[0];
    if (!sides.includes(longSide)) throw new Error(`Resolução ${longSide} não disponível. Opções: ${sides.join(", ")}.`);
    const rates = format === "gif" ? [10, 15, 20] : [30, 60, 120].filter((rate) => rate <= take.fps);
    if (!rates.length) rates.push(take.fps);
    const rate = fps ?? (destination ? (rates.filter((value) => value <= destination.fps).pop() ?? rates[0]) : format === "gif" ? 15 : rates.includes(take.fps) ? take.fps : rates[rates.length - 1]);
    if (!rates.includes(rate)) throw new Error(`${rate} fps não disponível. Opções: ${rates.join(", ")}.`);

    const { jobId } = await appRequest<{ jobId: string }>("export", { takeId: take.id, format, longSide, fps: rate, preset });
    const job = await waitJob(jobId, extra, 4 * 60 * 60_000, true);
    if (job.state === "cancelled") throw new Error("A exportação foi cancelada.");
    if (job.state !== "done") throw new Error(`A exportação falhou: ${job.message}`);
    const file = (job.result as { path: string }).path;
    const size = (await fs.stat(file).catch(() => null))?.size ?? null;
    const output = outputSize(destination?.aspect ?? project.aspect, source, longSide);
    return {
      take: take.id,
      file,
      format,
      size: `${output.width}×${output.height}`,
      fps: rate,
      durationMs: finalDuration(project, words),
      megabytes: size === null ? null : Number((size / 1e6).toFixed(1)),
      seconds: Math.round(job.elapsedMs / 1000),
    };
  },
);

await server.connect(new StdioServerTransport());
