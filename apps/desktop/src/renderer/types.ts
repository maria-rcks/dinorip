import { defaultTextureAdjustments } from "@dinorip/core";
import type { PixelImage, TextureAdjustments, Vec2 } from "@dinorip/core";

export interface ViewState {
  zoom: number;
  pan: Vec2;
}

// The texture editor stores the core adjustment settings directly.
export type TextureSettings = TextureAdjustments;

export interface WorkspaceImageState {
  id: string;
  name: string;
  image: PixelImage;
  originalImage: PixelImage;
  position: Vec2;
  scale: Vec2;
  settings: TextureSettings;
  version: number;
}

export interface RipperState {
  id: string;
  points: [Vec2, Vec2, Vec2, Vec2];
  outputImageId?: string;
}

export type WorkspaceKind = "source" | "atlas";

export const defaultViewState: ViewState = {
  zoom: 1,
  pan: { x: 0, y: 0 }
};

export const defaultTextureSettings: TextureSettings = { ...defaultTextureAdjustments };
