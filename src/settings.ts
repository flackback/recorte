import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { toast } from "./toast";
import { autoUpdateEnabled, setAutoUpdate, type Updates } from "./updates";

/** Configurações: AI (MCP) connection, recording, updates and about. */

const REPO = "https://github.com/flackback/recorte";

type Client = { installed: boolean; connected: boolean; otherPath: string | null };
type AiStatus = {
  enabled: boolean;
  port: number | null;
  serverPath: string;
  serverFound: boolean;
  claudeCode: Client;
  claudeDesktop: Client;
  command: string;
  config: string;
};

const PROMPTS = [
  "Transcreva a última gravação em português, corte os silêncios e os “hã”, aplique o estilo Tutorial e exporte em 1080p.",
  "Faça uma versão vertical da última gravação para Reels, com legendas em cima, e exporte.",
  "Desfoque o e-mail no canto superior direito da última gravação entre 12 s e 20 s.",
  "Acelere em 4× os trechos em que só estou digitando e ponha uma abertura com o título “Como configurar o relatório”.",
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Settings {
  private ui = {
    modal: $("settings-modal"),
    nav: document.querySelector<HTMLElement>(".settings-nav")!,
    close: $<HTMLButtonElement>("settings-close"),
    aiEnabled: $<HTMLInputElement>("ai-enabled"),
    checks: $("ai-checks"),
    prompts: $("ai-prompts"),
    command: $("ai-command"),
    config: $("ai-config"),
    takesFolder: $("takes-folder"),
    takesFolderOpen: $<HTMLButtonElement>("takes-folder-open"),
    tips: $<HTMLButtonElement>("settings-tips"),
    version: $("settings-version"),
    autoUpdate: $<HTMLInputElement>("auto-update"),
    check: $<HTMLButtonElement>("settings-check"),
    changes: $<HTMLButtonElement>("settings-changes"),
    aboutVersion: $("about-version"),
    repo: $<HTMLButtonElement>("about-repo"),
    slice: $<HTMLButtonElement>("about-slice"),
    shortcuts: $<HTMLButtonElement>("about-shortcuts"),
  };
  private returnFocus: HTMLElement | null = null;

  constructor(updates: Updates, actions: { resetTips(): void; showShortcuts(): void }) {
    const ui = this.ui;
    for (const button of ui.nav.querySelectorAll<HTMLButtonElement>("[data-section]")) {
      button.addEventListener("click", () => this.show(button.dataset.section!));
    }
    ui.close.addEventListener("click", () => this.close());
    ui.modal.addEventListener("click", (event) => {
      if (event.target === ui.modal) this.close();
    });
    ui.modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
      event.stopPropagation();
    });

    ui.aiEnabled.addEventListener("change", async () => {
      try {
        await invoke("ai_set_enabled", { on: ui.aiEnabled.checked });
      } catch (error) {
        ui.aiEnabled.checked = !ui.aiEnabled.checked;
        toast(String(error));
        return;
      }
      toast(ui.aiEnabled.checked ? "A IA pode usar o Recorte" : "A IA não pode mais usar o Recorte");
      void this.refreshAi();
    });
    ui.prompts.replaceChildren(
      ...PROMPTS.map((prompt) => {
        const item = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = prompt;
        item.append(text, this.copyButton(() => prompt, "Copiar pedido"));
        return item;
      }),
    );
    for (const button of ui.modal.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
      button.addEventListener("click", () => void this.copy($(button.dataset.copy!).textContent ?? ""));
    }

    ui.takesFolderOpen.addEventListener("click", () => void invoke("takes_dir_open").catch((error) => toast(`Não foi possível abrir a pasta: ${error}`)));
    ui.tips.addEventListener("click", () => {
      actions.resetTips();
      toast("As dicas aparecem de novo ao abrir o app e a próxima gravação.");
    });
    ui.autoUpdate.addEventListener("change", () => setAutoUpdate(ui.autoUpdate.checked));
    ui.check.addEventListener("click", () => void updates.check(true));
    ui.changes.addEventListener("click", () => void openUrl(`${REPO}/releases`));
    ui.repo.addEventListener("click", () => void openUrl(`${REPO}#créditos`));
    ui.slice.addEventListener("click", () => void openUrl("https://github.com/rit3zh/Slice"));
    ui.shortcuts.addEventListener("click", () => {
      this.close();
      actions.showShortcuts();
    });
  }

  get isOpen() {
    return !this.ui.modal.hidden;
  }

  async open(section = "ai") {
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.ui.modal.hidden = false;
    this.show(section);
    const version = await getVersion();
    this.ui.version.textContent = version;
    this.ui.aboutVersion.textContent = version;
    this.ui.autoUpdate.checked = autoUpdateEnabled();
    this.ui.takesFolder.textContent = await invoke<string>("takes_dir").catch(() => "");
    await this.refreshAi();
  }

  close() {
    this.ui.modal.hidden = true;
    this.returnFocus?.focus();
  }

  private show(section: string) {
    for (const button of this.ui.nav.querySelectorAll<HTMLButtonElement>("[data-section]")) {
      button.setAttribute("aria-current", String(button.dataset.section === section));
    }
    for (const panel of this.ui.modal.querySelectorAll<HTMLElement>("[data-panel]")) panel.hidden = panel.dataset.panel !== section;
    this.ui.nav.querySelector<HTMLButtonElement>(`[data-section="${section}"]`)?.focus();
  }

  private copyButton(text: () => string, label: string) {
    const button = document.createElement("button");
    button.className = "icon-button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = '<svg class="i"><use href="#i-copy" /></svg>';
    button.addEventListener("click", () => void this.copy(text()));
    return button;
  }

  private async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copiado");
    } catch {
      toast("Não foi possível copiar");
    }
  }

  /** One line per requirement, each with its state and, when useful, the action that fixes it. */
  private async refreshAi() {
    const ui = this.ui;
    ui.checks.innerHTML = '<li class="loading"><span class="state"></span><div><strong>Verificando…</strong></div></li>';
    const row =(state: "ok" | "warn" | "off", title: string, detail: string, action?: HTMLElement) => {
      const item = document.createElement("li");
      item.className = state;
      const dot = document.createElement("span");
      dot.className = "state";
      const text = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = title;
      const small = document.createElement("small");
      small.textContent = detail;
      small.title = detail;
      text.append(strong, small);
      item.append(dot, text);
      if (action) item.append(action);
      return item;
    };
    const button = (label: string, run: () => Promise<void>, primary = false) => {
      const element = document.createElement("button");
      element.className = primary ? "primary" : "secondary";
      element.textContent = label;
      element.addEventListener("click", async () => {
        element.disabled = true;
        try {
          await run();
        } catch (error) {
          toast(String(error));
        }
        await this.refreshAi();
      });
      return element;
    };
    const client = (name: string, id: "code" | "desktop", state: Client, restartNote: string) => {
      if (!state.installed) return row("off", name, "Não instalado neste computador");
      if (state.connected) {
        return row("ok", name, `Conectado. ${restartNote}`, button("Desconectar", () => invoke("ai_connect", { client: id, on: false })));
      }
      const detail = state.otherPath ? `Conectado a outra cópia do servidor (${state.otherPath})` : "Ainda não conhece o Recorte";
      return row("warn", name, detail, button(state.otherPath ? "Atualizar" : "Conectar", async () => {
        await invoke("ai_connect", { client: id, on: true });
        toast(`${name} conectado. ${restartNote}`);
      }, true));
    };

    let status: AiStatus;
    try {
      status = await invoke<AiStatus>("ai_status");
    } catch (error) {
      // Without the status there is nothing to list; offer to ask again.
      ui.checks.replaceChildren(row("warn", "Não foi possível verificar a IA", String(error), button("Tentar de novo", async () => undefined)));
      return;
    }
    ui.aiEnabled.checked = status.enabled;
    ui.command.textContent = status.command;
    ui.config.textContent = status.config;

    ui.checks.replaceChildren(
      row(status.enabled ? "ok" : "off", "Canal local", status.enabled ? `Ligado, só neste computador (porta ${status.port ?? "?"})` : "Desligado: a IA não consegue usar o app"),
      row(status.serverFound ? "ok" : "warn", "Servidor MCP", status.serverFound ? "Dentro do Recorte, sem outros programas" : "Arquivo do servidor não encontrado; reinstale o Recorte"),
      client("Claude Code", "code", status.claudeCode, "Vale para as próximas sessões."),
      client("Claude Desktop", "desktop", status.claudeDesktop, "Reinicie o Claude Desktop para ver as ferramentas."),
    );
  }
}
