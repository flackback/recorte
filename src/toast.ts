const DURATION = 4000;

/** Brief confirmation at the bottom of the stage, optionally with one action such as "Desfazer". */
export function toast(message: string, action?: { label: string; run: () => void }) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const element = document.createElement("div");
  element.className = "toast";
  element.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = message;
  element.append(text);

  const dismiss = () => {
    if (element.classList.contains("leaving")) return;
    element.classList.add("leaving");
    window.setTimeout(() => element.remove(), 150);
  };
  if (action) {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.addEventListener("click", () => {
      action.run();
      dismiss();
    });
    element.append(button);
  }

  // Keep at most two on screen; the newest replaces the oldest.
  while (host.children.length >= 2) host.firstElementChild?.remove();
  host.append(element);
  window.setTimeout(dismiss, DURATION);
}
