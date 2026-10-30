import { files, post } from "./host";
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
    const value = JSON.parse(await files.readText(CONTROL_FILE)) as Control;
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
  const text = await post(port, token, body, timeoutMs).catch((error: Error & { code?: string }) => {
    throw error.code === "ECONNREFUSED" ? new AppNotRunning() : error;
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
