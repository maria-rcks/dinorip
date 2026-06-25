import {
  clamp01,
  cloneImage,
  getPixel,
  lerpColor,
  makeImage,
  offsetWrap,
  setPixel
} from "./image";
import type { Color, PixelImage } from "./image";

export type SeamMethod = "SmoothedCollage" | "ScatteredEdges";

export interface SeamSettings {
  method: SeamMethod;
  blendWidth: number;
  sampleRadius: number;
  blurRadius: number;
  horizontalBlend: boolean;
  verticalBlend: boolean;
  fixCorners: boolean;
  restoreDetails: boolean;
  detailStrength: number;
  contrastBoost: number;
  preAverageIntensity: number;
  preAverageRadius?: number;
}

export const defaultSeamSettings: SeamSettings = {
  method: "SmoothedCollage",
  blendWidth: 32,
  sampleRadius: 0,
  blurRadius: 0,
  horizontalBlend: true,
  verticalBlend: true,
  fixCorners: true,
  restoreDetails: true,
  detailStrength: 0.5,
  contrastBoost: 0.15,
  preAverageIntensity: 0,
  preAverageRadius: 5
};

export function makeSeamless(source: PixelImage, settings: Partial<SeamSettings> = {}): PixelImage {
  const resolved = { ...defaultSeamSettings, ...settings };
  const blendWidth = Math.max(0, Math.floor(resolved.blendWidth));
  const sampleRadius = Math.max(0, Math.floor(resolved.sampleRadius));
  const blurRadius = Math.max(0, Math.floor(resolved.blurRadius));
  const working = resolved.preAverageIntensity > 0
    ? normalizeLighting(source, resolved.preAverageIntensity)
    : cloneImage(source);

  const result = offsetWrap(working, Math.floor(working.width / 2), Math.floor(working.height / 2));

  if (resolved.method === "ScatteredEdges") {
    if (resolved.horizontalBlend) scatterVerticalCenterBand(result, blendWidth);
    if (resolved.verticalBlend) scatterHorizontalCenterBand(result, blendWidth, sampleRadius);
  } else {
    if (resolved.horizontalBlend) blendVerticalCenterBand(result, blendWidth, sampleRadius);
    if (resolved.verticalBlend) blendHorizontalCenterBand(result, blendWidth, sampleRadius);
  }

  if (blurRadius > 0) {
    if (resolved.horizontalBlend) blurVerticalBand(result, blendWidth, blurRadius);
    if (resolved.verticalBlend) blurHorizontalBand(result, blendWidth, blurRadius);
  }

  if (resolved.fixCorners) softenCenterCrossing(result, blendWidth);

  if (resolved.restoreDetails) {
    // The source detail is deliberately sampled from original coordinates. This
    // preserves the shipped pipeline's spatially misaligned detail restore.
    restoreDetailFromOriginal(source, result, resolved.detailStrength);
  }

  applyContrast(result, resolved.contrastBoost);
  return result;
}

export function preAverage(source: PixelImage, intensity: number, radius: number): PixelImage {
  const output = makeImage(source.width, source.height);
  const t = clamp01(intensity / 100);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      setPixel(output, x, y, lerpColor(getPixel(source, x, y), averageNeighborhood(source, x, y, radius), t));
    }
  }
  return output;
}

export function normalizeLighting(source: PixelImage, percent: number): PixelImage {
  const output = cloneImage(source);
  let total = 0;
  const pixels = source.width * source.height;

  for (let i = 0; i < source.data.length; i += 4) {
    total += ((source.data[i] ?? 0) + (source.data[i + 1] ?? 0) + (source.data[i + 2] ?? 0)) / 3;
  }

  const globalLuma = total / pixels;
  const amount = clamp01(percent / 100);

  for (let y = 0; y < output.height; y += 1) {
    for (let x = 0; x < output.width; x += 1) {
      const pixel = getPixel(output, x, y);
      const localLuma = (pixel.r + pixel.g + pixel.b) / 3;
      const correction = (globalLuma - localLuma) * amount;
      setPixel(output, x, y, {
        r: pixel.r + correction,
        g: pixel.g + correction,
        b: pixel.b + correction,
        a: pixel.a
      });
    }
  }

  return output;
}

