import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { confirmDialog } from "./menu";
import { toast } from "./toast";

/** How often a running app looks for a new version. */
const CHECK_EVERY = 6 * 60 * 60 * 1000;

/**
 * Looks for new versions on the GitHub releases and installs them on request. The title bar
 * button appears only when there is one.
 */
export class Updates {
  private update: Update | null = null;
  private installing = false;
  private label: HTMLElement;

  /** `busy` returns why updating must wait (recording, exporting), or null. */
  constructor(private button: HTMLButtonElement, private busy: () => string | null) {
    this.label = button.querySelector("span") ?? button;
    button.addEventListener("click", () => void this.install());
  }

  /** Checks now and then periodically. Development builds only check when asked. */
  start() {
    if (import.meta.env.DEV) return;
    window.setTimeout(() => void this.check(), 4000);
    window.setInterval(() => void this.check(), CHECK_EVERY);
  }

  /** `manual` also reports "already up to date" and failures, which a background check keeps quiet. */
  async check(manual = false) {
    if (this.installing) return;
    try {
      const update = await check();
      this.update = update;
      this.button.hidden = !update;
      if (update) {
        this.label.textContent = `Atualizar para ${update.version}`;
        this.button.title = "Uma versão nova do Recorte está pronta para instalar";
        if (manual) void this.install();
      } else if (manual) {
        toast(`Você já tem a versão mais recente (${await getVersion()}).`);
      }
    } catch (error) {
      console.warn("procurar atualizações", error);
      if (manual) toast("Não foi possível procurar atualizações. Confira a internet e tente de novo.");
    }
  }

  private async install() {
    const update = this.update;
    if (!update || this.installing) return;
    const reason = this.busy();
    if (reason) {
      toast(reason);
      return;
    }
    const notes = update.body?.trim();
    const confirmed = await confirmDialog({
      title: `Atualizar para a versão ${update.version}?`,
      message: `${notes ? `${notes}\n\n` : ""}O Recorte fecha, instala a versão nova e abre de novo. Suas gravações e edições continuam iguais.`,
      confirm: "Atualizar",
    });
    if (!confirmed) return;
    this.installing = true;
    this.button.disabled = true;
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        else if (event.event === "Progress") {
          done += event.data.chunkLength;
          this.label.textContent = total ? `Baixando… ${Math.floor((done / total) * 100)}%` : "Baixando…";
        } else this.label.textContent = "Instalando…";
      });
      await relaunch();
    } catch (error) {
      this.installing = false;
      this.button.disabled = false;
      this.label.textContent = `Atualizar para ${update.version}`;
      toast(`A atualização falhou: ${error}`);
    }
  }
}
