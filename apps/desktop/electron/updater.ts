import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import { autoUpdater } from "electron-updater";
import fs from "node:fs";
import path from "node:path";
import type * as Contracts from "@dinorip/ipc-contracts";
import type {
  UpdateActionResult,
  UpdateCheckResult,
  OpenUpdatePageResult,
  UpdateState
} from "@dinorip/ipc-contracts";

const CHANNELS = {
  updateState: "dinorip:update-state",
  getUpdateState: "dinorip:get-update-state",
  checkForUpdate: "dinorip:check-for-update",
  downloadUpdate: "dinorip:download-update",
  installUpdate: "dinorip:install-update",
  openUpdatePage: "dinorip:open-update-page"
} as const satisfies Pick<
  typeof Contracts.IPC_CHANNELS,
  "updateState" | "getUpdateState" | "checkForUpdate" | "downloadUpdate" | "installUpdate" | "openUpdatePage"
>;

const STARTUP_CHECK_DELAY_MS = 2_000;
const UPDATE_POLL_INTERVAL_MS = 30 * 60 * 1000;
const RELEASES_LATEST_URL = "https://github.com/maria-rcks/dinorip/releases/latest";
const RELEASES_TAG_URL = "https://github.com/maria-rcks/dinorip/releases/tag/";
const PERSISTED_UPDATE_STATE_FILE = "update-state.json";

let getMainWindow: () => BrowserWindow | null = () => null;
let registered = false;
let checkInFlight = false;
let downloadInFlight = false;
let installInFlight = false;
let updateInfoReady = false;
let startupTimer: NodeJS.Timeout | undefined;
let pollTimer: NodeJS.Timeout | undefined;

let updateState: UpdateState = createInitialState();

function createInitialState(): UpdateState {
  const disabledReason = getAutoUpdateDisabledReason();
  return {
    enabled: disabledReason === null,
    status: disabledReason === null ? "idle" : "disabled",
    currentVersion: app.getVersion(),
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: disabledReason,
    errorContext: null,
    canRetry: false
  };
}

function getAutoUpdateDisabledReason(): string | null {
  if (process.env.DINORIP_DISABLE_AUTO_UPDATE === "1") {
    return "Automatic updates are disabled by the DINORIP_DISABLE_AUTO_UPDATE setting.";
  }
  if (!app.isPackaged) {
    return "Automatic updates are only available in packaged builds.";
  }
  if (process.platform === "linux" && !process.env.APPIMAGE) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  return null;
}

function currentTimestamp(): string {
  return new Date().toISOString();
}

function parseVersion(version: string): [number, number, number] | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionNewer(version: string, currentVersion: string): boolean {
  const parsed = parseVersion(version);
  const current = parseVersion(currentVersion);
  if (!parsed || !current) return version !== currentVersion;
  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index] !== current[index]) return parsed[index]! > current[index]!;
  }
  return false;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function readVersion(info: unknown): string | null {
  if (typeof info !== "object" || info === null || !("version" in info)) return null;
  const version = (info as { version?: unknown }).version;
  return typeof version === "string" && version.trim().length > 0 ? version : null;
}

function readProgressPercent(info: unknown): number | null {
  if (typeof info !== "object" || info === null || !("percent" in info)) return null;
  const percent = (info as { percent?: unknown }).percent;
  return typeof percent === "number" ? clampPercent(percent) : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "The update operation failed.";
}

function persistedUpdateStatePath(): string {
  return path.join(app.getPath("userData"), PERSISTED_UPDATE_STATE_FILE);
}

function readPersistedUpdateState(base: UpdateState): UpdateState {
  if (!base.enabled) return base;
  try {
    const raw = fs.readFileSync(persistedUpdateStatePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("availableVersion" in parsed)) return base;
    const availableVersion = (parsed as { availableVersion?: unknown }).availableVersion;
    const checkedAt = (parsed as { checkedAt?: unknown }).checkedAt;
    if (typeof availableVersion !== "string" || !isVersionNewer(availableVersion, base.currentVersion)) {
      clearPersistedUpdateState();
      return base;
    }
    return {
      ...base,
      status: "available",
      availableVersion,
      checkedAt: typeof checkedAt === "string" ? checkedAt : null,
      message: null,
      errorContext: null,
      canRetry: false
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Failed to read persisted update state:", error);
    }
    return base;
  }
}

function persistUpdateState(state: UpdateState): void {
  if (!state.enabled) return;
  const version = state.availableVersion ?? state.downloadedVersion;
  if (
    version &&
    isVersionNewer(version, state.currentVersion) &&
    (state.status === "available" || state.status === "downloaded")
  ) {
    try {
      fs.mkdirSync(path.dirname(persistedUpdateStatePath()), { recursive: true });
      fs.writeFileSync(
        persistedUpdateStatePath(),
        JSON.stringify({ availableVersion: version, checkedAt: state.checkedAt }, null, 2)
      );
    } catch (error) {
      console.warn("Failed to persist update state:", error);
    }
    return;
  }

  if (state.status === "up-to-date" || state.status === "disabled") {
    clearPersistedUpdateState();
  }
}

