import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  IMAGE_MIN_SCALE,
  SNAP_DISTANCE,
  VERTEX_HIT_RADIUS,
  VIEWPORT_MAX_ZOOM,
  VIEWPORT_MIN_ZOOM,
  VIEWPORT_ZOOM_SPEED
} from "@dinorip/ipc-contracts";
import { pointInsidePolygon, snapAtlasItem } from "@dinorip/core";
import type { AtlasItem, Vec2 } from "@dinorip/core";
import type { RipperState, ViewState, WorkspaceImageState, WorkspaceKind } from "../renderer/types";
import { pixelImageToCanvas } from "../renderer/imageCanvas";

export interface WorkspaceLivePreview {
  /** The atlas image id this preview stands in for. */
  imageId: string;
  /** GPU canvas holding the live projection; blitted directly with drawImage. */
  canvas: HTMLCanvasElement;
  /** Natural output dimensions used to size the on-screen rect. */
  width: number;
  height: number;
}

/** World-space rectangle (px) describing what the atlas would export. */
export interface ExportRegion {
  /** Left edge in world units. */
  xMin: number;
  /** Top edge in world units (largest y). */
  yMax: number;
  width: number;
  height: number;
}

interface CanvasWorkspaceProps {
  kind: WorkspaceKind;
  title: string;
  emptyLabel: string;
  showHeader?: boolean;
  /** Background fill style: a tiled checkerboard (default) or thin grid lines. */
  background?: "checker" | "grid";
  /** When set (atlas), draws a white outline showing the exported atlas size. */
  exportRegion?: ExportRegion | null;
  images: WorkspaceImageState[];
  rippers?: RipperState[];
  selectedImageId?: string;
  selectedRipperId?: string;
  view: ViewState;
  // Mutable ref holding the live GPU projection to draw in place of a cached
  // image while a ripper is being dragged. Read every animation frame, so
  // updating its `.current` needs no React re-render.
  livePreview?: { readonly current: WorkspaceLivePreview | null };
  onViewChange(view: ViewState): void;
  onSelectImage(id?: string): void;
  onSelectRipper?(id?: string): void;
  // Absolute world-space position the image's centre should move to. Atlas
  // snapping is resolved by the canvas before this is called.
  onMoveImage(id: string, position: Vec2): void;
  onScaleImage(id: string, nextScale: Vec2): void;
  onMoveRipper?(id: string, delta: Vec2): void;
  onMoveVertex?(id: string, index: number, point: Vec2): void;
  /** Batched corner move — used for group drags and Cmd-uniform-scaling. */
  onMoveVertices?(updates: VertexUpdate[]): void;
  onRipperEditStart?(id: string): void;
  onRipperEditEnd?(): void;
  onImageEditStart?(id: string): void;
  onImageEditEnd?(): void;
}

type HandleKey = "tl" | "tr" | "bl" | "br";

type VertexRef = { id: string; index: number };
type VertexUpdate = { id: string; index: number; point: Vec2 };

type DragState =
  | { type: "none" }
  // Pan is anchored to the moment the drag began: `startPointer` is the cursor
  // position and `startPan` the view offset at pointer-down. Each move derives an
  // absolute pan from these (pan = startPan + cursorDelta) instead of accumulating
  // off the live `view.pan`, which lags behind React's render cadence and makes
  // the background jitter when pointer events outpace commits.
  | { type: "pan"; startPointer: Vec2; startPan: Vec2 }
  // An image drag, anchored to pointer-down. `startWorld` is the cursor world
  // position and `startPos` the image centre at grab time; each move derives an
  // absolute target from these (target = startPos + cursorDelta) rather than
  // accumulating off the committed position. Accumulating broke snapping: once
  // an image snapped to a neighbour edge, the snapped position fed the next
  // frame and the image stuck to that edge until the cursor cleared the band in
  // a single frame. From a stable anchor the unsnapped target always tracks the
  // cursor, so snapping engages and releases cleanly.
  | { type: "image"; id: string; startWorld: Vec2; startPos: Vec2 }
  | { type: "resize"; id: string; handle: HandleKey; anchor: Vec2 }
  | { type: "ripper"; id: string; lastWorld: Vec2 }
  // A corner drag. `startWorld`/`startPoints` snapshot the moment the drag began
  // so Cmd-scaling and group moves can be recomputed from a stable baseline
  // (letting Cmd be toggled mid-drag). `group` is every corner that moves with
  // this one (just the grabbed corner unless a multi-selection is active).
  | { type: "vertex"; id: string; index: number; startWorld: Vec2; startPoints: Record<string, Vec2[]>; group: VertexRef[] }
  // Rubber-band box that selects the ripper corners inside it on release.
  | { type: "marquee" };

