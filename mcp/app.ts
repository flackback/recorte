import fs from "node:fs/promises";
import http from "node:http";

import { CONTROL_FILE } from "./store";

/** Talks to the running Recorte app through its local control channel. */

export class AppNotRunning extends Error {
  constructor() {
    super("O Recorte não está aberto. Abra o app e tente de novo.");
  }
}

type Control = { port: number; token: string; pid: number };

async function control(): Promise<Control> {
  try {
    const value = JSON.parse(await fs.readFile(CONTROL_FILE, "utf8")) as Control;
    if (value.port && value.token) return value;
  } catch {
    // Missing file: the app is closed.
  }
  throw new AppNotRunning();
}

/** Sends one request; the app answers `{ ok, result | error }`. */
export async function appRequest<T = unknown>(kind: string, payload: Record<string, unknown> = {}, timeoutMs = 70_000): Promise<T> {
  const { port, token } = await control();
  const body = JSON.stringify({ kind, payload });
  const text = await new Promise<string>((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: "/request", method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: timeoutMs },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (data += chunk));
        response.on("end", () => resolve(data));
      },
    );
    request.on("timeout", () => request.destroy(new Error("o Recorte não respondeu a tempo")));
    request.on("error", (error: NodeJS.ErrnoException) => reject(error.code === "ECONNREFUSED" ? new AppNotRunning() : error));
    request.end(body);
  });
  const reply = JSON.parse(text) as { ok: boolean; result?: T; error?: string };
  if (!reply.ok) throw new Error(reply.error ?? "pedido recusado pelo Recorte");
  return reply.result as T;
}

/** Like `appRequest`, but returns null instead of failing when the app is closed or busy. */
export async function tryApp<T = unknown>(kind: string, payload: Record<string, unknown> = {}): Promise<T | null> {
  try {
    return await appRequest<T>(kind, payload, 8_000);
  } catch {
    return null;
  }
}
