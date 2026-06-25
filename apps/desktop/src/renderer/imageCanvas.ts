import type { IpcPixelImage } from "@dinorip/ipc-contracts";
import { cloneImage, imageFromRgba } from "@dinorip/core";
import type { PixelImage } from "@dinorip/core";

export function pixelImageToCanvas(image: PixelImage): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable.");
  // putImageData only reads the buffer, so back the ImageData with the image's
  // own data instead of copying it (the buffer is never mutated in place). The
  // cast satisfies lib.dom's non-shared ArrayBuffer requirement; our PixelImage
  // buffers are always plain ArrayBuffer-backed.
  const imageData = new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export async function pixelImageFromBlob(blob: Blob): Promise<PixelImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas is unavailable.");
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return imageFromRgba(bitmap.width, bitmap.height, imageData.data);
  } finally {
    bitmap.close();
  }
}

export function fromIpcImage(image: IpcPixelImage): PixelImage {
  return imageFromRgba(image.width, image.height, image.data);
}

export function toIpcImage(image: PixelImage): IpcPixelImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.data)
  };
}

export function cloneForState(image: PixelImage): PixelImage {
  return cloneImage(image);
}
