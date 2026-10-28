/**
 * Less text on screen: fixed help paragraphs under controls become a small "i" next to the
 * control's name, with the text shown on hover (and read by screen readers). Status messages
 * (hints with an id, which code updates) stay as they are.
 */

/** The element that names what a help paragraph explains. */
function labelFor(hint: HTMLElement): HTMLElement | null {
  const previous = hint.previousElementSibling as HTMLElement | null;
  if (previous?.matches(".switch")) return previous.querySelector("span");
  if (previous?.matches(".slider")) return previous.querySelector(":scope > span");
  const field = previous?.matches(".field") ? previous.querySelector<HTMLElement>(":scope > span") : null;
  if (field) return field;
  // Otherwise the section's title, unless code rewrites it.
  const title = hint.closest("section")?.querySelector<HTMLElement>(":scope > h3");
  return title && !title.id ? title : null;
}

/** Appends the "i" glued to the label's last word, so a wrapping name never leaves it alone on a line. */
function attachToLastWord(label: HTMLElement, info: HTMLElement) {
  const last = label.lastChild;
  const text = last?.nodeType === Node.TEXT_NODE ? (last.textContent ?? "") : "";
  const cut = text.trimEnd().lastIndexOf(" ");
  if (!last || cut < 0) {
    label.append(info);
    return;
  }
  const glue = document.createElement("span");
  glue.className = "nobr";
  glue.append(text.slice(cut + 1).trimEnd(), info);
  last.textContent = text.slice(0, cut + 1);
  label.append(glue);
}

export function tuckHints(root: HTMLElement) {
  for (const hint of root.querySelectorAll<HTMLElement>("p.hint:not([id])")) {
    const text = hint.textContent?.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const label = labelFor(hint);
    if (!label) {
      // Nowhere to put the icon: the text still shows on hover over the control above.
      if (hint.previousElementSibling) (hint.previousElementSibling as HTMLElement).title = text;
      hint.remove();
      continue;
    }
    const info = document.createElement("span");
    info.className = "info";
    info.tabIndex = 0;
    info.title = text;
    info.setAttribute("role", "img");
    info.setAttribute("aria-label", text);
    info.textContent = "i";
    // Before a slider's value, right after its name.
    const output = label.querySelector("output");
    if (output) label.insertBefore(info, output);
    else attachToLastWord(label, info);
    hint.remove();
  }
}

/** Focus rings only for keyboard use, not after clicking. */
export function trackKeyboard() {
  const root = document.documentElement;
  window.addEventListener("keydown", (event) => {
    if (event.key === "Tab") root.classList.add("keyboard");
  });
  window.addEventListener("pointerdown", () => root.classList.remove("keyboard"));
}