const HANDLE_SCREEN_SIZE = 8;
const HANDLE_HIT_RADIUS = 9;
const VERTEX_HANDLE_SIZE = 7;
const VERTEX_HANDLE_SELECTED_SIZE = 10;

export function CanvasWorkspace(props: CanvasWorkspaceProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState>({ type: "none" });
  const canvasCache = useRef(new Map<string, { version: number; canvas: HTMLCanvasElement }>());
  const rippers = props.rippers ?? [];
  // Multi-corner selection (keys are `${ripperId}#${index}`). Highlighted on the
  // canvas; dragging any member moves the whole set. Live marquee box is held in
  // a ref so dragging it does not re-render every frame.
  const [selectedVertices, setSelectedVertices] = useState<Set<string>>(() => new Set());
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const selectedImage = useMemo(
    () => props.images.find((image) => image.id === props.selectedImageId),
    [props.images, props.selectedImageId]
  );

  useEffect(() => {
    let animation = 0;
    const renderNow = (time: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      syncCanvasSize(canvas);
      drawWorkspace(ctx, canvas, props, canvasCache.current, time, selectedVertices, marqueeRef.current);
    };
    const draw = (time: number) => {
      renderNow(time);
      animation = requestAnimationFrame(draw);
    };
    renderNow(performance.now());
    animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [props, rippers, selectedImage, selectedVertices]);

  const toWorld = (event: React.PointerEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>): Vec2 => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return screenToWorld({ x, y }, canvas, props.view);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);

    if (event.button === 1) {
      dragRef.current = { type: "pan", startPointer: { x: event.clientX, y: event.clientY }, startPan: props.view.pan };
      setCanvasCursor(canvas, "grabbing");
      return;
    }

    if (event.button !== 0) return;
    const world = toWorld(event);

    // Resize handles take priority over the image body so grabbing a corner of
    // the selected atlas texture scales it instead of moving it.
    if (props.kind === "atlas" && selectedImage) {
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const handle = hitHandle(screen, selectedImage, canvas, props.view);
      if (handle) {
        dragRef.current = { type: "resize", id: selectedImage.id, handle: handle.key, anchor: handle.anchor };
        props.onImageEditStart?.(selectedImage.id);
        setCanvasCursor(canvas, handleCursor(handle.key));
        return;
      }
    }

    const vertexHit = hitVertex(world, rippers, props.view.zoom);
    if (vertexHit && props.onMoveVertex && props.onSelectRipper) {
      const key = vertexKey(vertexHit.ripper.id, vertexHit.index);
      props.onSelectRipper(vertexHit.ripper.id);
      // Shift-click toggles a corner in the multi-selection without starting a
      // drag, so several corners can be gathered before moving them as a group.
      if (event.shiftKey) {
        setSelectedVertices((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        dragRef.current = { type: "none" };
        return;
      }
      // Grabbing a corner that is part of the selection drags the whole group;
      // grabbing any other corner drops the selection and drags just that one.
      const inSelection = selectedVertices.has(key) && selectedVertices.size > 1;
      const group = inSelection ? vertexRefsFromKeys(selectedVertices) : [{ id: vertexHit.ripper.id, index: vertexHit.index }];
      if (!inSelection && selectedVertices.size > 0) setSelectedVertices(new Set());
      dragRef.current = {
        type: "vertex",
        id: vertexHit.ripper.id,
        index: vertexHit.index,
        startWorld: world,
        startPoints: snapshotPoints(rippers, group, vertexHit.ripper.id),
        group
      };
      props.onRipperEditStart?.(vertexHit.ripper.id);
      setCanvasCursor(canvas, "pointer");
      return;
    }

    const ripperHit = hitRipper(world, rippers);
    if (ripperHit && props.onMoveRipper && props.onSelectRipper) {
      props.onSelectRipper(ripperHit.id);
      if (selectedVertices.size > 0) setSelectedVertices(new Set());
      dragRef.current = { type: "ripper", id: ripperHit.id, lastWorld: world };
      props.onRipperEditStart?.(ripperHit.id);
      setCanvasCursor(canvas, "grabbing");
      return;
    }

    const imageHit = hitImage(world, props.images);
    if (imageHit) {
      props.onSelectImage(imageHit.id);
      const shouldDrag = props.kind === "atlas" || event.shiftKey;
      if (shouldDrag) {
        dragRef.current = { type: "image", id: imageHit.id, startWorld: world, startPos: imageHit.position };
        props.onImageEditStart?.(imageHit.id);
      } else {
        dragRef.current = { type: "none" };
      }
      setCanvasCursor(canvas, shouldDrag ? "grabbing" : "move");
      return;
    }

    // Shift-drag on empty canvas rubber-bands a selection box over ripper corners
    // instead of panning.
    if (event.shiftKey && props.onMoveVertex && rippers.length > 0) {
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      marqueeRef.current = { x0: screen.x, y0: screen.y, x1: screen.x, y1: screen.y };
      dragRef.current = { type: "marquee" };
      setCanvasCursor(canvas, "crosshair");
      return;
    }

    props.onSelectImage(undefined);
    props.onSelectRipper?.(undefined);
    if (selectedVertices.size > 0) setSelectedVertices(new Set());
    dragRef.current = { type: "pan", startPointer: { x: event.clientX, y: event.clientY }, startPan: props.view.pan };
    setCanvasCursor(canvas, "grabbing");
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drag = dragRef.current;

    if (drag.type === "pan") {
      // Absolute pan from the drag anchor — never read back the live `view.pan`,
      // which trails React's commits and would feed jitter back into the drag.
      props.onViewChange({
        ...props.view,
        pan: {
          x: drag.startPan.x + (event.clientX - drag.startPointer.x),
          y: drag.startPan.y + (event.clientY - drag.startPointer.y)
        }
      });
      return;
    }

    if (drag.type === "vertex") {
      const world = toWorld(event);
      const scaleMode = event.metaKey || event.ctrlKey;
      const updates = computeVertexUpdates(drag, world, scaleMode);
      if (props.onMoveVertices) props.onMoveVertices(updates);
      else if (props.onMoveVertex) for (const update of updates) props.onMoveVertex(update.id, update.index, update.point);
      return;
    }

    if (drag.type === "marquee") {
      if (marqueeRef.current) {
        const rect = canvas.getBoundingClientRect();
        marqueeRef.current.x1 = event.clientX - rect.left;
        marqueeRef.current.y1 = event.clientY - rect.top;
      }
      return;
    }

    if (drag.type === "ripper" && props.onMoveRipper) {
      const world = toWorld(event);
      props.onMoveRipper(drag.id, { x: world.x - drag.lastWorld.x, y: world.y - drag.lastWorld.y });
      dragRef.current = { type: "ripper", id: drag.id, lastWorld: world };
      return;
    }

    if (drag.type === "resize") {
      const image = props.images.find((item) => item.id === drag.id);
      if (image) resizeImageToPointer(image, drag.anchor, toWorld(event), props.onMoveImage, props.onScaleImage);
      return;
    }

    if (drag.type === "image") {
      const world = toWorld(event);
      // Absolute target from the grab anchor, so the image follows the cursor
      // 1:1 regardless of any snapping applied on previous frames.
      const target = {
        x: drag.startPos.x + (world.x - drag.startWorld.x),
        y: drag.startPos.y + (world.y - drag.startWorld.y)
      };
      const next = props.kind === "atlas"
        ? snapImageToNeighbors(drag.id, target, props.images, props.view.zoom)
        : target;
      props.onMoveImage(drag.id, next);
      return;
    }

    if (props.kind === "atlas" && selectedImage) {
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const handle = hitHandle(screen, selectedImage, canvas, props.view);
      if (handle) {
        setCanvasCursor(canvas, handleCursor(handle.key));
        return;
      }
    }

    updateHoverCursor(canvas, toWorld(event), props.images, rippers, props.view.zoom, props.kind);
  };

  const endDrag = () => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;

    if (drag.type === "marquee") {
      const box = marqueeRef.current;
      marqueeRef.current = null;
      dragRef.current = { type: "none" };
      setSelectedVertices(box ? pickVerticesInBox(box, rippers, canvas, props.view) : new Set());
      if (canvas) setCanvasCursor(canvas, "grab");
      return;
    }

    const wasEditingRipper = drag.type === "vertex" || drag.type === "ripper";
    const wasEditingImage = drag.type === "image" || drag.type === "resize";
    dragRef.current = { type: "none" };
    if (canvas) setCanvasCursor(canvas, "grab");
    if (wasEditingRipper) props.onRipperEditEnd?.();
    if (wasEditingImage) props.onImageEditEnd?.();
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The wheel always zooms the viewport (anchored at the cursor) so every
    // item scales together and nothing drifts relative to anything else.
    // Resizing a single image is done with the corner handles / side panel,
    // never the wheel — doing it here desynced the ripper from its image.
    const world = toWorld(event);

    const rect = canvas.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextZoom = clamp(props.view.zoom + direction * VIEWPORT_ZOOM_SPEED, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM);
    props.onViewChange({
      zoom: nextZoom,
      pan: {
        x: screen.x - canvas.clientWidth / 2 - world.x * nextZoom,
        y: screen.y - canvas.clientHeight / 2 + world.y * nextZoom
      }
    });
  };

  return (
    <section className={`workspace${props.showHeader === false ? " workspace--no-header" : ""}`}>
      {props.showHeader !== false && (
        <div className="workspace__header">
          <h2>{props.title}</h2>
          <span>{Math.round(props.view.zoom * 100)}%</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="workspace__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onContextMenu={(event) => event.preventDefault()}
      />
    </section>
  );
}

function drawWorkspace(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  props: CanvasWorkspaceProps,
  cache: Map<string, { version: number; canvas: HTMLCanvasElement }>,
  time: number,
  selectedVertices: Set<string>,
  marquee: { x0: number; y0: number; x1: number; y1: number } | null
) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#363a38";
  ctx.fillRect(0, 0, width, height);
  if (props.background === "grid") {
    drawGridLines(ctx, width, height, props.view);
  } else {
    drawCheckerboard(ctx, width, height, props.view);
  }

  const live = props.livePreview?.current ?? null;
  for (const image of props.images) {
    const usingLive = live !== null && live.imageId === image.id;
    const bitmap = usingLive ? live.canvas : cachedCanvas(image, cache);
    const pixelWidth = usingLive ? live.width : image.image.width;
    const pixelHeight = usingLive ? live.height : image.image.height;
    const rect = imageScreenRect(image, pixelWidth, pixelHeight, canvas, props.view);
    ctx.save();
    ctx.imageSmoothingEnabled = props.view.zoom <= 1;
    ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
    if (image.id === props.selectedImageId) {
      ctx.strokeStyle = "#2f7d6d";
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    }
    ctx.restore();
  }

  if (props.rippers) {
    for (const ripper of props.rippers) {
      drawRipper(ctx, canvas, props.view, ripper, ripper.id === props.selectedRipperId, time, selectedVertices);
    }
  }

  if (marquee) drawMarquee(ctx, marquee);

  if (props.exportRegion && props.images.length > 0) {
    drawExportRegion(ctx, canvas, props.view, props.exportRegion);
  }

  if (props.kind === "atlas" && props.selectedImageId) {
    const selected = props.images.find((image) => image.id === props.selectedImageId);
    if (selected) drawImageHandles(ctx, canvas, props.view, selected);
  }

  if (props.images.length === 0 && (!props.rippers || props.rippers.length === 0)) {
    ctx.save();
    ctx.fillStyle = "rgba(219, 214, 197, 0.62)";
    ctx.font = '10px "Press Start 2P", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.fillText(props.emptyLabel, width / 2, height / 2);
    ctx.restore();
  }
}

function drawCheckerboard(ctx: CanvasRenderingContext2D, width: number, height: number, view: ViewState) {
  const cell = Math.max(18, Math.round(42 * view.zoom));
  // Floor the tile origin to whole pixels so cell edges land on device pixels;
  // fractional fillRect coordinates leave anti-aliased seams that shimmer as the
  // canvas pans, breaking the seamless "infinite background" illusion.
  const startX = Math.floor((((width / 2 + view.pan.x) % cell) + cell) % cell - cell);
  const startY = Math.floor((((height / 2 + view.pan.y) % cell) + cell) % cell - cell);
  ctx.save();
  for (let y = startY; y < height + cell; y += cell) {
    for (let x = startX; x < width + cell; x += cell) {
      ctx.fillStyle = ((Math.floor((x - startX) / cell) + Math.floor((y - startY) / cell)) % 2 === 0)
        ? "rgba(75, 80, 77, 0.92)"
        : "rgba(54, 58, 55, 0.92)";
      ctx.fillRect(x, y, cell, cell);
    }
  }
  ctx.restore();
}

function drawGridLines(ctx: CanvasRenderingContext2D, width: number, height: number, view: ViewState) {
  const cell = Math.max(18, Math.round(42 * view.zoom));
  const startX = ((((width / 2 + view.pan.x) % cell) + cell) % cell);
  const startY = ((((height / 2 + view.pan.y) % cell) + cell) % cell);
  ctx.save();
  ctx.strokeStyle = "rgba(92, 99, 94, 0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x <= width; x += cell) {
    const gx = Math.round(x) + 0.5;
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, height);
  }
  for (let y = startY; y <= height; y += cell) {
    const gy = Math.round(y) + 0.5;
    ctx.moveTo(0, gy);
    ctx.lineTo(width, gy);
  }
  ctx.stroke();
  ctx.restore();
}