function clearPersistedUpdateState(): void {
  try {
    fs.rmSync(persistedUpdateStatePath(), { force: true });
  } catch (error) {
    console.warn("Failed to clear persisted update state:", error);
  }
}

function broadcastState(): void {
  const windows = new Set(BrowserWindow.getAllWindows());
  const mainWindow = getMainWindow();
  if (mainWindow) windows.add(mainWindow);

  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.updateState, updateState);
  }
}

function setUpdateState(next: UpdateState): UpdateState {
  updateState = next;
  persistUpdateState(updateState);
  broadcastState();
  return updateState;
}

function patchUpdateState(patch: Partial<UpdateState>): UpdateState {
  return setUpdateState({ ...updateState, ...patch });
}

async function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const window = getMainWindow();
  if (window && !window.isDestroyed()) {
    return dialog.showMessageBox(window, options);
  }
  return dialog.showMessageBox(options);
}

function handleUpdateAvailable(info: unknown): void {
  updateInfoReady = true;
  const version = readVersion(info) ?? updateState.availableVersion;
  patchUpdateState({
    status: "available",
    availableVersion: version,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: currentTimestamp(),
    message: null,
    errorContext: null,
    canRetry: false
  });
}

function handleUpdateNotAvailable(): void {
  updateInfoReady = false;
  patchUpdateState({
    status: "up-to-date",
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: currentTimestamp(),
    message: null,
    errorContext: null,
    canRetry: false
  });
}

function handleDownloadProgress(info: unknown): void {
  const percent = readProgressPercent(info);
  if (percent === null) return;
  patchUpdateState({
    status: "downloading",
    downloadPercent: percent,
    message: null,
    errorContext: null,
    canRetry: false
  });
}

function handleUpdateDownloaded(info: unknown): void {
  const version = readVersion(info) ?? updateState.availableVersion ?? updateState.currentVersion;
  patchUpdateState({
    status: "downloaded",
    availableVersion: version,
    downloadedVersion: version,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: true
  });
}

function handleUpdaterError(error: unknown): void {
  const context = installInFlight ? "install" : downloadInFlight ? "download" : "check";
  const hasKnownUpdate = updateState.availableVersion !== null || updateState.downloadedVersion !== null;
  patchUpdateState({
    status: hasKnownUpdate && context !== "install" ? "available" : "error",
    message: errorMessage(error),
    checkedAt: context === "check" ? currentTimestamp() : updateState.checkedAt,
    downloadPercent: null,
    errorContext: context,
    canRetry: context !== "check" && hasKnownUpdate
  });
}

async function checkForUpdates(reason: string): Promise<UpdateCheckResult> {
  if (!updateState.enabled || checkInFlight || downloadInFlight || installInFlight) {
    return { checked: false, state: updateState };
  }
  if (updateState.status === "downloading" || updateState.status === "downloaded") {
    return { checked: false, state: updateState };
  }

  checkInFlight = true;
  patchUpdateState({
    status: "checking",
    checkedAt: currentTimestamp(),
    message: null,
    downloadPercent: null,
    errorContext: null,
    canRetry: false
  });

  try {
    await autoUpdater.checkForUpdates();
    return { checked: true, state: updateState };
  } catch (error) {
    console.error(`Failed to check for updates (${reason}):`, error);
    handleUpdaterError(error);
    return { checked: true, state: updateState };
  } finally {
    checkInFlight = false;
  }
}

async function ensureUpdateInfoReadyForDownload(): Promise<boolean> {
  if (updateInfoReady) return true;
  checkInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
    return updateInfoReady;
  } catch (error) {
    console.error("Failed to prepare update download:", error);
    handleUpdaterError(error);
    return false;
  } finally {
    checkInFlight = false;
  }
}

async function downloadUpdate(): Promise<UpdateActionResult> {
  const canDownload = updateState.status === "available" || (
    updateState.status === "error" &&
    updateState.errorContext === "download" &&
    updateState.availableVersion !== null
  );

  if (!updateState.enabled || checkInFlight || downloadInFlight || installInFlight || !canDownload) {
    return { accepted: false, completed: false, state: updateState };
  }

  if (!(await ensureUpdateInfoReadyForDownload())) {
    return { accepted: true, completed: false, state: updateState };
  }

  downloadInFlight = true;
  patchUpdateState({
    status: "downloading",
    downloadPercent: 0,
    message: null,
    errorContext: null,
    canRetry: false
  });

  try {
    await autoUpdater.downloadUpdate();
    return { accepted: true, completed: updateState.status === "downloaded", state: updateState };
  } catch (error) {
    console.error("Failed to download update:", error);
    handleUpdaterError(error);
    return { accepted: true, completed: false, state: updateState };
  } finally {
    downloadInFlight = false;
  }
}

