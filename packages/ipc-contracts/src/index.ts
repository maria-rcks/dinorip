export const IPC_CHANNELS = {
  openImages: "dinorip:open-images",
  savePng: "dinorip:save-png",
  exportAllPng: "dinorip:export-all-png",
  toggleFullscreen: "dinorip:toggle-fullscreen"
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

export interface DinoripApi {
  /** Host platform string from the main process (e.g. "darwin", "win32"). */
  platform: string;
  openImages(): Promise<OpenImagesResult>;
  savePng(request: SavePngRequest): Promise<SaveResult>;
  exportAllPng(request: ExportAllPngRequest): Promise<SaveResult>;
  toggleFullscreen(): Promise<boolean>;
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
