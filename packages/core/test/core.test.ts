import { describe, expect, it } from "vitest";
import {
  applyTextureAdjustments,
  colorNear,
  computeAtlasBounds,
  createRipper,
  extractPerspective,
  findOwnerImageIndex,
  flipVertical,
  getPixel,
  imageFromRgba,
  inferExtractionSize,
  makeImage,
  makeSeamless,
  offsetWrap,
  opaque,
  pointInsidePolygon,
  rasterizeAtlas,
  sampleBilinear,
  snapAtlasItem,
  setPixel
} from "../src";

describe("sampling", () => {
  it("bilinear samples y-up UVs from top-left row-major image data", () => {
    const image = makeImage(2, 2);
    setPixel(image, 0, 0, opaque(255, 0, 0));
    setPixel(image, 1, 0, opaque(0, 255, 0));
    setPixel(image, 0, 1, opaque(0, 0, 255));
    setPixel(image, 1, 1, opaque(255, 255, 255));

    expect(colorNear(sampleBilinear(image, 0, 1), opaque(255, 0, 0))).toBe(true);
    expect(colorNear(sampleBilinear(image, 1, 0), opaque(255, 255, 255))).toBe(true);
    expect(colorNear(sampleBilinear(image, 0.5, 0.5), { r: 128, g: 128, b: 128, a: 255 }, 1)).toBe(true);
  });

  it("flips vertically", () => {
    const image = imageFromRgba(1, 3, new Uint8ClampedArray([
      10, 0, 0, 255,
      20, 0, 0, 255,
      30, 0, 0, 255
    ]));

    const flipped = flipVertical(image);
    expect(getPixel(flipped, 0, 0).r).toBe(30);
    expect(getPixel(flipped, 0, 1).r).toBe(20);
    expect(getPixel(flipped, 0, 2).r).toBe(10);
  });
});

describe("perspective extraction", () => {
  it("infers output size and samples a quadrilateral over the owner image", () => {
    const source = makeImage(4, 4);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        setPixel(source, x, y, { r: x * 60, g: y * 60, b: 0, a: 255 });
      }
    }

    const ripper = createRipper({ x: 0, y: 0 }, 4);
    const result = extractPerspective(ripper, [{ image: source, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } }]);

    expect(result).not.toBeNull();
    expect(result?.image.width).toBe(16);
    expect(result?.image.height).toBe(16);
    expect(getPixel(result!.image, 0, 0).g).toBeLessThan(getPixel(result!.image, 0, 15).g);
    expect(getPixel(result!.image, 15, 0).r).toBeGreaterThan(getPixel(result!.image, 0, 0).r);
  });

  it("selects the best owner image, including scaled and offset images", () => {
    const imageA = makeImage(20, 20, opaque(255, 0, 0));
    const imageB = makeImage(20, 20, opaque(0, 255, 0));
    const ripper = createRipper({ x: 100, y: 50 }, 20);

    const ownerIndex = findOwnerImageIndex(ripper, [
      { image: imageA, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } },
      { image: imageB, position: { x: 100, y: 50 }, scale: { x: 2, y: 2 } }
    ]);

    expect(ownerIndex).toBe(1);
  });

  it("matches shipped owner fallback when no corners are inside any image", () => {
    const image = makeImage(8, 8, opaque(255, 0, 0));
    const ripper = createRipper({ x: 1000, y: 1000 }, 20);
    expect(findOwnerImageIndex(ripper, [{ image, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } }])).toBe(0);
  });

  it("reports extraction size from average opposing edge lengths", () => {
    const size = inferExtractionSize({
      points: [
        { x: 0, y: 10 },
        { x: 30, y: 10 },
        { x: 20, y: -20 },
        { x: 0, y: -10 }
      ]
    });

    expect(size.width).toBe(26);
    expect(size.height).toBe(26);
  });

  it("uses point-in-polygon hit testing independent of winding", () => {
    const polygon = [
      { x: -10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: -10 },
      { x: -10, y: -10 }
    ];
    expect(pointInsidePolygon({ x: 0, y: 0 }, polygon)).toBe(true);
    expect(pointInsidePolygon({ x: 20, y: 0 }, polygon)).toBe(false);
  });
});