// White frame matching the pixel bounds of the exported atlas. It is derived
// from the placed images' bounding box (plus any manual/square padding), so it
// grows and shifts live as items are dragged around the atlas.
function drawExportRegion(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, view: ViewState, region: ExportRegion) {
  const topLeft = worldToScreen({ x: region.xMin, y: region.yMax }, canvas, view);
  const x = Math.round(topLeft.x) + 0.5;
  const y = Math.round(topLeft.y) + 0.5;
  const w = Math.round(region.width * view.zoom);
  const h = Math.round(region.height * view.zoom);
  ctx.save();
  ctx.strokeStyle = "rgba(244, 241, 232, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function drawRipper(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  view: ViewState,
  ripper: RipperState,
  selected: boolean,
  time: number,
  selectedVertices: Set<string>
) {
  const points = ripper.points.map((point) => worldToScreen(point, canvas, view));
  if (points.length !== 4) return;

  ctx.save();

  // Only the active ripper gets the rule-of-thirds guides and the marching-ants
  // animation. Inactive rippers are drawn dimmed and static so attention stays
  // on the selected one (and idle ones do not visually compete for it).
  if (selected) drawRuleOfThirds(ctx, points);

  ctx.globalAlpha = selected ? 1 : 0.45;

  // A thin dark base underneath keeps the dashes legible over any background.
  // Vertex dragging works via geometric hit-testing (hitVertex), independent of
  // whether the handles below are drawn.
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.strokeStyle = "rgba(8, 9, 8, 0.85)";
  ctx.setLineDash([]);
  closedPath(ctx, points);
  ctx.stroke();

  ctx.lineWidth = selected ? 1.5 : 1;
  ctx.strokeStyle = selected ? "#efe5c7" : "#9b968a";
  ctx.setLineDash([6, 5]);
  ctx.lineDashOffset = selected ? -(time / 40) : 0;
  closedPath(ctx, points);
  ctx.stroke();
  ctx.setLineDash([]);

  // Corner handles: shown on the selected ripper, plus any corner that is part of
  // a multi-selection (so marquee-picked corners are visible even on an inactive
  // ripper). Selected corners are larger and use the accent fill.
  ctx.globalAlpha = 1;
  points.forEach((point, index) => {
    const inSelection = selectedVertices.has(vertexKey(ripper.id, index));
    if (!selected && !inSelection) return;
    const size = inSelection ? VERTEX_HANDLE_SELECTED_SIZE : VERTEX_HANDLE_SIZE;
    const half = size / 2;
    const x = Math.round(point.x - half);
    const y = Math.round(point.y - half);
    ctx.fillStyle = inSelection ? "#2f7d6d" : "#efe5c7";
    ctx.fillRect(x, y, size, size);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(8, 9, 8, 0.85)";
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  });

  ctx.restore();
}

