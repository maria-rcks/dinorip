import { contextBridge, ipcRenderer } from "electron";
import type * as Contracts from "@dinorip/ipc-contracts";
import type {
  DinoripApi,
  ExportAllPngRequest,
  MenuCommand,
  SavePngRequest,
  SaveProjectRequest
} from "@dinorip/ipc-contracts";

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
  saveProject: "dinorip:save-project",
  openProject: "dinorip:open-project",
  toggleFullscreen: "dinorip:toggle-fullscreen",
  menuCommand: "dinorip:menu-command",
  updateState: "dinorip:update-state",
  getUpdateState: "dinorip:get-update-state",
  checkForUpdate: "dinorip:check-for-update",
  downloadUpdate: "dinorip:download-update",
  installUpdate: "dinorip:install-update",
  openUpdatePage: "dinorip:open-update-page"
} as const satisfies typeof Contracts.IPC_CHANNELS;

const api: DinoripApi = {
  platform: process.platform,
  openImages: () => ipcRenderer.invoke(CHANNELS.openImages),
  savePng: (request: SavePngRequest) => ipcRenderer.invoke(CHANNELS.savePng, request),
  exportAllPng: (request: ExportAllPngRequest) => ipcRenderer.invoke(CHANNELS.exportAllPng, request),
  saveProject: (request: SaveProjectRequest) => ipcRenderer.invoke(CHANNELS.saveProject, request),
  openProject: () => ipcRenderer.invoke(CHANNELS.openProject),
  onMenuCommand: (handler: (command: MenuCommand) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: MenuCommand) => handler(command);
    ipcRenderer.on(CHANNELS.menuCommand, listener);
    return () => ipcRenderer.removeListener(CHANNELS.menuCommand, listener);
  },
  toggleFullscreen: () => ipcRenderer.invoke(CHANNELS.toggleFullscreen),
  getUpdateState: () => ipcRenderer.invoke(CHANNELS.getUpdateState),
  checkForUpdate: () => ipcRenderer.invoke(CHANNELS.checkForUpdate),
  downloadUpdate: () => ipcRenderer.invoke(CHANNELS.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(CHANNELS.installUpdate),
  openUpdatePage: () => ipcRenderer.invoke(CHANNELS.openUpdatePage),
  onUpdateState: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Contracts.UpdateState) => handler(state);
    ipcRenderer.on(CHANNELS.updateState, listener);
    return () => ipcRenderer.removeListener(CHANNELS.updateState, listener);
  }
};

contextBridge.exposeInMainWorld("dinorip", api);
