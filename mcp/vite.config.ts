import { defineConfig } from "vite";

// Bundles the MCP server, with the editor's project model and its dependencies, into one file
// that `recorte.exe --mcp` runs in QuickJS (see mcp/host.ts). Nothing in it may need Node.js.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: "mcp/server.ts",
    outDir: "mcp/dist",
    emptyOutDir: true,
    target: "es2023",
    minify: false,
    rollupOptions: { output: { entryFileNames: "recorte-mcp.mjs", format: "es" } },
  },
  ssr: { noExternal: true, target: "webworker" },
});