// Dashed rubber-band box drawn while Shift-dragging on empty canvas.
function drawMarquee(ctx: CanvasRenderingContext2D, box: { x0: number; y0: number; x1: number; y1: number }) {
  const x = Math.min(box.x0, box.x1);
  const y = Math.min(box.y0, box.y1);
  const w = Math.abs(box.x1 - box.x0);
  const h = Math.abs(box.y1 - box.y0);
  ctx.save();
  ctx.fillStyle = "rgba(47, 125, 109, 0.18)";
  ctx.fillRect(x, y, w, h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(239, 229, 199, 0.85)";
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  ctx.restore();
}

function drawRuleOfThirds(ctx: CanvasRenderingContext2D, points: Vec2[]) {
  const [tl, tr, br, bl] = points;
  if (!tl || !tr || !br || !bl) return;
  ctx.save();
  ctx.strokeStyle = "rgba(239, 229, 199, 0.35)";
  ctx.lineWidth = 1;
  for (const t of [1 / 3, 2 / 3]) {
    const top = lerpPoint(tl, tr, t);
    const bottom = lerpPoint(bl, br, t);
    const left = lerpPoint(tl, bl, t);
    const right = lerpPoint(tr, br, t);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();
  }
  ctx.restore();
}

function cachedCanvas(image: WorkspaceImageState, cache: Map<string, { version: number; canvas: HTMLCanvasElement }>): HTMLCanvasElement {
  const cached = cache.get(image.id);
  if (cached?.version === image.version) return cached.canvas;
  const canvas = pixelImageToCanvas(image.image);
  cache.set(image.id, { version: image.version, canvas });
  return canvas;
}

function imageScreenRect(image: WorkspaceImageState, pixelWidth: number, pixelHeight: number, canvas: HTMLCanvasElement, view: ViewState) {
  const widthWorld = pixelWidth * image.scale.x;
  const heightWorld = pixelHeight * image.scale.y;
  const topLeft = worldToScreen(
    { x: image.position.x - widthWorld / 2, y: image.position.y + heightWorld / 2 },
    canvas,
    view
  );
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: widthWorld * view.zoom,
    height: heightWorld * view.zoom
  };
}

