import { makeImage, sampleBilinear, setPixel } from "./image";
import type { PixelImage, Rect, Vec2 } from "./image";

export interface AtlasItem {
  image: PixelImage;
  position: Vec2;
  scale: Vec2;
}

export interface AtlasRasterResult {
  image: PixelImage;
  bounds: Rect;
}

export function computeAtlasBounds(items: AtlasItem[]): Rect {
  if (items.length === 0) {
    return { xMin: 0, yMin: 0, width: 1, height: 1 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const width = Math.max(1, Math.round(item.image.width * Math.abs(item.scale.x)));
    const height = Math.max(1, Math.round(item.image.height * Math.abs(item.scale.y)));
    minX = Math.min(minX, item.position.x - width / 2);
    maxX = Math.max(maxX, item.position.x + width / 2);
    minY = Math.min(minY, item.position.y - height / 2);
    maxY = Math.max(maxY, item.position.y + height / 2);
  }

  return {
    xMin: minX,
    yMin: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

export function rasterizeAtlas(items: AtlasItem[]): AtlasRasterResult {
  const bounds = computeAtlasBounds(items);
  const atlasWidth = Math.max(1, Math.ceil(bounds.width));
  const atlasHeight = Math.max(1, Math.ceil(bounds.height));
  const output = makeImage(atlasWidth, atlasHeight);
  const yMax = bounds.yMin + bounds.height;

  for (const item of items) {
    const drawWidth = Math.max(1, Math.round(item.image.width * Math.abs(item.scale.x)));
    const drawHeight = Math.max(1, Math.round(item.image.height * Math.abs(item.scale.y)));
    const left = Math.round(item.position.x - bounds.xMin - drawWidth / 2);
    const top = Math.round(yMax - (item.position.y + drawHeight / 2));
    const lastX = Math.max(1, drawWidth - 1);
    const lastY = Math.max(1, drawHeight - 1);

    for (let y = 0; y < drawHeight; y += 1) {
      const destY = top + y;
      if (destY < 0 || destY >= output.height) continue;
      let v = drawHeight === 1 ? 1 : 1 - y / lastY;
      if (item.scale.y < 0) v = 1 - v;

      for (let x = 0; x < drawWidth; x += 1) {
        const destX = left + x;
        if (destX < 0 || destX >= output.width) continue;
        let u = drawWidth === 1 ? 0 : x / lastX;
        if (item.scale.x < 0) u = 1 - u;
        setPixel(output, destX, destY, sampleBilinear(item.image, u, v));
      }
    }
  }

  return { image: output, bounds };
}

export function snapAtlasItem(selected: AtlasItem, neighbors: AtlasItem[], snapDistance: number): Vec2 {
  const selectedEdges = edgesOf(selected);
  const original = selected.position;
  let bestX = original.x;
  let bestY = original.y;
  let bestXDistance = Number.POSITIVE_INFINITY;
  let bestYDistance = Number.POSITIVE_INFINITY;

  const considerX = (a: number, b: number, target: number) => {
    const distance = Math.abs(a - b);
    if (distance <= snapDistance && distance < bestXDistance) {
      bestXDistance = distance;
      bestX = target;
    }
  };

  const considerY = (a: number, b: number, target: number) => {
    const distance = Math.abs(a - b);
    if (distance <= snapDistance && distance < bestYDistance) {
      bestYDistance = distance;
      bestY = target;
    }
  };

  for (const neighbor of neighbors) {
    if (neighbor === selected) continue;
    const e = edgesOf(neighbor);
    considerX(selectedEdges.left, e.right, original.x + (e.right - selectedEdges.left));
    considerX(selectedEdges.right, e.left, original.x + (e.left - selectedEdges.right));
    considerX(selectedEdges.left, e.left, original.x + (e.left - selectedEdges.left));
    considerX(selectedEdges.right, e.right, original.x + (e.right - selectedEdges.right));
    considerY(selectedEdges.top, e.bottom, original.y + (e.bottom - selectedEdges.top));
    considerY(selectedEdges.bottom, e.top, original.y + (e.top - selectedEdges.bottom));
    considerY(selectedEdges.top, e.top, original.y + (e.top - selectedEdges.top));
    considerY(selectedEdges.bottom, e.bottom, original.y + (e.bottom - selectedEdges.bottom));
  }

  return { x: bestX, y: bestY };
}

function edgesOf(item: AtlasItem): { left: number; right: number; top: number; bottom: number } {
  const width = item.image.width * Math.abs(item.scale.x);
  const height = item.image.height * Math.abs(item.scale.y);
  return {
    left: item.position.x - width / 2,
    right: item.position.x + width / 2,
    top: item.position.y + height / 2,
    bottom: item.position.y - height / 2
  };
}
