/**
 * Context menus in the app's own style (the WebView's default menu is turned off), and a small
 * confirmation dialog for actions that can't be undone in place.
 */

export type MenuItem =
  | {
      label: string;
      icon?: string;
      shortcut?: string;
      danger?: boolean;
      /** Disabled items stay visible; the reason shows as a tooltip. */
      disabled?: boolean | string;
      checked?: boolean;
      action: () => void;
    }
  | "separator";

let open: { element: HTMLElement; restore: Element | null; close: () => void } | null = null;

export function closeMenu() {
  open?.close();
}

/** Shows a menu at a viewport point, kept fully on screen. */
export function showMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu();
  const visible = items.filter((item, index) => item !== "separator" || (index > 0 && index < items.length - 1 && items[index - 1] !== "separator"));
  if (!visible.length) return;

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  const buttons: HTMLButtonElement[] = [];

  for (const item of visible) {
    if (item === "separator") {
      const line = document.createElement("div");
      line.className = "menu-separator";
      line.setAttribute("role", "separator");
      menu.append(line);
      continue;
    }
    const button = document.createElement("button");
    button.className = "menu-item";
    button.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
    if (item.checked !== undefined) button.setAttribute("aria-checked", String(item.checked));
    button.classList.toggle("danger", Boolean(item.danger));
    button.disabled = Boolean(item.disabled);
    if (typeof item.disabled === "string") button.title = item.disabled;

    const icon = document.createElement("span");
    icon.className = "menu-icon";
    if (item.checked) icon.innerHTML = '<svg class="i"><use href="#i-check" /></svg>';
    else if (item.icon) icon.innerHTML = `<svg class="i"><use href="#i-${item.icon}" /></svg>`;
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.label;
    button.append(icon, label);
    if (item.shortcut) {
      const shortcut = document.createElement("kbd");
      shortcut.textContent = item.shortcut;
      button.append(shortcut);
    }
    button.addEventListener("click", () => {
      closeMenu();
      item.action();
    });
    buttons.push(button);
    menu.append(button);
  }

  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 6);
  const top = y + rect.height > window.innerHeight - 6 ? Math.max(6, y - rect.height) : y;
  menu.style.left = `${Math.max(6, left)}px`;
  menu.style.top = `${top}px`;

  const enabled = () => buttons.filter((button) => !button.disabled);
  const onKey = (event: KeyboardEvent) => {
    const list = enabled();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") closeMenu();
    else if (event.key === "ArrowDown") list[(index + 1) % list.length]?.focus();
    else if (event.key === "ArrowUp") list[(index - 1 + list.length) % list.length]?.focus();
    else if (event.key === "Home") list[0]?.focus();
    else if (event.key === "End") list[list.length - 1]?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointer = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) closeMenu();
  };
  const onDismiss = () => closeMenu();

  const restore = document.activeElement;
  open = {
    element: menu,
    restore,
    close: () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("wheel", onDismiss, true);
      menu.remove();
      open = null;
      if (restore instanceof HTMLElement) restore.focus({ preventScroll: true });
    },
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("blur", onDismiss);
  window.addEventListener("resize", onDismiss);
  window.addEventListener("wheel", onDismiss, true);
  enabled()[0]?.focus({ preventScroll: true });
}

/** Opens a menu for a contextmenu event, unless the target is a text field. */
export function onContextMenu(element: HTMLElement, build: (event: MouseEvent) => MenuItem[] | null) {
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const items = build(event);
    if (items?.length) showMenu(event.clientX, event.clientY, items);
  });
}

/** Asks before a consequential action. Resolves true when confirmed. */
export function confirmDialog(options: { title: string; message: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal";
    const sheet = document.createElement("div");
    sheet.className = "sheet small";
    sheet.setAttribute("role", "alertdialog");
    sheet.setAttribute("aria-modal", "true");
    const title = document.createElement("h2");
    title.textContent = options.title;
    const message = document.createElement("p");
    message.className = "sheet-message";
    message.textContent = options.message;
    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.className = "secondary";
    cancel.textContent = "Cancelar";
    const confirm = document.createElement("button");
    confirm.className = options.danger ? "primary destructive" : "primary";
    confirm.textContent = options.confirm;
    actions.append(cancel, confirm);
    sheet.append(title, message, actions);
    backdrop.append(sheet);
    document.body.append(backdrop);

    const restore = document.activeElement;
    const finish = (result: boolean) => {
      window.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      if (restore instanceof HTMLElement) restore.focus({ preventScroll: true });
      resolve(result);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(false);
      else if (event.key === "Enter") finish(true);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) finish(false);
    });
    // Safer default: focus Cancel for destructive actions.
    (options.danger ? cancel : confirm).focus();
  });
}