async function installUpdate(): Promise<UpdateActionResult> {
  const canInstall = updateState.status === "downloaded" || (
    updateState.status === "error" &&
    updateState.errorContext === "install" &&
    updateState.downloadedVersion !== null
  );

  if (!updateState.enabled || installInFlight || !canInstall) {
    return { accepted: false, completed: false, state: updateState };
  }

  installInFlight = true;
  try {
    autoUpdater.quitAndInstall(true, true);
    return { accepted: true, completed: false, state: updateState };
  } catch (error) {
    console.error("Failed to install update:", error);
    handleUpdaterError(error);
    installInFlight = false;
    return { accepted: true, completed: false, state: updateState };
  }
}

function updatePageUrl(): string {
  return updateState.availableVersion
    ? `${RELEASES_TAG_URL}v${encodeURIComponent(updateState.availableVersion)}`
    : RELEASES_LATEST_URL;
}

async function openUpdatePage(): Promise<OpenUpdatePageResult> {
  const url = updatePageUrl();
  try {
    await shell.openExternal(url);
    return { opened: true, url, state: updateState };
  } catch (error) {
    const state = patchUpdateState({
      message: errorMessage(error),
      canRetry: true
    });
    return { opened: false, url, state };
  }
}

export async function checkForUpdatesFromMenu(): Promise<void> {
  const result = await checkForUpdates("menu");

  if (!result.checked && !updateState.enabled) {
    await showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: updateState.message ?? "This build cannot check for updates.",
      buttons: ["OK"]
    });
    return;
  }

  if (!result.checked && updateState.status === "checking") {
    await showMessageBox({
      type: "info",
      title: "Already checking",
      message: "DinoRip is already checking for updates.",
      buttons: ["OK"]
    });
    return;
  }

  if (!result.checked && updateState.status === "downloading") {
    await showMessageBox({
      type: "info",
      title: "Update download in progress",
      message: "DinoRip is already downloading the update.",
      buttons: ["OK"]
    });
    return;
  }

  if (!result.checked && updateState.status === "downloaded") {
    await showMessageBox({
      type: "info",
      title: "Update ready",
      message: "A DinoRip update has already downloaded and is ready to install.",
      detail: "Use the update notice in the top bar to restart and install it.",
      buttons: ["OK"]
    });
    return;
  }

  if (updateState.status === "up-to-date") {
    await showMessageBox({
      type: "info",
      title: "DinoRip is up to date",
      message: `DinoRip ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"]
    });
    return;
  }

  if (updateState.status === "available") {
    await showMessageBox({
      type: "info",
      title: "Update available",
      message: `DinoRip ${updateState.availableVersion ?? "update"} is available.`,
      detail: "Use the update notice in the top bar to download it.",
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0
    });
    return;
  }

  if (updateState.status === "error") {
    await showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred.",
      buttons: ["OK"]
    });
  }
}

function scheduleAutomaticChecks(): void {
  startupTimer = setTimeout(() => void checkForUpdates("startup"), STARTUP_CHECK_DELAY_MS);
  startupTimer.unref?.();

  pollTimer = setInterval(() => void checkForUpdates("poll"), UPDATE_POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

export function configureUpdates(getWindow: () => BrowserWindow | null): void {
  getMainWindow = getWindow;
  if (registered) return;
  registered = true;

  updateState = readPersistedUpdateState(createInitialState());

  ipcMain.handle(CHANNELS.getUpdateState, async (): Promise<UpdateState> => updateState);
  ipcMain.handle(CHANNELS.checkForUpdate, async (): Promise<UpdateCheckResult> => checkForUpdates("renderer"));
  ipcMain.handle(CHANNELS.downloadUpdate, async (): Promise<UpdateActionResult> => downloadUpdate());
  ipcMain.handle(CHANNELS.installUpdate, async (): Promise<UpdateActionResult> => installUpdate());
  ipcMain.handle(CHANNELS.openUpdatePage, async (): Promise<OpenUpdatePageResult> => openUpdatePage());

  if (!updateState.enabled) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("update-available", handleUpdateAvailable);
  autoUpdater.on("update-not-available", handleUpdateNotAvailable);
  autoUpdater.on("download-progress", handleDownloadProgress);
  autoUpdater.on("update-downloaded", handleUpdateDownloaded);
  autoUpdater.on("error", handleUpdaterError);

  app.once("before-quit", () => {
    if (startupTimer) clearTimeout(startupTimer);
    if (pollTimer) clearInterval(pollTimer);
  });

  scheduleAutomaticChecks();
}
