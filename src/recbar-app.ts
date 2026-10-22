import { emit, listen } from "@tauri-apps/api/event";

/**
 * The floating bar shown while recording. It only shows state and sends the user's choices to the
 * main window, which owns the recording.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const time = $("time");
const pause = $<HTMLButtonElement>("pause");
let paused = false;
/** While set, the time shows "Marca n" instead of the elapsed time. */
let flashUntil = 0;

function format(ms: number) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

void listen<{ elapsedMs: number; paused: boolean }>("recbar-state", (event) => {
  paused = event.payload.paused;
  status.classList.toggle("paused", paused);
  if (performance.now() < flashUntil) return;
  time.textContent = paused ? `Pausado · ${format(event.payload.elapsedMs)}` : format(event.payload.elapsedMs);
  pause.querySelector("span")!.textContent = paused ? "Continuar" : "Pausar";
  pause.querySelector("svg")!.innerHTML = paused ? '<path d="M8 5.5v13l10.5-6.5z" />' : '<path d="M9 6v12M15 6v12" />';
});

pause.addEventListener("click", () => void emit("recbar-action", paused ? "resume" : "pause"));
void listen<number>("recbar-mark", (event) => {
  flashUntil = performance.now() + 1200;
  time.textContent = `Marca ${event.payload}`;
});

$("mark").addEventListener("click", () => void emit("recbar-action", "mark"));
$("draw").addEventListener("click", () => void emit("recbar-action", "draw"));
$("stop").addEventListener("click", () => void emit("recbar-action", "stop"));
document.addEventListener("contextmenu", (event) => event.preventDefault());