export function blendVerticalCenterBand(image: PixelImage, width: number, sampleRadius: number): void {
  const centerX = Math.floor(image.width / 2);
  for (let y = 0; y < image.height; y += 1) {
    const left = averageNeighborhood(image, centerX - width, y, sampleRadius);
    const right = averageNeighborhood(image, centerX + width, y, sampleRadius);
    for (let dx = -width; dx <= width; dx += 1) {
      const x = centerX + dx;
      if (x < 0 || x >= image.width) continue;
      const t = width === 0 ? 0.5 : (dx + width) / (width * 2);
      setPixel(image, x, y, lerpColor(left, right, t));
    }
  }
}

export function blendHorizontalCenterBand(image: PixelImage, width: number, sampleRadius: number): void {
  const centerY = Math.floor(image.height / 2);
  for (let x = 0; x < image.width; x += 1) {
    const bottom = averageNeighborhood(image, x, centerY + width, sampleRadius);
    const top = averageNeighborhood(image, x, centerY - width, sampleRadius);
    for (let dy = -width; dy <= width; dy += 1) {
      const y = centerY + dy;
      if (y < 0 || y >= image.height) continue;
      const t = width === 0 ? 0.5 : (dy + width) / (width * 2);
      setPixel(image, x, y, lerpColor(top, bottom, t));
    }
  }
}

export function scatterVerticalCenterBand(image: PixelImage, width: number): void {
  const centerX = Math.floor(image.width / 2);
  for (let y = 0; y < image.height; y += 1) {
    const left = getPixel(image, clampIndex(centerX - width, image.width), y);
    const right = getPixel(image, clampIndex(centerX + width, image.width), y);
    for (let dx = -width; dx <= width; dx += 1) {
      const x = centerX + dx;
      if (x < 0 || x >= image.width) continue;
      setPixel(image, x, y, perlinNoise2D(x * 0.15, y * 0.15) > 0.5 ? left : right);
    }
  }
}

export function scatterHorizontalCenterBand(image: PixelImage, width: number, sampleRadius: number): void {
  const centerY = Math.floor(image.height / 2);
  for (let x = 0; x < image.width; x += 1) {
    const bottom = averageNeighborhood(image, x, centerY - width, sampleRadius);
    const top = averageNeighborhood(image, x, centerY + width, sampleRadius);
    for (let dy = -width; dy <= width; dy += 1) {
      const y = centerY + dy;
      if (y < 0 || y >= image.height) continue;
      setPixel(image, x, y, perlinNoise2D(x * 0.15, y * 0.15) > 0.5 ? bottom : top);
    }
  }
}

export function blurVerticalBand(image: PixelImage, seamWidth: number, blurRadius: number): void {
  const centerX = Math.floor(image.width / 2);
  const snapshot = cloneImage(image);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = centerX - seamWidth - blurRadius; x <= centerX + seamWidth + blurRadius; x += 1) {
      if (x < 0 || x >= image.width) continue;
      setPixel(image, x, y, averageHorizontal(snapshot, x, y, blurRadius));
    }
  }
}

export function blurHorizontalBand(image: PixelImage, seamWidth: number, blurRadius: number): void {
  const centerY = Math.floor(image.height / 2);
  const snapshot = cloneImage(image);
  for (let x = 0; x < image.width; x += 1) {
    for (let y = centerY - seamWidth - blurRadius; y <= centerY + seamWidth + blurRadius; y += 1) {
      if (y < 0 || y >= image.height) continue;
      setPixel(image, x, y, averageVertical(snapshot, x, y, blurRadius));
    }
  }
}

export function softenCenterCrossing(image: PixelImage, radius: number): void {
  const cx = Math.floor(image.width / 2);
  const cy = Math.floor(image.height / 2);
  const center = getPixel(image, cx, cy);
  const safeRadius = Math.max(1, radius);

  for (let oy = -radius; oy <= radius; oy += 1) {
    for (let ox = -radius; ox <= radius; ox += 1) {
      const x = cx + ox;
      const y = cy + oy;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const distance01 = clamp01(Math.hypot(ox, oy) / safeRadius);
      setPixel(image, x, y, lerpColor(center, getPixel(image, x, y), distance01));
    }
  }
}

