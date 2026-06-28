export const IPC_CHANNELS = {
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
} as const;

export interface IpcPixelImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface OpenedImage extends IpcPixelImage {
  path: string;
  name: string;
}

export interface OpenImagesResult {
  canceled: boolean;
  images: OpenedImage[];
}

export interface SavePngRequest {
  defaultName: string;
  image: IpcPixelImage;
}

export interface ExportAllPngRequest {
  images: IpcPixelImage[];
}

export interface SaveResult {
  canceled: boolean;
  paths: string[];
}

export interface SaveProjectRequest {
  defaultName: string;
  path?: string;
  contents: string;
}

export interface OpenProjectResult {
  canceled: boolean;
  path?: string;
  contents?: string;
}

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  enabled: boolean;
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface UpdateCheckResult {
  checked: boolean;
  state: UpdateState;
}

export interface UpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: UpdateState;
}

export interface OpenUpdatePageResult {
  opened: boolean;
  url: string;
  state: UpdateState;
}

export type MenuCommand =
  | "open-project"
  | "save-project"
  | "load-image"
  | "export-selected"
  | "export-all"
  | "export-atlas"
  | "select-all"
  | "undo"
  | "redo"
  | "toggle-fullscreen";

export interface DinoripApi {
  /** Host platform string from the main process (e.g. "darwin", "win32"). */
  platform: string;
  openImages(): Promise<OpenImagesResult>;
  savePng(request: SavePngRequest): Promise<SaveResult>;
  exportAllPng(request: ExportAllPngRequest): Promise<SaveResult>;
  saveProject(request: SaveProjectRequest): Promise<SaveResult>;
  openProject(): Promise<OpenProjectResult>;
  onMenuCommand(handler: (command: MenuCommand) => void): () => void;
  toggleFullscreen(): Promise<boolean>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdate(): Promise<UpdateCheckResult>;
  downloadUpdate(): Promise<UpdateActionResult>;
  installUpdate(): Promise<UpdateActionResult>;
  openUpdatePage(): Promise<OpenUpdatePageResult>;
  onUpdateState(handler: (state: UpdateState) => void): () => void;
}

export const RIPPER_SIZE = 100;
export const MIN_EXTRACTED_SIZE = 16;
export const VIEWPORT_ZOOM_SPEED = 0.1;
export const VIEWPORT_MIN_ZOOM = 0.25;
export const VIEWPORT_MAX_ZOOM = 5;
export const IMAGE_SCALE_WHEEL_STEP = 0.05;
export const IMAGE_MIN_SCALE = 0.1;
export const SNAP_DISTANCE = 15;
export const VERTEX_HIT_RADIUS = 12;
export const DEFAULT_BLEND_WIDTH = 32;
export const PREVIEW_MIN_TILES = 1;
export const PREVIEW_MAX_TILES = 20;
export const PREVIEW_SCROLL_SPEED = 0.25;
