/**
 * First-run tips: short guided tours that point at the real controls, shown once per tour.
 * Seen tours are remembered per viewer; "Rever dicas" brings them back.
 */

export type Tip = { target: () => HTMLElement | null; title: string; text: string };

const KEY = "recorte.tips";
let active: { close: () => void } | null = null;

function seen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

function markSeen(tour: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...seen(), [tour]: true }));
  } catch {
    // Without storage the tour just shows again next time.
  }
}

export function resetTips() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to reset.
  }
}

/** Runs a tour once. Steps whose target is missing or hidden are skipped. */
export function showTour(tour: string, tips: Tip[]) {
  if (seen()[tour] || active) return;
  const steps = tips.filter((tip) => {
    const element = tip.target();
    return element && element.offsetParent !== null;
  });
  if (!steps.length) return;

  const bubble = document.createElement("div");
  bubble.className = "tip";
  bubble.setAttribute("role", "dialog");
  bubble.setAttribute("aria-live", "polite");
  const ring = document.createElement("div");
  ring.className = "tip-ring";
  document.body.append(ring, bubble);
  let index = 0;

  const finish = () => {
    markSeen(tour);
    window.removeEventListener("resize", place);
    window.removeEventListener("keydown", onKey, true);
    bubble.remove();
    ring.remove();
    active = null;
  };

  function place() {
    const target = steps[index].target();
    if (!target) return;
    const rect = target.getBoundingClientRect();
    ring.style.left = `${rect.left - 4}px`;
    ring.style.top = `${rect.top - 4}px`;
    ring.style.width = `${rect.width + 8}px`;
    ring.style.height = `${rect.height + 8}px`;
    const box = bubble.getBoundingClientRect();
    // Prefer to the right of the target, then below, then above; always on screen.
    let left = rect.right + 14;
    let top = rect.top + rect.height / 2 - box.height / 2;
    let side = "left";
    if (left + box.width > window.innerWidth - 8) {
      left = rect.left + rect.width / 2 - box.width / 2;
      top = rect.bottom + 14;
      side = "top";
      if (top + box.height > window.innerHeight - 8) {
        top = rect.top - box.height - 14;
        side = "bottom";
      }
    }
    bubble.style.left = `${Math.max(8, Math.min(left, window.innerWidth - box.width - 8))}px`;
    bubble.style.top = `${Math.max(8, Math.min(top, window.innerHeight - box.height - 8))}px`;
    bubble.dataset.side = side;
  }

  function render() {
    const step = steps[index];
    const last = index === steps.length - 1;
    bubble.innerHTML = "";
    const count = document.createElement("span");
    count.className = "tip-count";
    count.textContent = `${index + 1} de ${steps.length}`;
    const title = document.createElement("strong");
    title.textContent = step.title;
    const text = document.createElement("p");
    text.textContent = step.text;
    const actions = document.createElement("div");
    actions.className = "tip-actions";
    const skip = document.createElement("button");
    skip.className = "secondary";
    skip.textContent = last ? "" : "Pular dicas";
    skip.hidden = last;
    skip.addEventListener("click", finish);
    const next = document.createElement("button");
    next.className = "primary";
    next.textContent = last ? "Entendi" : "Próxima";
    next.addEventListener("click", () => {
      if (last) finish();
      else {
        index += 1;
        render();
      }
    });
    actions.append(skip, next);
    bubble.append(count, title, text, actions);
    requestAnimationFrame(place);
    next.focus({ preventScroll: true });
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") finish();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  window.addEventListener("resize", place);
  window.addEventListener("keydown", onKey, true);
  active = { close: finish };
  render();
}
