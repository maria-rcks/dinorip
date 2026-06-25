import react from "@vitejs/plugin-react";
import path from "node:path";
import { spawn } from "node:child_process";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SHORTCUTS_DATA = path.resolve(__dirname, "src/renderer/shortcuts.data.json");
const SHORTCUTS_DATA_MODULE = path.resolve(__dirname, "src/renderer/shortcutsData.ts");
const SHORTCUTS_SCRIPT = path.resolve(REPO_ROOT, "scripts/generate-readme-shortcuts.mjs");
const SHORTCUTS_ASSETS_DIR = path.resolve(REPO_ROOT, "assets/shortcuts");

// Keep the README's Shortcuts section in sync while developing, and surface
// newly recorded demo GIFs without a restart. The clips live outside the app
// root (so the README can reference them too), which means Vite neither watches
// them nor re-evaluates the import.meta.glob in shortcutsData when one is added.
// This plugin watches that folder and forces a reload when a clip appears.
function shortcutsReadmePlugin(): Plugin {
  return {
    name: "dinorip-shortcuts-readme",
    configureServer(server) {
      server.watcher.add(SHORTCUTS_ASSETS_DIR);
      const onClipChange = (file: string) => {
        if (path.dirname(path.resolve(file)) !== SHORTCUTS_ASSETS_DIR || !file.endsWith(".gif")) return;
        // Invalidate the module holding the glob so it re-scans the folder, then
        // reload the page to pick up the added/removed clip.
        for (const mod of server.moduleGraph.getModulesByFile(SHORTCUTS_DATA_MODULE) ?? []) {
          server.moduleGraph.invalidateModule(mod);
        }
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", onClipChange);
      server.watcher.on("unlink", onClipChange);
    },
    handleHotUpdate({ file }) {
      if (path.resolve(file) !== SHORTCUTS_DATA) return;
      const child = spawn(process.execPath, [SHORTCUTS_SCRIPT], { cwd: REPO_ROOT, stdio: "inherit" });
      child.on("error", (error) => console.error("[shortcuts] README sync failed:", error));
    }
  };
}

export default defineConfig({
  plugins: [react(), shortcutsReadmePlugin()],
  base: "./",
  resolve: {
    alias: {
      "@dinorip/core": path.resolve(__dirname, "../../packages/core/src/index.ts"),
      "@dinorip/ipc-contracts": path.resolve(__dirname, "../../packages/ipc-contracts/src/index.ts")
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // The demo GIFs live at the repo root (assets/shortcuts), outside the app
    // root, so allow the dev server to serve from there.
    fs: { allow: [REPO_ROOT] }
  }
});
