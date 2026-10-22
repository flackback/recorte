import { defineConfig } from "vite";

// Bundles the MCP server, with the editor's project model and its dependencies, into one file
// that runs with plain Node.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: "mcp/server.ts",
    outDir: "mcp/dist",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: { output: { entryFileNames: "recorte-mcp.mjs", format: "es" } },
  },
  ssr: { noExternal: true, target: "node" },
});