interface ImageHandle {
  key: HandleKey;
  /** Screen-space centre of the handle. */
  screen: Vec2;
  /** World-space opposite corner, kept fixed while resizing. */
  anchor: Vec2;
}

// Four corner handles for the selected atlas image. `anchor` is the diagonally
// opposite corner (world space), which stays pinned while the handle is dragged.
function imageHandles(image: WorkspaceImageState, canvas: HTMLCanvasElement, view: ViewState): ImageHandle[] {
  const halfW = (image.image.width * image.scale.x) / 2;
  const halfH = (image.image.height * image.scale.y) / 2;
  const left = image.position.x - halfW;
  const right = image.position.x + halfW;
  const top = image.position.y + halfH;
  const bottom = image.position.y - halfH;
  const corners: Record<HandleKey, { world: Vec2; anchor: Vec2 }> = {
    tl: { world: { x: left, y: top }, anchor: { x: right, y: bottom } },
    tr: { world: { x: right, y: top }, anchor: { x: left, y: bottom } },
    bl: { world: { x: left, y: bottom }, anchor: { x: right, y: top } },
    br: { world: { x: right, y: bottom }, anchor: { x: left, y: top } }
  };
  return (Object.keys(corners) as HandleKey[]).map((key) => ({
    key,
    screen: worldToScreen(corners[key].world, canvas, view),
    anchor: corners[key].anchor
  }));
}

