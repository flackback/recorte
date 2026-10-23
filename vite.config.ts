import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // Two pages: the app, and the transparent overlay for picking an area and drawing on screen.
  build: {
    rollupOptions: {
      input: { main: "index.html", overlay: "overlay.html", recbar: "recbar.html", countdown: "countdown.html" },
    },
  },
  // Transcription loads this only inside a worker; bundling it up front avoids a full page reload
  // in development the first time it runs.
  optimizeDeps: { include: ["@huggingface/transformers", "@tauri-apps/api/dpi"] },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
