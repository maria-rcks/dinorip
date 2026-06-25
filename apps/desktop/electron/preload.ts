import { contextBridge, ipcRenderer } from "electron";
import type * as Contracts from "@dinorip/ipc-contracts";
import type { ExportAllPngRequest, SavePngRequest, DinoripApi } from "@dinorip/ipc-contracts";

// The channel literals are intentionally inlined. A sandboxed preload
// (sandbox: true) can only require "electron" plus a few Node builtins, so
// importing the workspace package as a *value* would throw at runtime and the
// contextBridge API would never be exposed. The `satisfies` clause keeps these
// in sync with IPC_CHANNELS at compile time using a type-only import that is
// fully erased from the emitted JS.
const CHANNELS = {
  openImages: "dinorip:open-images",
  savePng: "dinorip:save-png",
  exportAllPng: "dinorip:export-all-png",
  toggleFullscreen: "dinorip:toggle-fullscreen"
} as const satisfies typeof Contracts.IPC_CHANNELS;

const api: DinoripApi = {
  platform: process.platform,
  openImages: () => ipcRenderer.invoke(CHANNELS.openImages),
  savePng: (request: SavePngRequest) => ipcRenderer.invoke(CHANNELS.savePng, request),
  exportAllPng: (request: ExportAllPngRequest) => ipcRenderer.invoke(CHANNELS.exportAllPng, request),
  toggleFullscreen: () => ipcRenderer.invoke(CHANNELS.toggleFullscreen)
};

contextBridge.exposeInMainWorld("dinorip", api);
