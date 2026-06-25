import { cloneImage } from "./image";
import type { PixelImage } from "./image";

export type DitherMode = "ordered" | "floyd";

// Plain image adjustments applied to a texture as a single image (no tiling /
// seam logic). Brightness/contrast/saturation/hue are in -1..1 (hue in degrees),
// posterizeLevels of 0 disables quantization.
export interface TextureAdjustments {
  brightness: number; // -1..1 (0 = unchanged)
  contrast: number; // -1..1 (0 = unchanged)
  saturation: number; // -1..1 (0 = unchanged, -1 = grayscale)
  hue: number; // degrees, -180..180
  posterizeLevels: number; // 0 = off, else 2..256 levels per channel
  dither: boolean; // ordered/error-diffusion dithering when posterizing
  ditherAmount: number; // 0..1 strength of ordered dithering
  ditherMode: DitherMode;
  grayscale: boolean;
  invert: boolean;
  sharpen: boolean;
}

export const defaultTextureAdjustments: TextureAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  posterizeLevels: 0,
  dither: false,
  ditherAmount: 1,
  ditherMode: "ordered",
  grayscale: false,
  invert: false,
  sharpen: false
};

// 4x4 Bayer matrix (0..15) for ordered dithering.
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
] as const;

const SHARPEN_AMOUNT = 0.8;

// Apply the adjustments to a copy of the source and return the new image. The
// source is never mutated, so callers can keep an untouched original.
export function applyTextureAdjustments(source: PixelImage, settings: Partial<TextureAdjustments> = {}): PixelImage {
  const s = { ...defaultTextureAdjustments, ...settings };
  const { width, height } = source;
  const count = width * height;

  // Float working buffer (RGB); alpha is carried through untouched.
  let rgb: Float32Array = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    rgb[i * 3] = source.data[i * 4] ?? 0;
    rgb[i * 3 + 1] = source.data[i * 4 + 1] ?? 0;
    rgb[i * 3 + 2] = source.data[i * 4 + 2] ?? 0;
  }

  const brightness = s.brightness * 255;
  const contrastFactor = 1 + clampRange(s.contrast, -1, 1);
  const satFactor = s.grayscale ? 0 : 1 + clampRange(s.saturation, -1, 1);
  const hueMatrix = s.hue !== 0 ? hueRotationMatrix(s.hue) : null;

  for (let i = 0; i < count; i += 1) {
    const o = i * 3;
    let r = rgb[o]!;
    let g = rgb[o + 1]!;
    let b = rgb[o + 2]!;

    // Brightness (additive) then contrast (about mid-gray).
    r += brightness; g += brightness; b += brightness;
    r = (r - 127.5) * contrastFactor + 127.5;
    g = (g - 127.5) * contrastFactor + 127.5;
    b = (b - 127.5) * contrastFactor + 127.5;

    // Saturation / grayscale around luma.
    if (satFactor !== 1) {
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      r = luma + (r - luma) * satFactor;
      g = luma + (g - luma) * satFactor;
      b = luma + (b - luma) * satFactor;
    }

    if (hueMatrix) {
      const nr = r * hueMatrix[0]! + g * hueMatrix[1]! + b * hueMatrix[2]!;
      const ng = r * hueMatrix[3]! + g * hueMatrix[4]! + b * hueMatrix[5]!;
      const nb = r * hueMatrix[6]! + g * hueMatrix[7]! + b * hueMatrix[8]!;
      r = nr; g = ng; b = nb;
    }

    if (s.invert) { r = 255 - r; g = 255 - g; b = 255 - b; }

    rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
  }

  if (s.sharpen) rgb = sharpen(rgb, width, height, SHARPEN_AMOUNT);

  const levels = Math.floor(s.posterizeLevels);
  if (levels >= 2) {
    if (s.dither && s.ditherMode === "floyd") {
      floydSteinberg(rgb, width, height, levels);
    } else {
      const amount = s.dither ? clampRange(s.ditherAmount, 0, 1) : 0;
      orderedPosterize(rgb, width, height, levels, amount);
    }
  }

  const out = cloneImage(source);
  for (let i = 0; i < count; i += 1) {
    out.data[i * 4] = clampByte(rgb[i * 3]!);
    out.data[i * 4 + 1] = clampByte(rgb[i * 3 + 1]!);
    out.data[i * 4 + 2] = clampByte(rgb[i * 3 + 2]!);
    // alpha already copied by cloneImage
  }
  return out;
}

// Ordered (Bayer) posterization: nudge each value by a per-pixel threshold
// before snapping to the nearest level so banding breaks into a dot pattern.
function orderedPosterize(rgb: Float32Array, width: number, height: number, levels: number, amount: number): void {
  const step = levels - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const threshold = ((BAYER4[y & 3]![x & 3]! + 0.5) / 16 - 0.5) * amount;
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const v = rgb[o + c]! / 255;
        const level = Math.round(v * step + threshold);
        rgb[o + c] = (clampRange(level, 0, step) / step) * 255;
      }
    }
  }
}

// Floyd–Steinberg error diffusion posterization per channel.
function floydSteinberg(rgb: Float32Array, width: number, height: number, levels: number): void {
  const step = levels - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const old = rgb[o + c]!;
        const quant = (Math.round((old / 255) * step) / step) * 255;
        rgb[o + c] = quant;
        const error = old - quant;
        diffuse(rgb, x + 1, y, c, width, height, error * 7 / 16);
        diffuse(rgb, x - 1, y + 1, c, width, height, error * 3 / 16);
        diffuse(rgb, x, y + 1, c, width, height, error * 5 / 16);
        diffuse(rgb, x + 1, y + 1, c, width, height, error * 1 / 16);
      }
    }
  }
}

function diffuse(rgb: Float32Array, x: number, y: number, c: number, width: number, height: number, value: number): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  rgb[(y * width + x) * 3 + c]! += value;
}

// Unsharp mask: out = v + amount * (4v - neighbors). Edges from a copy so the
// kernel reads unsharpened neighbors.
function sharpen(rgb: Float32Array, width: number, height: number, amount: number): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const center = rgb[o + c]!;
        const left = rgb[(y * width + Math.max(0, x - 1)) * 3 + c]!;
        const right = rgb[(y * width + Math.min(width - 1, x + 1)) * 3 + c]!;
        const up = rgb[(Math.max(0, y - 1) * width + x) * 3 + c]!;
        const down = rgb[(Math.min(height - 1, y + 1) * width + x) * 3 + c]!;
        out[o + c] = center + amount * (4 * center - left - right - up - down);
      }
    }
  }
  return out;
}

function hueRotationMatrix(degrees: number): number[] {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072
  ];
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}
