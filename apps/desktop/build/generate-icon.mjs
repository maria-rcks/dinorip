// Generates the DinoRip app icons from the pixel mark.
//
// macOS 26+ (Tahoe / Liquid Glass): the system supplies the squircle shape,
// depth, shadow, and glass lighting at render time, so we ship FLAT layers and
// let the OS do the rest. We emit a `.icon` bundle (Icon Composer format):
//   icon.icon/
//     icon.json            -> solid background fill + the mark as a glass layer
//     Assets/foreground.png-> olive mark on transparent, no baked effects
// electron-builder compiles this via `actool` (needs Xcode 26+) into Assets.car
// and auto-generates a legacy .icns fallback for older macOS.
//
// Windows/Linux don't do Liquid Glass, so they get a plain full-canvas raster
// (icon.png) — also used as the dev/runtime window icon.
//
// Run: node build/generate-icon.mjs
import sharp from "sharp";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;
const OLIVE = "#7A8C5A";
const BROWN = "#2E2A26"; // sRGB 0.18039, 0.16471, 0.14902
const CONTENT = 0.64;    // mark occupies ~64% of the canvas; rest is breathing room

// Olive cells of the original 8x8 mark (bounding box cols 1..6 / rows 1..6).
// The internal gaps stay transparent so the background shows through (the
// notch in the mark), exactly like the source logo.
const CELLS = [
  [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1],
  [1, 2], [3, 2], [4, 2], [5, 2], [6, 2],
  [1, 3], [3, 3], [4, 3], [5, 3], [6, 3],
  [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4],
  [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5],
  [1, 6], [2, 6]
];

function markRects(fill) {
  const mark = SIZE * CONTENT;
  const cell = mark / 6;
  const origin = (SIZE - mark) / 2;
  const b = 0.6; // bleed so cells fuse into one silhouette (no AA seams)
  return CELLS.map(([gx, gy]) => {
    const x = origin + (gx - 1) * cell;
    const y = origin + (gy - 1) * cell;
    return `<rect x="${x - b}" y="${y - b}" width="${cell + 2 * b}" height="${cell + 2 * b}" fill="${fill}"/>`;
  }).join("");
}

function svg(background) {
  const bg = background ? `<rect width="${SIZE}" height="${SIZE}" fill="${background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${bg}${markRects(OLIVE)}</svg>`;
}

async function png(file, background) {
  await sharp(Buffer.from(svg(background))).png().toFile(path.join(DIR, file));
  console.log("Wrote", file);
}

// 1) macOS Liquid Glass .icon bundle (flat foreground layer, no baked effects).
const iconDir = path.join(DIR, "icon.icon");
fs.mkdirSync(path.join(iconDir, "Assets"), { recursive: true });
await sharp(Buffer.from(svg(null)))
  .png()
  .toFile(path.join(iconDir, "Assets", "foreground.png"));

const iconJson = {
  fill: { solid: "srgb:0.18039,0.16471,0.14902,1.00000" }, // #2E2A26 background
  groups: [
    {
      layers: [{ "image-name": "foreground.png", name: "mark", glass: true }],
      shadow: { kind: "neutral", opacity: 0.5 },
      specular: true,
      translucency: { enabled: true, value: 0.5 }
    }
  ],
  "supported-platforms": { squares: ["iOS", "macOS"] }
};
fs.writeFileSync(path.join(iconDir, "icon.json"), JSON.stringify(iconJson, null, 2) + "\n");
console.log("Wrote icon.icon/ (icon.json + Assets/foreground.png)");

// 2) Flat raster for Windows / Linux + the legacy macOS .icns fallback.
await png("icon.png", BROWN);

// 3) Pre-rounded icon for the dev Dock / window icon. macOS does NOT
// auto-squircle a programmatically-set Dock icon (only a packaged app's bundle
// icon), so we bake the macOS look ourselves. Geometry is measured from real
// system icons (App Store / Notes / Helium .icns), which all use the SAME grid:
//   - shape: continuous-corner SUPERELLIPSE (n=5) sized to 80.5% of the canvas
//     (Apple's 824-on-1024 grid). The Dock scales the whole canvas into the
//     tile, so this ~9.8% gutter is what makes the icon the same size as its
//     neighbours. The gutter stays transparent (no baked outer shadow — the
//     Dock adds its own; a baked one fills the gutter and reads as a grey frame).
//   - background: ONE smooth top-lit gradient (no stacked radial/floor layers,
//     which produced visible seams), finished with fine noise dithering to kill
//     8-bit banding in the dark tones.
//   - thin warm rim light on the top edge; foreground mark lifted with a shadow.
const SQ_R = (SIZE * 0.805) / 2;

// Continuous-corner squircle as a sampled superellipse |x|^n + |y|^n = 1.
function superellipsePath(cx, cy, rx, ry, n = 5, steps = 720) {
  const sgn = (v) => (v < 0 ? -1 : 1);
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x = cx + rx * sgn(ct) * Math.pow(Math.abs(ct), 2 / n);
    const y = cy + ry * sgn(st) * Math.pow(Math.abs(st), 2 / n);
    d += `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return d + "Z";
}

const C = SIZE / 2;
const SQ = superellipsePath(C, C, SQ_R, SQ_R);

function roundedSvg() {
  const rim = superellipsePath(C, C, SQ_R - 4, SQ_R - 4); // inset for top edge light
  const mark = SIZE * 0.4; // ~50% of the 80.5% panel, with padding
  const cell = mark / 6;
  const origin = (SIZE - mark) / 2;
  const b = 0.6; // bleed so adjacent cells fuse into one silhouette (no AA seams)
  const cells = CELLS.map(([gx, gy]) => {
    const x = origin + (gx - 1) * cell;
    const y = origin + (gy - 1) * cell;
    return `<rect x="${x - b}" y="${y - b}" width="${cell + 2 * b}" height="${cell + 2 * b}" fill="${OLIVE}"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
    <defs>
      <!-- thin warm edge light so the squircle reads on dark backgrounds -->
      <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff7ea" stop-opacity="0.40"/>
        <stop offset="0.16" stop-color="#fff7ea" stop-opacity="0.07"/>
        <stop offset="0.36" stop-color="#fff7ea" stop-opacity="0"/>
      </linearGradient>
      <filter id="lift" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="6" stdDev="9" flood-color="#000000" flood-opacity="0.28"/>
      </filter>
      <clipPath id="clip"><path d="${SQ}"/></clipPath>
    </defs>
    <path d="${SQ}" fill="${BROWN}"/>
    <g clip-path="url(#clip)"><g filter="url(#lift)">${cells}</g></g>
    <path d="${rim}" fill="none" stroke="url(#rim)" stroke-width="3"/>
  </svg>`;
}

await sharp(Buffer.from(roundedSvg())).png().toFile(path.join(DIR, "icon-rounded.png"));
console.log("Wrote icon-rounded.png");
