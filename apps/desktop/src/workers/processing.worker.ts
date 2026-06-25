import {
  applyTextureAdjustments,
  extractPerspective,
  rasterizeAtlas
} from "@dinorip/core";
import type { AtlasItem, PixelImage, PlacedImage, PolygonRipper, TextureAdjustments } from "@dinorip/core";

type WorkerRequest =
  | { id: string; type: "extract"; ripper: PolygonRipper; images: PlacedImage[] }
  | { id: string; type: "adjust"; image: PixelImage; settings: TextureAdjustments }
  | { id: string; type: "atlas"; items: AtlasItem[] };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "extract") {
      self.postMessage({ id: request.id, ok: true, result: extractPerspective(request.ripper, request.images) });
      return;
    }

    if (request.type === "adjust") {
      self.postMessage({ id: request.id, ok: true, result: applyTextureAdjustments(request.image, request.settings) });
      return;
    }

    self.postMessage({ id: request.id, ok: true, result: rasterizeAtlas(request.items) });
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
