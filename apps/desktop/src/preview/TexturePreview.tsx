import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { PixelImage, Vec2 } from "@dinorip/core";
import type { TextureSettings } from "../renderer/types";
import { pixelImageToCanvas } from "../renderer/imageCanvas";

interface TexturePreviewProps {
  // The unedited source texture; adjustments are applied on top so the preview
  // is never cumulative.
  image: PixelImage;
  settings: TextureSettings;
  // Bumps when the underlying texture is re-extracted or resized.
  version: number;
  computeAdjusted(image: PixelImage, settings: TextureSettings): Promise<PixelImage>;
}

// Hold off recomputing while a slider is still being dragged.
const PREVIEW_DEBOUNCE_MS = 90;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.15;

// Single-image live preview of the selected texture with the adjustments
// applied. No tiling or seam logic — just the texture as an image, fit to the
// box, with optional scroll-zoom and drag-pan to inspect detail.
export function TexturePreview({ image, settings, version, computeAdjusted }: TexturePreviewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The image actually painted: the raw texture at first, replaced by the
  // adjusted result once the (debounced) worker job returns.
  const sourceCanvas = useRef<HTMLCanvasElement | null>(null);
  const drawnImage = useRef<PixelImage | null>(null);
  const zoom = useRef(1);
  const offset = useRef<Vec2>({ x: 0, y: 0 });
  const panning = useRef<Vec2 | null>(null);
  // Latest-wins guard: an in-flight worker job whose id no longer matches the
  // current request is discarded so a slow result never overwrites a newer one.
  const requestId = useRef(0);
  const [, forceRedraw] = useState(0);

  const settingsKey = useMemo(() => JSON.stringify(settings), [settings]);

  // Recompute the adjusted preview whenever the texture or its settings change.
  useEffect(() => {
    const runId = requestId.current + 1;
    requestId.current = runId;

    // On a texture swap, paint the raw texture immediately so selecting feels
    // instant (and reset the view); on a pure setting change keep the last frame
    // to avoid flicker. The worker refines to the adjusted result below.
    if (drawnImage.current !== image) {
      drawnImage.current = image;
      zoom.current = 1;
      offset.current = { x: 0, y: 0 };
      sourceCanvas.current = pixelImageToCanvas(image);
      drawPreview(canvasRef.current, sourceCanvas.current, zoom.current, offset.current);
    }

    const timer = window.setTimeout(() => {
      void computeAdjusted(image, settings)
        .then((result) => {
          if (requestId.current !== runId) return;
          sourceCanvas.current = pixelImageToCanvas(result);
          drawPreview(canvasRef.current, sourceCanvas.current, zoom.current, offset.current);
        })
        .catch(() => {
          // Leave the last good frame showing if the adjustment fails.
        });
    }, PREVIEW_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [image, version, settingsKey, computeAdjusted]);

  // Redraw on container resizes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawPreview(canvas, sourceCanvas.current, zoom.current, offset.current);
    const observer = new ResizeObserver(() => drawPreview(canvas, sourceCanvas.current, zoom.current, offset.current));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const redraw = () => drawPreview(canvasRef.current, sourceCanvas.current, zoom.current, offset.current);

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const next = clamp(zoom.current * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === zoom.current) return;
    zoom.current = next;
    if (next === 1) offset.current = { x: 0, y: 0 };
    redraw();
    forceRedraw((n) => n + 1);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (zoom.current <= 1) return;
    if (event.button !== 0 && event.button !== 1) return;
    canvasRef.current?.setPointerCapture(event.pointerId);
    panning.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!panning.current) return;
    offset.current = {
      x: offset.current.x + event.clientX - panning.current.x,
      y: offset.current.y + event.clientY - panning.current.y
    };
    panning.current = { x: event.clientX, y: event.clientY };
    redraw();
  };

  const endPan = () => {
    panning.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      className="texture-preview"
      title="Scroll to zoom · drag to pan when zoomed"
      style={{ cursor: zoom.current > 1 ? "grab" : "default" }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onContextMenu={(event) => event.preventDefault()}
    />
  );
}

function drawPreview(
  canvas: HTMLCanvasElement | null,
  source: HTMLCanvasElement | null,
  zoom: number,
  offset: Vec2
) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#2e2e2e";
  ctx.fillRect(0, 0, width, height);

  if (!source) return;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // "Contain" fit so the whole texture is visible at zoom 1, then scaled by the
  // zoom factor and translated by the pan offset, clamped so it can't be dragged
  // entirely off-screen.
  const fit = Math.min(width / source.width, height / source.height);
  const drawW = source.width * fit * zoom;
  const drawH = source.height * fit * zoom;
  const maxX = Math.max(0, (drawW - width) / 2);
  const maxY = Math.max(0, (drawH - height) / 2);
  const panX = clamp(offset.x, -maxX, maxX);
  const panY = clamp(offset.y, -maxY, maxY);
  const x = (width - drawW) / 2 + panX;
  const y = (height - drawH) / 2 + panY;
  ctx.drawImage(source, x, y, drawW, drawH);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
