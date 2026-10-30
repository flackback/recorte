import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * What the server needs from the computer: files, timers, stdin and stdout, and the app's control
 * channel. `recorte.exe --mcp` provides them (src-tauri/src/mcp.rs) and runs this bundle in
 * QuickJS, so no Node.js is needed. This module also fills in the few web APIs QuickJS lacks.
 */

type Reply = { ok: true; value: unknown } | { ok: false; error: string; code: string };
type Host = {
  fs(op: string, a: string, b: string): string;
  env(name: string): string | undefined;
  home(): string;
  videos(): string | undefined;
  cwd(): string;
  write(line: string): void;
  log(text: string): void;
  timer(ms: number): number;
  post(port: number, token: string, body: string, timeoutMs: number): number;
};

declare global {
  var __recorte: Host;
  var __recorteDone: (id: number, ok: boolean, text: string) => void;
  var __recorteLine: (id: number, ok: boolean, line: string) => void;
}

const host = globalThis.__recorte;

// Logs go to stderr: stdout carries only JSON-RPC.
const log = (...args: unknown[]) => host.log(args.map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? (arg.stack ?? arg.message) : JSON.stringify(arg))).join(" "));
globalThis.console ??= { log, info: log, warn: log, error: log, debug: log } as unknown as Console;

/** Waiting timers and requests, by the id the host gave them. */
const waiting = new Map<number, (ok: boolean, text: string) => void>();
globalThis.__recorteDone = (id, ok, text) => {
  const done = waiting.get(id);
  waiting.delete(id);
  done?.(ok, text);
};

type Timer = number;
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms = 0, ...args: unknown[]): Timer => {
  const id = host.timer(ms);
  waiting.set(id, () => callback(...args));
  return id;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((id?: Timer) => {
  if (id !== undefined) waiting.delete(id);
}) as unknown as typeof clearTimeout;

/** The part of AbortController the MCP SDK uses: cancelling a tool call. */
class Signal {
  aborted = false;
  reason: unknown = undefined;
  onabort: (() => void) | null = null;
  private listeners: (() => void)[] = [];
  addEventListener(_type: "abort", listener: () => void) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: "abort", listener: () => void) {
    this.listeners = this.listeners.filter((other) => other !== listener);
  }
  throwIfAborted() {
    if (this.aborted) throw this.reason;
  }
  fire(reason: unknown) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason ?? new Error("cancelado");
    this.onabort?.();
    for (const listener of this.listeners) listener();
  }
}
if (!("AbortController" in globalThis)) {
  (globalThis as Record<string, unknown>).AbortController = class {
    readonly signal = new Signal();
    abort(reason?: unknown) {
      this.signal.fire(reason);
    }
  };
}

function call(op: string, a: string, b = ""): unknown {
  const reply = JSON.parse(host.fs(op, a, b)) as Reply;
  if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code });
  return reply.value;
}

/** Files, with the shape of the `node:fs/promises` calls the server used. */
export const files = {
  readText: async (file: string) => call("read", file) as string,
  writeText: async (file: string, text: string) => void call("write", file, text),
  rename: async (from: string, to: string) => void call("rename", from, to),
  copy: async (from: string, to: string) => void call("copy", from, to),
  makeDir: async (dir: string) => void call("mkdir", dir),
  /** Removes a file; a missing one is not an error. */
  remove: async (file: string) => void call("rm", file),
  list: async (dir: string) => call("list", dir) as string[],
  stat: (file: string) => call("stat", file) as { size: number; file: boolean; dir: boolean } | null,
  exists: (file: string) => call("stat", file) !== null,
};

export const env = (name: string) => host.env(name);
export const homeDir = () => host.home();
/** The user's Videos folder, where Windows has it (it may have been moved). */
export const videosDir = () => host.videos() ?? join(homeDir(), "Videos");

/** Windows paths, the few operations the server needs. */
export function join(...parts: string[]) {
  return normalize(parts.filter(Boolean).join("\\"));
}

function normalize(file: string) {
  const unc = /^[\\/]{2}/.test(file);
  const out: string[] = [];
  for (const part of file.split(/[\\/]+/)) {
    if (part === "." || (part === "" && out.length)) continue;
    if (part === ".." && out.length && out[out.length - 1] !== ".." && !/^[a-zA-Z]:$/.test(out[out.length - 1])) out.pop();
    else out.push(part);
  }
  const joined = out.join("\\");
  return unc ? `\\${joined}` : /^[a-zA-Z]:$/.test(joined) ? `${joined}\\` : joined;
}

export function resolve(file: string) {
  const absolute = /^[a-zA-Z]:[\\/]|^[\\/]{2}/.test(file);
  return normalize(absolute ? file : join(host.cwd(), file));
}

export function extname(file: string) {
  const name = file.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** POSTs to the app's control channel. Rejects with "refused" when nothing listens on the port. */
export function post(port: number, token: string, body: string, timeoutMs: number) {
  return new Promise<string>((resolveReply, reject) => {
    const id = host.post(port, token, body, timeoutMs);
    waiting.set(id, (ok, text) => (ok ? resolveReply(text) : reject(Object.assign(new Error(text), { code: text === "refused" ? "ECONNREFUSED" : "EIO" }))));
  });
}

/** JSON-RPC over the host's stdin and stdout, one message per line. */
export class HostTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start() {
    globalThis.__recorteLine = (_id, _ok, line) => {
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(line));
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.onmessage?.(message);
    };
  }

  async send(message: JSONRPCMessage) {
    host.write(JSON.stringify(message));
  }

  async close() {
    this.onclose?.();
  }
}