function hitHandle(screen: Vec2, image: WorkspaceImageState, canvas: HTMLCanvasElement, view: ViewState): ImageHandle | undefined {
  for (const handle of imageHandles(image, canvas, view)) {
    if (Math.hypot(handle.screen.x - screen.x, handle.screen.y - screen.y) <= HANDLE_HIT_RADIUS) return handle;
  }
  return undefined;
}

function handleCursor(key: HandleKey): string {
  return key === "tl" || key === "br" ? "nwse-resize" : "nesw-resize";
}

// Scale the image so the dragged corner follows the pointer while the opposite
// corner stays put. Width/height move independently (free resize); the centre is
// shifted so the anchor corner stays fixed even when a dimension hits the floor.
function resizeImageToPointer(
  image: WorkspaceImageState,
  anchor: Vec2,
  pointer: Vec2,
  onMoveImage: (id: string, position: Vec2) => void,
  onScaleImage: (id: string, scale: Vec2) => void
) {
  const scaleX = Math.max(IMAGE_MIN_SCALE, Math.abs(pointer.x - anchor.x) / image.image.width);
  const scaleY = Math.max(IMAGE_MIN_SCALE, Math.abs(pointer.y - anchor.y) / image.image.height);
  const newWidth = scaleX * image.image.width;
  const newHeight = scaleY * image.image.height;
  const signX = pointer.x >= anchor.x ? 1 : -1;
  const signY = pointer.y >= anchor.y ? 1 : -1;
  const center = { x: anchor.x + (signX * newWidth) / 2, y: anchor.y + (signY * newHeight) / 2 };
  onScaleImage(image.id, { x: scaleX, y: scaleY });
  onMoveImage(image.id, center);
}