export function restoreDetailFromOriginal(original: PixelImage, processed: PixelImage, strength: number): void {
  const count = Math.min(original.width * original.height, processed.width * processed.height);
  for (let i = 0; i < count; i += 1) {
    const offset = i * 4;
    processed.data[offset] = clampByte((processed.data[offset] ?? 0) + ((original.data[offset] ?? 0) - 127.5) * strength);
    processed.data[offset + 1] = clampByte((processed.data[offset + 1] ?? 0) + ((original.data[offset + 1] ?? 0) - 127.5) * strength);
    processed.data[offset + 2] = clampByte((processed.data[offset + 2] ?? 0) + ((original.data[offset + 2] ?? 0) - 127.5) * strength);
  }
}

export function applyContrast(image: PixelImage, amount: number): void {
  const factor = 1 + amount;
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = clampByte(((image.data[i] ?? 0) - 127.5) * factor + 127.5);
    image.data[i + 1] = clampByte(((image.data[i + 1] ?? 0) - 127.5) * factor + 127.5);
    image.data[i + 2] = clampByte(((image.data[i + 2] ?? 0) - 127.5) * factor + 127.5);
  }
}

export function averageNeighborhood(image: PixelImage, centerX: number, centerY: number, radius: number): Color {
  const safeRadius = Math.max(0, Math.floor(radius));
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let count = 0;

  for (let oy = -safeRadius; oy <= safeRadius; oy += 1) {
    for (let ox = -safeRadius; ox <= safeRadius; ox += 1) {
      const pixel = getPixel(image, clampIndex(centerX + ox, image.width), clampIndex(centerY + oy, image.height));
      r += pixel.r;
      g += pixel.g;
      b += pixel.b;
      a += pixel.a;
      count += 1;
    }
  }

  return { r: r / count, g: g / count, b: b / count, a: a / count };
}

function averageHorizontal(image: PixelImage, centerX: number, y: number, radius: number): Color {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let count = 0;
  for (let ox = -radius; ox <= radius; ox += 1) {
    const pixel = getPixel(image, clampIndex(centerX + ox, image.width), y);
    r += pixel.r;
    g += pixel.g;
    b += pixel.b;
    a += pixel.a;
    count += 1;
  }
  return { r: r / count, g: g / count, b: b / count, a: a / count };
}

function averageVertical(image: PixelImage, x: number, centerY: number, radius: number): Color {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let count = 0;
  for (let oy = -radius; oy <= radius; oy += 1) {
    const pixel = getPixel(image, x, clampIndex(centerY + oy, image.height));
    r += pixel.r;
    g += pixel.g;
    b += pixel.b;
    a += pixel.a;
    count += 1;
  }
  return { r: r / count, g: g / count, b: b / count, a: a / count };
}

function clampIndex(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.round(value)));
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function perlinNoise2D(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);

  const aa = perm((perm(xi) + yi) & 255);
  const ab = perm((perm(xi) + yi + 1) & 255);
  const ba = perm((perm(xi + 1) + yi) & 255);
  const bb = perm((perm(xi + 1) + yi + 1) & 255);

  const x1 = lerpNumber(gradient(aa, xf, yf), gradient(ba, xf - 1, yf), u);
  const x2 = lerpNumber(gradient(ab, xf, yf - 1), gradient(bb, xf - 1, yf - 1), u);
  return (lerpNumber(x1, x2, v) + 1) * 0.5;
}

function gradient(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0:
      return x + y;
    case 1:
      return -x + y;
    case 2:
      return x - y;
    case 3:
      return -x - y;
    case 4:
      return x;
    case 5:
      return -x;
    case 6:
      return y;
    default:
      return -y;
  }
}

function perm(index: number): number {
  return PERMUTATION[index & 255] ?? 0;
}

const PERMUTATION = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
  140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148,
  247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32,
  57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
  74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122,
  60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54,
  65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169,
  200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64,
  52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212,
  207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213,
  119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9,
  129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104,
  218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241,
  81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
  184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
  222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180
] as const;
