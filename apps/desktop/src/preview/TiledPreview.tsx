import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  PREVIEW_MAX_TILES,
  PREVIEW_MIN_TILES,
  PREVIEW_SCROLL_SPEED
} from "@dinorip/ipc-contracts";
import type { PixelImage, Vec2 } from "@dinorip/core";
import { pixelImageToCanvas } from "../renderer/imageCanvas";

interface TiledPreviewProps {
  image?: PixelImage;
  version: number;
}

export function TiledPreview({ image, version }: TiledPreviewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCanvas = useRef<HTMLCanvasElement | null>(null);
  const [tiles, setTiles] = useState(3);
  const offset = useRef<Vec2>({ x: 0, y: 0 });
  const panning = useRef<Vec2 | null>(null);

  useEffect(() => {
    imageCanvas.current = image ? pixelImageToCanvas(image) : null;
    drawPreview(canvasRef.current, imageCanvas.current, tiles, offset.current);
  }, [image, version, tiles]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => drawPreview(canvas, imageCanvas.current, tiles, offset.current));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [tiles]);

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    setTiles((current) => {
      const direction = event.deltaY < 0 ? -1 : 1;
      return clamp(current + direction * PREVIEW_SCROLL_SPEED, PREVIEW_MIN_TILES, PREVIEW_MAX_TILES);
    });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 1) return;
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
    drawPreview(canvasRef.current, imageCanvas.current, tiles, offset.current);
  };

  const endPan = () => {
    panning.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      className="preview-canvas"
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
  tiles: number,
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
  ctx.fillStyle = "#1f2328";
  ctx.fillRect(0, 0, width, height);

  if (!source) {
    ctx.fillStyle = "rgba(244,244,242,0.55)";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Preview", width / 2, height / 2);
    return;
  }

  const pattern = ctx.createPattern(source, "repeat");
  if (!pattern) return;
  const tileSize = width / tiles;
  ctx.save();
  ctx.translate(offset.x, offset.y);
  ctx.scale(tileSize / source.width, tileSize / source.height);
  ctx.fillStyle = pattern;
  ctx.fillRect(
    -offset.x * source.width / tileSize,
    -offset.y * source.height / tileSize,
    width * source.width / tileSize + source.width,
    height * source.height / tileSize + source.height
  );
  ctx.restore();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
