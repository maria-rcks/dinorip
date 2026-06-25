import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
    strictPort: true
  }
});
