import {
  containsPoint,
  distance,
  lerpVec2,
  makeImage,
  rectFromSize,
  sampleBilinear,
  setPixel
} from "./image";
import type { PixelImage, Vec2 } from "./image";

export interface PolygonRipper {
  points: [Vec2, Vec2, Vec2, Vec2];
}

export interface PlacedImage {
  image: PixelImage;
  position: Vec2;
  scale: Vec2;
}

export interface ExtractionResult {
  image: PixelImage;
  ownerIndex: number;
}

export function createRipper(center: Vec2, size = 100): PolygonRipper {
  const half = size / 2;
  return {
    points: [
      { x: center.x - half, y: center.y + half },
      { x: center.x + half, y: center.y + half },
      { x: center.x + half, y: center.y - half },
      { x: center.x - half, y: center.y - half }
    ]
  };
}

export function inferExtractionSize(ripper: PolygonRipper): { width: number; height: number } {
  const [topLeft, topRight, bottomRight, bottomLeft] = ripper.points;
  const topWidth = distance(topLeft, topRight);
  const bottomWidth = distance(bottomLeft, bottomRight);
  const leftHeight = distance(topLeft, bottomLeft);
  const rightHeight = distance(topRight, bottomRight);

  return {
    width: Math.max(16, Math.round((topWidth + bottomWidth) * 0.5)),
    height: Math.max(16, Math.round((leftHeight + rightHeight) * 0.5))
  };
}

export function extractPerspective(ripper: PolygonRipper, sourceImages: PlacedImage[]): ExtractionResult | null {
  const ownerIndex = findOwnerImageIndex(ripper, sourceImages);
  if (ownerIndex < 0) return null;

  const owner = sourceImages[ownerIndex];
  if (!owner) return null;

  const { width, height } = inferExtractionSize(ripper);
  const output = makeImage(width, height);
  const [topLeft, topRight, bottomRight, bottomLeft] = ripper.points;
  const lastX = Math.max(1, width - 1);
  const lastY = Math.max(1, height - 1);
  const scaleX = owner.scale.x === 0 ? 1 : owner.scale.x;
  const scaleY = owner.scale.y === 0 ? 1 : owner.scale.y;

  for (let y = 0; y < height; y += 1) {
    const v = height === 1 ? 1 : 1 - y / lastY;
    for (let x = 0; x < width; x += 1) {
      const u = width === 1 ? 0 : x / lastX;
      const top = lerpVec2(topLeft, topRight, u);
      const bottom = lerpVec2(bottomLeft, bottomRight, u);
      const point = lerpVec2(bottom, top, v);
      const localX = (point.x - owner.position.x) / scaleX;
      const localY = (point.y - owner.position.y) / scaleY;
      const srcU = localX / owner.image.width + 0.5;
      const srcV = localY / owner.image.height + 0.5;
      setPixel(output, x, y, sampleBilinear(owner.image, srcU, srcV));
    }
  }

  return { image: output, ownerIndex };
}

export function findOwnerImageIndex(ripper: PolygonRipper, sourceImages: PlacedImage[]): number {
  let bestIndex = -1;
  let bestInsideCount = -1;

  sourceImages.forEach((image, index) => {
    const rect = rectFromSize(image.image.width, image.image.height);
    const scaleX = image.scale.x === 0 ? 1 : image.scale.x;
    const scaleY = image.scale.y === 0 ? 1 : image.scale.y;
    const inside = ripper.points.reduce((count, point) => {
      const local = {
        x: (point.x - image.position.x) / scaleX,
        y: (point.y - image.position.y) / scaleY
      };
      return containsPoint(rect, local) ? count + 1 : count;
    }, 0);

    if (inside > bestInsideCount) {
      bestInsideCount = inside;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function pointInsidePolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  let previous = polygon.length - 1;

  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    if (!a || !b) continue;

    const crossesY = (a.y > point.y) !== (b.y > point.y);
    if (crossesY) {
      const intersectionX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < intersectionX) inside = !inside;
    }

    previous = index;
  }

  return inside;
}
