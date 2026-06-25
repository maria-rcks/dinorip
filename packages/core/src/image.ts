/**
 * PixelImage stores RGBA bytes in Canvas/ImageData order: row-major with row 0
 * at the visual top. Public UV-based sampling is y-up to match the Unity
 * Texture2D convention used by the decomp notes: v=0 is bottom, v=1 is top.
 */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  xMin: number;
  yMin: number;
  width: number;
  height: number;
}

export function makeImage(width: number, height: number, fill: Color = transparent()): PixelImage {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const data = new Uint8ClampedArray(safeWidth * safeHeight * 4);
  for (let i = 0; i < safeWidth * safeHeight; i += 1) {
    const offset = i * 4;
    data[offset] = clampByte(fill.r);
    data[offset + 1] = clampByte(fill.g);
    data[offset + 2] = clampByte(fill.b);
    data[offset + 3] = clampByte(fill.a);
  }
  return { width: safeWidth, height: safeHeight, data };
}

export function imageFromRgba(width: number, height: number, data: Uint8Array | Uint8ClampedArray): PixelImage {
  const expected = width * height * 4;
  if (data.byteLength !== expected) {
    throw new Error(`Invalid RGBA buffer length. Expected ${expected}, got ${data.byteLength}.`);
  }
  return { width, height, data: new Uint8ClampedArray(data) };
}

export function cloneImage(image: PixelImage): PixelImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data)
  };
}

export function transparent(): Color {
  return { r: 0, g: 0, b: 0, a: 0 };
}

export function opaque(r: number, g: number, b: number): Color {
  return { r, g, b, a: 255 };
}

export function pixelIndex(image: PixelImage, x: number, y: number): number {
  return (y * image.width + x) * 4;
}

export function getPixel(image: PixelImage, x: number, y: number): Color {
  const px = clampInt(Math.round(x), 0, image.width - 1);
  const py = clampInt(Math.round(y), 0, image.height - 1);
  const offset = pixelIndex(image, px, py);
  return {
    r: image.data[offset] ?? 0,
    g: image.data[offset + 1] ?? 0,
    b: image.data[offset + 2] ?? 0,
    a: image.data[offset + 3] ?? 0
  };
}

export function setPixel(image: PixelImage, x: number, y: number, color: Color): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = pixelIndex(image, x, y);
  image.data[offset] = clampByte(color.r);
  image.data[offset + 1] = clampByte(color.g);
  image.data[offset + 2] = clampByte(color.b);
  image.data[offset + 3] = clampByte(color.a);
}

export function sampleBilinear(image: PixelImage, u: number, v: number): Color {
  const safeU = clamp01(u);
  const safeV = clamp01(v);
  const x = image.width === 1 ? 0 : safeU * (image.width - 1);
  const y = image.height === 1 ? 0 : (1 - safeV) * (image.height - 1);

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;

  const c00 = getPixel(image, x0, y0);
  const c10 = getPixel(image, x1, y0);
  const c01 = getPixel(image, x0, y1);
  const c11 = getPixel(image, x1, y1);

  return {
    r: lerp(lerp(c00.r, c10.r, tx), lerp(c01.r, c11.r, tx), ty),
    g: lerp(lerp(c00.g, c10.g, tx), lerp(c01.g, c11.g, tx), ty),
    b: lerp(lerp(c00.b, c10.b, tx), lerp(c01.b, c11.b, tx), ty),
    a: lerp(lerp(c00.a, c10.a, tx), lerp(c01.a, c11.a, tx), ty)
  };
}

export function resizeBilinear(source: PixelImage, width: number, height: number): PixelImage {
  const output = makeImage(width, height);
  const lastX = Math.max(1, output.width - 1);
  const lastY = Math.max(1, output.height - 1);

  for (let y = 0; y < output.height; y += 1) {
    const v = output.height === 1 ? 1 : 1 - y / lastY;
    for (let x = 0; x < output.width; x += 1) {
      const u = output.width === 1 ? 0 : x / lastX;
      setPixel(output, x, y, sampleBilinear(source, u, v));
    }
  }

  return output;
}

export function flipVertical(source: PixelImage): PixelImage {
  const output = makeImage(source.width, source.height);
  const rowLength = source.width * 4;
  for (let y = 0; y < source.height; y += 1) {
    const from = (source.height - 1 - y) * rowLength;
    output.data.set(source.data.subarray(from, from + rowLength), y * rowLength);
  }
  return output;
}

export function offsetWrap(source: PixelImage, offsetX: number, offsetY: number): PixelImage {
  const output = makeImage(source.width, source.height);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sx = wrapInt(x + offsetX, source.width);
      const sy = wrapInt(y + offsetY, source.height);
      setPixel(output, x, y, getPixel(source, sx, sy));
    }
  }
  return output;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpColor(a: Color, b: Color, t: number): Color {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
    a: lerp(a.a, b.a, t)
  };
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerpVec2(a: Vec2, b: Vec2, t: number): Vec2 {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t)
  };
}

export function containsPoint(rect: Rect, point: Vec2): boolean {
  return point.x >= rect.xMin &&
    point.x <= rect.xMin + rect.width &&
    point.y >= rect.yMin &&
    point.y <= rect.yMin + rect.height;
}

export function rectFromSize(width: number, height: number): Rect {
  return {
    xMin: -width / 2,
    yMin: -height / 2,
    width,
    height
  };
}

export function colorNear(a: Color, b: Color, tolerance = 1): boolean {
  return Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance &&
    Math.abs(a.a - b.a) <= tolerance;
}

function wrapInt(value: number, size: number): number {
  return ((value % size) + size) % size;
}