function drawImageHandles(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, view: ViewState, image: WorkspaceImageState) {
  const half = HANDLE_SCREEN_SIZE / 2;
  ctx.save();
  for (const handle of imageHandles(image, canvas, view)) {
    const x = Math.round(handle.screen.x - half);
    const y = Math.round(handle.screen.y - half);
    ctx.fillStyle = "#efe5c7";
    ctx.fillRect(x, y, HANDLE_SCREEN_SIZE, HANDLE_SCREEN_SIZE);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#2f7d6d";
    ctx.strokeRect(x + 0.5, y + 0.5, HANDLE_SCREEN_SIZE - 1, HANDLE_SCREEN_SIZE - 1);
  }
  ctx.restore();
}

function hitImage(world: Vec2, images: WorkspaceImageState[]): WorkspaceImageState | undefined {
  for (let index = images.length - 1; index >= 0; index -= 1) {
    const image = images[index];
    if (!image) continue;
    const halfWidth = (image.image.width * Math.abs(image.scale.x)) / 2;
    const halfHeight = (image.image.height * Math.abs(image.scale.y)) / 2;
    if (
      world.x >= image.position.x - halfWidth &&
      world.x <= image.position.x + halfWidth &&
      world.y >= image.position.y - halfHeight &&
      world.y <= image.position.y + halfHeight
    ) {
      return image;
    }
  }
  return undefined;
}

function vertexKey(id: string, index: number): string {
  return `${id}#${index}`;
}

function vertexRefsFromKeys(keys: Set<string>): VertexRef[] {
  return [...keys].map((key) => {
    const split = key.lastIndexOf("#");
    return { id: key.slice(0, split), index: Number(key.slice(split + 1)) };
  });
}

// Capture the start positions of every corner that a drag will touch (the
// dragged ripper, needed for Cmd-scaling, plus all rippers owning a group
// corner). Copied so later state changes never mutate the baseline.
function snapshotPoints(rippers: RipperState[], group: VertexRef[], draggedId: string): Record<string, Vec2[]> {
  const ids = new Set<string>([draggedId, ...group.map((ref) => ref.id)]);
  const out: Record<string, Vec2[]> = {};
  for (const ripper of rippers) {
    if (ids.has(ripper.id)) out[ripper.id] = ripper.points.map((point) => ({ x: point.x, y: point.y }));
  }
  return out;
}

// Resolve a corner drag to the set of corner moves it implies.
//   Cmd/Ctrl → pin the opposite corner and stretch the quad to the pointer,
//              scaling independently along each of the quad's two edge
//              directions. The two adjacent corners slide along those edges so
//              the shape stays a (possibly rotated) rectangle but is free to
//              change proportions — a square can become any rectangle.
//   group    → translate every selected corner by the same delta.
//   single   → the grabbed corner follows the pointer.
function computeVertexUpdates(
  drag: Extract<DragState, { type: "vertex" }>,
  world: Vec2,
  scaleMode: boolean
): VertexUpdate[] {
  if (scaleMode) {
    const start = drag.startPoints[drag.id];
    if (start && start.length === 4) {
      const anchor = start[(drag.index + 2) % 4]!;
      const sideA = start[(drag.index + 1) % 4]!; // adjacent corner along edge A
      const sideB = start[(drag.index + 3) % 4]!; // adjacent corner along edge B
      // Edge vectors out of the pinned corner. The grabbed corner sits at
      // anchor + A + B; decompose the pointer offset onto (A, B) so each edge
      // scales on its own, then place the adjacent corners along each edge.
      const ax = sideA.x - anchor.x, ay = sideA.y - anchor.y;
      const bx = sideB.x - anchor.x, by = sideB.y - anchor.y;
      const det = ax * by - ay * bx;
      if (Math.abs(det) > 1e-6) {
        const wx = world.x - anchor.x, wy = world.y - anchor.y;
        const s = (wx * by - wy * bx) / det; // scale along edge A
        const t = (ax * wy - ay * wx) / det; // scale along edge B
        const updates: VertexUpdate[] = [];
        updates[drag.index] = { id: drag.id, index: drag.index, point: world };
        updates[(drag.index + 1) % 4] = { id: drag.id, index: (drag.index + 1) % 4, point: { x: anchor.x + ax * s, y: anchor.y + ay * s } };
        updates[(drag.index + 2) % 4] = { id: drag.id, index: (drag.index + 2) % 4, point: anchor };
        updates[(drag.index + 3) % 4] = { id: drag.id, index: (drag.index + 3) % 4, point: { x: anchor.x + bx * t, y: anchor.y + by * t } };
        return updates;
      }
    }
  }

  if (drag.group.length > 1) {
    const delta = { x: world.x - drag.startWorld.x, y: world.y - drag.startWorld.y };
    const updates: VertexUpdate[] = [];
    for (const ref of drag.group) {
      const point = drag.startPoints[ref.id]?.[ref.index];
      if (point) updates.push({ id: ref.id, index: ref.index, point: { x: point.x + delta.x, y: point.y + delta.y } });
    }
    return updates;
  }

  return [{ id: drag.id, index: drag.index, point: world }];
}