describe("seamless generation", () => {
  it("offset wraps pixels by half width and height", () => {
    const image = imageFromRgba(2, 2, new Uint8ClampedArray([
      10, 0, 0, 255, 20, 0, 0, 255,
      30, 0, 0, 255, 40, 0, 0, 255
    ]));

    const shifted = offsetWrap(image, 1, 1);
    expect(getPixel(shifted, 0, 0).r).toBe(40);
    expect(getPixel(shifted, 1, 1).r).toBe(10);
  });

  it("smoothed collage blends center seams", () => {
    const image = makeImage(8, 8);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        setPixel(image, x, y, opaque(x < 4 ? 20 : 220, y < 4 ? 30 : 230, 100));
      }
    }

    const seamless = makeSeamless(image, {
      method: "SmoothedCollage",
      blendWidth: 1,
      sampleRadius: 0,
      blurRadius: 1,
      restoreDetails: false,
      contrastBoost: 0
    });

    expect(getPixel(seamless, 4, 4).r).toBeGreaterThan(20);
    expect(getPixel(seamless, 4, 4).r).toBeLessThan(220);
  });

  it("scattered edges produces deterministic seam pixels", () => {
    const image = makeImage(8, 8, opaque(50, 100, 150));
    for (let y = 0; y < 8; y += 1) setPixel(image, 0, y, opaque(200, 20, 20));

    const a = makeSeamless(image, {
      method: "ScatteredEdges",
      blendWidth: 2,
      restoreDetails: false,
      contrastBoost: 0
    });
    const b = makeSeamless(image, {
      method: "ScatteredEdges",
      blendWidth: 2,
      restoreDetails: false,
      contrastBoost: 0
    });

    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(getPixel(a, 4, 4).r).toBe(50);
  });
});

describe("texture adjustments", () => {
  it("does not mutate the source and is a no-op with defaults", () => {
    const image = makeImage(4, 4, opaque(80, 120, 200));
    const result = applyTextureAdjustments(image, {});
    expect(getPixel(image, 1, 1)).toEqual({ r: 80, g: 120, b: 200, a: 255 });
    expect(getPixel(result, 1, 1)).toEqual({ r: 80, g: 120, b: 200, a: 255 });
    expect(result).not.toBe(image);
  });

  it("inverts and desaturates", () => {
    const image = makeImage(2, 2, opaque(10, 20, 30));
    expect(getPixel(applyTextureAdjustments(image, { invert: true }), 0, 0)).toEqual({ r: 245, g: 235, b: 225, a: 255 });

    const gray = applyTextureAdjustments(image, { grayscale: true });
    const g = getPixel(gray, 0, 0);
    expect(g.r).toBe(g.g);
    expect(g.g).toBe(g.b);
  });

  it("posterize snaps channels to the requested level count", () => {
    const image = makeImage(8, 1);
    for (let x = 0; x < 8; x += 1) setPixel(image, x, 0, opaque(x * 36, x * 36, x * 36));
    const result = applyTextureAdjustments(image, { posterizeLevels: 2 });
    // With 2 levels every channel collapses to either 0 or 255.
    for (let x = 0; x < 8; x += 1) {
      const v = getPixel(result, x, 0).r;
      expect(v === 0 || v === 255).toBe(true);
    }
  });
});

describe("atlas rasterization", () => {
  it("computes bounds and rasterizes placed images", () => {
    const red = makeImage(4, 4, opaque(255, 0, 0));
    const blue = makeImage(2, 2, opaque(0, 0, 255));
    const items = [
      { image: red, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } },
      { image: blue, position: { x: 4, y: 0 }, scale: { x: 1, y: 1 } }
    ];

    const bounds = computeAtlasBounds(items);
    const raster = rasterizeAtlas(items);

    expect(Math.ceil(bounds.width)).toBe(7);
    expect(Math.ceil(bounds.height)).toBe(4);
    expect(raster.image.width).toBe(7);
    expect(raster.image.height).toBe(4);
    expect(getPixel(raster.image, 0, 0).r).toBe(255);
    expect(getPixel(raster.image, 6, 1).b).toBe(255);
  });

  it("supports negative atlas scale and later items overwrite earlier items", () => {
    const gradient = makeImage(2, 2);
    setPixel(gradient, 0, 0, opaque(10, 0, 0));
    setPixel(gradient, 1, 0, opaque(20, 0, 0));
    setPixel(gradient, 0, 1, opaque(30, 0, 0));
    setPixel(gradient, 1, 1, opaque(40, 0, 0));
    const blue = makeImage(1, 1, opaque(0, 0, 255));

    const raster = rasterizeAtlas([
      { image: gradient, position: { x: 0, y: 0 }, scale: { x: -1, y: -1 } },
      { image: blue, position: { x: 0.5, y: 0.5 }, scale: { x: 1, y: 1 } }
    ]);

    expect(getPixel(raster.image, 0, 0).r).toBe(40);
    expect(getPixel(raster.image, 1, 0).b).toBe(255);
  });

  it("snaps atlas item edges to nearest neighbors", () => {
    const image = makeImage(10, 10, opaque(255, 255, 255));
    const selected = { image, position: { x: 12, y: 0 }, scale: { x: 1, y: 1 } };
    const neighbor = { image, position: { x: 0, y: 0 }, scale: { x: 1, y: 1 } };

    const snapped = snapAtlasItem(selected, [neighbor], 15);
    expect(snapped.x).toBe(10);
    expect(snapped.y).toBe(0);
  });
});
