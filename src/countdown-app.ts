import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 3-2-1 over the monitor about to be recorded; closes before capture starts so it isn't in the video. */

const number = document.getElementById("number")!;
const appWindow = getCurrentWindow();
let finished = false;

async function finish(event: "countdown-done" | "countdown-cancelled") {
  if (finished) return;
  finished = true;
  await emit(event, null);
  await appWindow.close();
}

let count = 3;
const timer = window.setInterval(() => {
  count -= 1;
  if (count <= 0) {
    window.clearInterval(timer);
    void finish("countdown-done");
    return;
  }
  number.textContent = String(count);
  number.classList.remove("tick");
  void number.offsetWidth;
  number.classList.add("tick");
}, 1000);
number.classList.add("tick");

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void finish("countdown-cancelled");
  if (event.key === "Enter" || event.key === " ") void finish("countdown-done");
});
window.addEventListener("click", () => void finish("countdown-done"));
document.addEventListener("contextmenu", (event) => event.preventDefault());
void appWindow.setFocus();