// Corners whose on-screen position falls inside the marquee box.
function pickVerticesInBox(
  box: { x0: number; y0: number; x1: number; y1: number },
  rippers: RipperState[],
  canvas: HTMLCanvasElement | null,
  view: ViewState
): Set<string> {
  const selected = new Set<string>();
  if (!canvas) return selected;
  const minX = Math.min(box.x0, box.x1);
  const maxX = Math.max(box.x0, box.x1);
  const minY = Math.min(box.y0, box.y1);
  const maxY = Math.max(box.y0, box.y1);
  for (const ripper of rippers) {
    ripper.points.forEach((point, index) => {
      const screen = worldToScreen(point, canvas, view);
      if (screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) {
        selected.add(vertexKey(ripper.id, index));
      }
    });
  }
  return selected;
}

function hitVertex(world: Vec2, rippers: RipperState[], zoom: number): { ripper: RipperState; index: number } | undefined {
  const radius = VERTEX_HIT_RADIUS / zoom;
  for (let ripperIndex = rippers.length - 1; ripperIndex >= 0; ripperIndex -= 1) {
    const ripper = rippers[ripperIndex];
    if (!ripper) continue;
    for (let index = 0; index < ripper.points.length; index += 1) {
      const point = ripper.points[index]!;
      if (Math.hypot(point.x - world.x, point.y - world.y) <= radius) return { ripper, index };
    }
  }
  return undefined;
}

function hitRipper(world: Vec2, rippers: RipperState[]): RipperState | undefined {
  for (let index = rippers.length - 1; index >= 0; index -= 1) {
    const ripper = rippers[index];
    if (ripper && pointInsidePolygon(world, ripper.points)) return ripper;
  }
  return undefined;
}

// Snap an in-progress atlas drag to its neighbours' edges. The dragged image is
// evaluated at its unsnapped `target` so the result depends only on the cursor,
// not on where a previous frame snapped to (which is what made dragging stick).
// The snap band is divided by zoom so it stays a constant on-screen distance —
// without that it felt huge when zoomed in and unreachable when zoomed out.
function snapImageToNeighbors(
  id: string,
  target: Vec2,
  images: WorkspaceImageState[],
  zoom: number
): Vec2 {
  const dragged = images.find((item) => item.id === id);
  if (!dragged) return target;
  const moved: AtlasItem = { image: dragged.image, position: target, scale: dragged.scale };
  const neighbors = images.filter((item) => item.id !== id);
  if (neighbors.length === 0) return target;
  return snapAtlasItem(moved, neighbors, SNAP_DISTANCE / Math.max(zoom, 1e-6));
}

function screenToWorld(screen: Vec2, canvas: HTMLCanvasElement, view: ViewState): Vec2 {
  return {
    x: (screen.x - canvas.clientWidth / 2 - view.pan.x) / view.zoom,
    y: -(screen.y - canvas.clientHeight / 2 - view.pan.y) / view.zoom
  };
}

function worldToScreen(world: Vec2, canvas: HTMLCanvasElement, view: ViewState): Vec2 {
  return {
    x: canvas.clientWidth / 2 + view.pan.x + world.x * view.zoom,
    y: canvas.clientHeight / 2 + view.pan.y - world.y * view.zoom
  };
}

function syncCanvasSize(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function closedPath(ctx: CanvasRenderingContext2D, points: Vec2[]) {
  const first = points[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
}

function lerpPoint(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function updateHoverCursor(
  canvas: HTMLCanvasElement,
  world: Vec2,
  images: WorkspaceImageState[],
  rippers: RipperState[],
  zoom: number,
  kind: WorkspaceKind
) {
  if (hitVertex(world, rippers, zoom)) {
    setCanvasCursor(canvas, "pointer");
  } else if (hitRipper(world, rippers)) {
    setCanvasCursor(canvas, "move");
  } else if (hitImage(world, images)) {
      setCanvasCursor(canvas, kind === "atlas" ? "move" : "grab");
  } else {
    setCanvasCursor(canvas, "grab");
  }
}

function setCanvasCursor(canvas: HTMLCanvasElement, cursor: string) {
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
}
