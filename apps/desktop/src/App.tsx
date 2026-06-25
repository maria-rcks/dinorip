import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { VIEWPORT_MAX_ZOOM, VIEWPORT_MIN_ZOOM } from "@dinorip/ipc-contracts";
import {
  computeAtlasBounds,
  createRipper,
  packAtlasPositions,
  flipVertical,
  getPixel,
  isRipperCurved,
  makeImage,
  setPixel,
  shouldConserve
} from "@dinorip/core";
import type {
  AtlasItem,
  AtlasRasterResult,
  ExtractionResult,
  PixelImage,
  PlacedImage,
  Vec2
} from "@dinorip/core";
import { CanvasWorkspace } from "./workspaces/CanvasWorkspace";
import type { WorkspaceLivePreview } from "./workspaces/CanvasWorkspace";
import { SidePanel } from "./panels/SidePanel";
import { TiledPanel } from "./panels/TiledPanel";
import { usePanelLayout } from "./panels/usePanelLayout";
import type { LayoutResizePart, PanelId } from "./panels/usePanelLayout";
import { AtlasToolbar, SourceToolbar } from "./panels/PixelToolbars";
import { ShortcutsOverlay } from "./panels/ShortcutsOverlay";
import { defaultTextureSettings, defaultViewState } from "./renderer/types";
import type { RipperState, TextureSettings, ViewState, WorkspaceImageState } from "./renderer/types";
import { cloneForState, fromIpcImage, pixelImageFromBlob, toIpcImage } from "./renderer/imageCanvas";
import { gpuExtractPerspective, gpuExtractPerspectiveAsync, gpuRenderLivePreview, isGpuExtractAvailable } from "./renderer/gpuExtract";

type WorkerResponse<T> = { id: string; ok: true; result: T } | { id: string; ok: false; error: string };

const PANEL_TITLES: Record<PanelId, string> = {
  atlas: "Texture Atlas",
  ripper: "Image Ripper",
  tools: "Texture Options"
};
const PANEL_DESCRIPTIONS: Record<PanelId, string> = {
  atlas: "Texture atlas of the ripped images. Exports as a single texture file.",
  ripper: "Lets you rip the textures from images using the ripper window. Place them according to the geometry and perspective of the object.",
  tools: "Image adjustments applied to the selected texture."
};
const RIPPER_WORLD_SIZE = 100;
const AUTO_EXTRACT_DELAY_MS = 180;
const HISTORY_LIMIT = 50;

// A point-in-time copy of every user-editable piece of workspace state. Undo and
// redo restore one of these wholesale. The arrays can be held by reference
// because each mutation replaces objects rather than editing them in place.
interface HistorySnapshot {
  sourceImages: WorkspaceImageState[];
  atlasImages: WorkspaceImageState[];
  rippers: RipperState[];
  selectedSourceImageId?: string;
  selectedAtlasImageId?: string;
  selectedRipperId?: string;
}

export function App(): ReactElement {
  const [sourceImages, setSourceImages] = useState<WorkspaceImageState[]>([]);
  const [atlasImages, setAtlasImages] = useState<WorkspaceImageState[]>([]);
  const [rippers, setRippers] = useState<RipperState[]>([]);
  const [selectedSourceImageId, setSelectedSourceImageId] = useState<string | undefined>();
  const [selectedAtlasImageId, setSelectedAtlasImageId] = useState<string | undefined>();
  const [selectedRipperId, setSelectedRipperId] = useState<string | undefined>();
  // Atlas right-click context menu (curve conserve/rectify toggle). Null = closed.
  const [ripperMenu, setRipperMenu] = useState<{ ripperId: string; x: number; y: number } | null>(null);
  // Atlas export sizing: a manual minimum size (null = auto-fit to content) and
  // whether the export region is padded to a square.
  const [atlasManualSize, setAtlasManualSize] = useState<{ width: number; height: number } | null>(null);
  const [atlasSquare, setAtlasSquare] = useState(false);
  const [sourceView, setSourceView] = useState<ViewState>(defaultViewState);
  const [atlasView, setAtlasView] = useState<ViewState>(defaultViewState);
  const [status, setStatus] = useState("");
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [resizingPart, setResizingPart] = useState<LayoutResizePart | null>(null);
  const tilesRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const resizeFrame = useRef(0);
  const pendingResize = useRef<{ part: LayoutResizePart; clientX: number; clientY: number } | null>(null);
  const resizeListeners = useRef<{
    move(event: PointerEvent): void;
    end(event: PointerEvent): void;
  } | null>(null);
  const autoExtractRun = useRef(0);
  const pendingJobs = useRef(new Map<string, { resolve: (value: any) => void; reject: (reason: Error) => void }>());
  // Live GPU projection shown in place of the atlas image while a ripper is
  // dragged. Mutated outside React (read by the atlas canvas every frame).
  const livePreviewRef = useRef<WorkspaceLivePreview | null>(null);
  const editingRipperIdRef = useRef<string | null>(null);
  // Geometry signature of the ripper at the moment an edit began. Lets edit-end
  // tell a real drag from a click that only selected the ripper, so a pure
  // selection skips the full-resolution re-extraction entirely.
  const editStartSignatureRef = useRef<string | null>(null);

  // Undo/redo history. Each entry is a full workspace snapshot; the stacks are
  // React state so the toolbar buttons can reflect whether they are available.
  // `interactionSnapshot` holds the pre-drag state for a single pointer
  // interaction so a drag becomes one undo step (and a click that moves nothing
  // records none).
  const [undoStack, setUndoStack] = useState<HistorySnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<HistorySnapshot[]>([]);
  const interactionSnapshot = useRef<HistorySnapshot | null>(null);

  function snapshot(): HistorySnapshot {
    return {
      sourceImages,
      atlasImages,
      rippers,
      selectedSourceImageId,
      selectedAtlasImageId,
      selectedRipperId
    };
  }

  // Record the current state as an undo step before a mutating action runs. Any
  // pending redo history is dropped, since a new edit forks the timeline.
  function commitHistory(state: HistorySnapshot = snapshot()) {
    setUndoStack((stack) => [...stack, state].slice(-HISTORY_LIMIT));
    setRedoStack([]);
  }

  // Pointer-interaction history: capture once at the start of a drag, then push
  // it as an undo step on release only if the drag actually changed something.
  function beginInteraction() {
    if (!interactionSnapshot.current) interactionSnapshot.current = snapshot();
  }

  function endInteraction() {
    const before = interactionSnapshot.current;
    interactionSnapshot.current = null;
    if (!before) return;
    if (snapshotSignature(before) !== snapshotSignature(snapshot())) commitHistory(before);
  }

  function applySnapshot(state: HistorySnapshot) {
    livePreviewRef.current = null;
    editingRipperIdRef.current = null;
    interactionSnapshot.current = null;
    setSourceImages(state.sourceImages);
    setAtlasImages(state.atlasImages);
    setRippers(state.rippers);
    setSelectedSourceImageId(state.selectedSourceImageId);
    setSelectedAtlasImageId(state.selectedAtlasImageId);
    setSelectedRipperId(state.selectedRipperId);
  }

  function undo() {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1]!;
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack, snapshot()].slice(-HISTORY_LIMIT));
    applySnapshot(previous);
    setStatus("Undo");
  }

  function redo() {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1]!;
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack, snapshot()].slice(-HISTORY_LIMIT));
    applySnapshot(next);
    setStatus("Redo");
  }

  useEffect(() => {
    const worker = new Worker(new URL("./workers/processing.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse<unknown>>) => {
      const response = event.data;
      const pending = pendingJobs.current.get(response.id);
      if (!pending) return;
      pendingJobs.current.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      const typing = tag === "input" || tag === "select" || tag === "textarea" || target?.isContentEditable === true;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod && key === "f") {
        event.preventDefault();
        void window.dinorip.toggleFullscreen();
        return;
      }

      // Undo / redo. Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z or Cmd/Ctrl+Y redoes.
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        redo();
        return;
      }

      if (typing) return;

      // Add a ripper.
      if (!mod && key === "a") {
        event.preventDefault();
        addRipper();
        return;
      }

      // Apply texture adjustments to the selected texture.
      if (!mod && key === "s") {
        event.preventDefault();
        void applyAdjustments();
        return;
      }

      // Extract the selected ripper.
      if (!mod && key === "enter" && selectedRipperId) {
        event.preventDefault();
        void extractSelected();
        return;
      }

      // Delete: remove the selected ripper if one is active, otherwise the
      // selected atlas texture.
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedRipperId) {
          event.preventDefault();
          deleteRipper();
        } else if (selectedAtlasImageId) {
          event.preventDefault();
          deleteAtlasImage();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = imageFilesFromClipboard(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void pasteImages(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const {
    span,
    tilesStyle,
    tilesClassName,
    areaOf,
    activeId,
    dragging,
    dropTarget,
    activate,
    beginDrag,
    dragOver,
    endDrag,
    extendPanel,
    resizeLayout
  } = usePanelLayout();

  const panelProps = (id: PanelId) => ({
    id,
    area: areaOf(id),
    active: activeId === id,
    dragging: dragging === id,
    dropTarget: dropTarget === id,
    onActivate: activate,
    onDragStart: beginDrag,
    onDragOver: dragOver,
    onDragEnd: endDrag,
    onExtend: extendPanel
  });

  const dropPreviewArea = dragging && dropTarget ? areaOf(dropTarget) : null;
  const tilesClassNameWithState = [
    tilesClassName,
    resizingPart ? `app__tiles--resizing app__tiles--resizing-${resizingPart}` : ""
  ]
    .filter(Boolean)
    .join(" ");

  const selectedAtlasImage = useMemo(
    () => atlasImages.find((image) => image.id === selectedAtlasImageId),
    [atlasImages, selectedAtlasImageId]
  );

  // World-space rectangle the atlas would export: the tight bounding box of all
  // placed textures, never shrinking below the manual size, optionally squared.
  // Recomputed from positions/scales so it tracks images live as they move.
  const atlasRegion = useMemo(() => {
    if (atlasImages.length === 0) return null;
    const bounds = computeAtlasBounds(atlasImages.map(toAtlasItem));
    let width = Math.max(1, Math.ceil(bounds.width));
    let height = Math.max(1, Math.ceil(bounds.height));
    if (atlasManualSize) {
      width = Math.max(width, atlasManualSize.width);
      height = Math.max(height, atlasManualSize.height);
    }
    if (atlasSquare) {
      const side = Math.max(width, height);
      width = side;
      height = side;
    }
    return { xMin: bounds.xMin, yMax: bounds.yMin + bounds.height, width, height };
  }, [atlasImages, atlasManualSize, atlasSquare]);

  const atlasSizeWidth = atlasRegion?.width ?? atlasManualSize?.width ?? 256;
  const atlasSizeHeight = atlasRegion?.height ?? atlasManualSize?.height ?? 256;
  const sourceExtractionKey = useMemo(() => sourceImages.map(sourceImageSignature).join("|"), [sourceImages]);
  const ripperExtractionKey = useMemo(() => rippers.map(ripperSignature).join("|"), [rippers]);

  useEffect(() => {
    if (sourceImages.length === 0 || rippers.length === 0) return;
    const runId = autoExtractRun.current + 1;
    autoExtractRun.current = runId;
    // The GPU path is fast enough to project live, so coalesce a burst of
    // pointer-move updates into the next animation frame and extract with no
    // perceptible debounce. The CPU/worker path stays debounced as a fallback.
    if (isGpuExtractAvailable()) {
      const frame = window.requestAnimationFrame(() => {
        const editingId = editingRipperIdRef.current;
        const editingRipper = editingId ? rippers.find((item) => item.id === editingId) : undefined;
        // While dragging an already-extracted ripper, project straight to the
        // GPU canvas with no readback — instant and independent of ripper size.
        if (editingRipper?.outputImageId) {
          const preview = gpuRenderLivePreview(editingRipper, toPlacedImages(sourceImages));
          if (preview) {
            livePreviewRef.current = { imageId: editingRipper.outputImageId, ...preview };
            return;
          }
        }
        // Otherwise bake into state (creates the atlas image, refines to full
        // resolution, and feeds the export/seamless pipeline).
        autoExtractGpu(runId, rippers, sourceImages, selectedRipperId);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const timeout = window.setTimeout(() => {
      void autoExtractRippers(runId, rippers, sourceImages, selectedRipperId);
    }, AUTO_EXTRACT_DELAY_MS);
    return () => window.clearTimeout(timeout);
    // Deliberately not keyed on `selectedRipperId`: only geometry/source changes
    // need a re-extraction. Selecting a ripper must not re-project every ripper
    // (that re-rasterizes the atlas and is what made clicking a ripper lag).
  }, [ripperExtractionKey, sourceExtractionKey]);

  // Selecting a ripper highlights its extracted texture in the atlas. This is a
  // cheap selection follow that replaces the side effect the extraction pass
  // used to do, so it no longer needs to re-extract just to track selection.
  useEffect(() => {
    if (!selectedRipperId) return;
    const ripper = rippers.find((item) => item.id === selectedRipperId);
    if (ripper?.outputImageId) setSelectedAtlasImageId(ripper.outputImageId);
    // Keyed only on selection change; `rippers` is read fresh from the
    // triggering render, and the extraction pass handles post-extract selection.
  }, [selectedRipperId]);

  useEffect(() => () => {
    if (resizeFrame.current !== 0) window.cancelAnimationFrame(resizeFrame.current);
    removeResizeListeners();
  }, []);

  async function runWorker<T>(message: Omit<Record<string, unknown>, "id">): Promise<T> {
    const worker = workerRef.current;
    if (!worker) throw new Error("Processing worker is not ready.");
    const id = createId("job");
    const promise = new Promise<T>((resolve, reject) => {
      pendingJobs.current.set(id, { resolve, reject });
    });
    worker.postMessage({ id, ...message });
    return promise;
  }

  function removeResizeListeners() {
    const listeners = resizeListeners.current;
    if (!listeners) return;
    window.removeEventListener("pointermove", listeners.move, true);
    window.removeEventListener("pointerup", listeners.end, true);
    window.removeEventListener("pointercancel", listeners.end, true);
    resizeListeners.current = null;
  }

  function splitRatioFromPointer(part: LayoutResizePart, clientX: number, clientY: number): number | null {
    const rect = tilesRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 1 || rect.height <= 1) return null;
    if (part === "x") return (clientX - rect.left) / rect.width;
    return (clientY - rect.top) / rect.height;
  }

  function scheduleLayoutResize(part: LayoutResizePart, clientX: number, clientY: number) {
    pendingResize.current = { part, clientX, clientY };
    if (resizeFrame.current !== 0) return;
    resizeFrame.current = window.requestAnimationFrame(() => {
      resizeFrame.current = 0;
      const pending = pendingResize.current;
      pendingResize.current = null;
      if (!pending) return;
      const ratio = splitRatioFromPointer(pending.part, pending.clientX, pending.clientY);
      if (ratio !== null) resizeLayout(pending.part, ratio);
    });
  }

  function beginLayoutResize(part: LayoutResizePart, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setResizingPart(part);
    scheduleLayoutResize(part, event.clientX, event.clientY);

    const pointerId = event.pointerId;
    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      scheduleLayoutResize(part, pointerEvent.clientX, pointerEvent.clientY);
    };
    const end = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      pointerEvent.preventDefault();
      scheduleLayoutResize(part, pointerEvent.clientX, pointerEvent.clientY);
      removeResizeListeners();
      setResizingPart(null);
    };

    removeResizeListeners();
    resizeListeners.current = { move, end };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }

  async function loadImages() {
    const result = await window.dinorip.openImages();
    if (result.canceled || result.images.length === 0) {
      setStatus("Load canceled");
      return;
    }

    appendSourceImages(result.images.map((image) => ({
      name: image.name,
      image: fromIpcImage(image)
    })));
    const first = result.images[0];
    if (first) {
      const fitZoom = Math.min(1, 520 / Math.max(first.width, first.height));
      setSourceView({ zoom: clamp(fitZoom, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM), pan: { x: 0, y: 0 } });
    }
    setStatus(`Loaded ${result.images.length} image${result.images.length === 1 ? "" : "s"}`);
  }

  async function pasteImages(files: File[]) {
    setStatus(`Pasting ${files.length} image${files.length === 1 ? "" : "s"}...`);
    const decoded = await Promise.allSettled(files.map(async (file, index) => ({
      name: clipboardImageName(file, index),
      image: await pixelImageFromBlob(file)
    })));
    const images = decoded
      .filter((result): result is PromiseFulfilledResult<{ name: string; image: PixelImage }> => result.status === "fulfilled")
      .map((result) => result.value);

    if (images.length === 0) {
      setStatus("Clipboard image could not be decoded");
      return;
    }

    appendSourceImages(images);
    const first = images[0];
    if (first) {
      const fitZoom = Math.min(1, 520 / Math.max(first.image.width, first.image.height));
      setSourceView({ zoom: clamp(fitZoom, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM), pan: { x: 0, y: 0 } });
    }
    const failedCount = decoded.length - images.length;
    const suffix = failedCount > 0 ? ` (${failedCount} failed)` : "";
    setStatus(`Pasted ${images.length} image${images.length === 1 ? "" : "s"} from clipboard${suffix}`);
  }

  function appendSourceImages(images: Array<{ name: string; image: PixelImage }>) {
    if (images.length === 0) return;
    commitHistory();
    const positions = layoutAppendedImages(sourceImages, images);
    const workspaceImages = images.map((item, index) => makeWorkspaceImage(
      item.name,
      item.image,
      positions[index]!,
      false
    ));
    setSourceImages((current) => [...current, ...workspaceImages]);
    setSelectedSourceImageId(workspaceImages[0]?.id);
  }

  function addRipper() {
    commitHistory();
    const center = { x: -sourceView.pan.x / sourceView.zoom, y: sourceView.pan.y / sourceView.zoom };
    const ripper = createRipper(center, RIPPER_WORLD_SIZE);
    const next: RipperState = { id: createId("ripper"), points: ripper.points };
    setRippers((current) => [...current, next]);
    setSelectedRipperId(next.id);
    setStatus(sourceImages.length > 0 ? "Ripper added; extracting..." : "Ripper added");
  }

  function deleteRipper() {
    if (!selectedRipperId) return;
    commitHistory();
    livePreviewRef.current = null;
    const ripper = rippers.find((item) => item.id === selectedRipperId);
    setRippers((current) => current.filter((item) => item.id !== selectedRipperId));
    if (ripper?.outputImageId) {
      setAtlasImages((current) => current.filter((item) => item.id !== ripper.outputImageId));
      if (selectedAtlasImageId === ripper.outputImageId) setSelectedAtlasImageId(undefined);
    }
    setSelectedRipperId(undefined);
    setStatus("Ripper deleted");
  }

  async function extractSelected() {
    const ripper = rippers.find((item) => item.id === selectedRipperId);
    if (!ripper) return;
    if (sourceImages.length === 0) {
      setStatus("Load a source image first");
      return;
    }

    livePreviewRef.current = null;
    setStatus("Extracting texture...");
    const images: PlacedImage[] = sourceImages.map((image) => ({
      image: image.image,
      position: image.position,
      scale: image.scale
    }));
    const result = await runWorker<ExtractionResult | null>({ type: "extract", ripper, images });
    if (!result) {
      setStatus("No owner image found");
      return;
    }

    const existingOutputId = ripper.outputImageId;
    if (existingOutputId) {
      setAtlasImages((current) => current.map((image) => image.id === existingOutputId
        ? {
          ...image,
          image: cloneForState(result.image),
          originalImage: cloneForState(result.image),
          version: image.version + 1
        }
        : image));
      setSelectedAtlasImageId(existingOutputId);
    } else {
      const atlasImage = makeWorkspaceImage(`texture_${atlasImages.length}`, result.image, atlasDropPosition(atlasImages.length), true);
      setAtlasImages((current) => [...current, atlasImage]);
      setRippers((current) => current.map((item) => item.id === ripper.id ? { ...item, outputImageId: atlasImage.id } : item));
      setSelectedAtlasImageId(atlasImage.id);
    }
    setStatus(`Extracted ${result.image.width} x ${result.image.height}`);
  }

  type ResolvedExtraction = {
    ripper: RipperState;
    index: number;
    outputImageId: string;
    result: ExtractionResult;
  };

  function toPlacedImages(sourceSnapshot: WorkspaceImageState[]): PlacedImage[] {
    return sourceSnapshot.map((image) => ({
      image: image.image,
      position: image.position,
      scale: image.scale
    }));
  }

  function buildExtractionInputs(ripperSnapshot: RipperState[], sourceSnapshot: WorkspaceImageState[]) {
    const sourceItems = toPlacedImages(sourceSnapshot);
    const jobs = ripperSnapshot.map((ripper, index) => ({
      ripper,
      index,
      outputImageId: ripper.outputImageId ?? createId("atlas")
    }));
    return { sourceItems, jobs };
  }

  function applyExtraction(extracted: ResolvedExtraction[], selectedRipperSnapshot?: string) {
    if (extracted.length === 0) return;

    setAtlasImages((current) => {
      const next = [...current];
      let appended = 0;
      for (const item of extracted) {
        const existingIndex = next.findIndex((image) => image.id === item.outputImageId);
        if (existingIndex >= 0) {
          const existing = next[existingIndex]!;
          // The freshly extracted image is owned and never mutated in place, so
          // it can back both fields without copying (saves two full-image copies
          // per committed texture).
          next[existingIndex] = {
            ...existing,
            image: item.result.image,
            originalImage: item.result.image,
            version: existing.version + 1
          };
        } else {
          next.push(makeWorkspaceImage(
            `texture_${item.index}`,
            item.result.image,
            atlasDropPosition(current.length + appended),
            true,
            item.outputImageId
          ));
          appended += 1;
        }
      }
      return next;
    });

    const outputByRipper = new Map(extracted.map((item) => [item.ripper.id, item.outputImageId]));
    setRippers((current) => current.map((ripper) => {
      const outputImageId = outputByRipper.get(ripper.id);
      return outputImageId && ripper.outputImageId !== outputImageId ? { ...ripper, outputImageId } : ripper;
    }));

    const selectedOutput = selectedRipperSnapshot ? outputByRipper.get(selectedRipperSnapshot) : undefined;
    if (selectedOutput) setSelectedAtlasImageId(selectedOutput);
    setStatus(`Auto extracted ${extracted.length} texture${extracted.length === 1 ? "" : "s"}`);
  }

  // Live projection path: the GPU warps the ripper quad synchronously, so a
  // single animation frame produces every ripper's texture with no debounce.
  function autoExtractGpu(
    runId: number,
    ripperSnapshot: RipperState[],
    sourceSnapshot: WorkspaceImageState[],
    selectedRipperSnapshot?: string
  ) {
    const { sourceItems, jobs } = buildExtractionInputs(ripperSnapshot, sourceSnapshot);
    const extracted: ResolvedExtraction[] = [];
    for (const job of jobs) {
      const result = gpuExtractPerspective(job.ripper, sourceItems);
      if (result) extracted.push({ ...job, result });
    }
    if (autoExtractRun.current !== runId) return;
    // If the GPU context died mid-draw it produces nothing and reports itself
    // unavailable; fall back to the worker for this update.
    if (extracted.length === 0 && jobs.length > 0 && !isGpuExtractAvailable()) {
      void autoExtractRippers(runId, ripperSnapshot, sourceSnapshot, selectedRipperSnapshot);
      return;
    }
    applyExtraction(extracted, selectedRipperSnapshot);
  }

  async function autoExtractRippers(
    runId: number,
    ripperSnapshot: RipperState[],
    sourceSnapshot: WorkspaceImageState[],
    selectedRipperSnapshot?: string
  ) {
    const { sourceItems, jobs } = buildExtractionInputs(ripperSnapshot, sourceSnapshot);
    const settled = await Promise.allSettled(jobs.map(async (job) => ({
      ...job,
      result: await runWorker<ExtractionResult | null>({
        type: "extract",
        ripper: job.ripper,
        images: sourceItems
      })
    })));
    if (autoExtractRun.current !== runId) return;

    const extracted = settled
      .filter((item): item is PromiseFulfilledResult<typeof jobs[number] & { result: ExtractionResult | null }> => item.status === "fulfilled")
      .map((item) => item.value)
      .filter((item): item is ResolvedExtraction => item.result !== null);
    applyExtraction(extracted, selectedRipperSnapshot);
  }

  // Bake the current adjustments into the selected texture (from its untouched
  // original, so repeated applies are not cumulative). Undoable via history.
  async function applyAdjustments() {
    const image = selectedAtlasImage;
    if (!image) return;
    commitHistory();
    livePreviewRef.current = null;
    setStatus("Applying adjustments...");
    const result = await runWorker<PixelImage>({ type: "adjust", image: image.originalImage, settings: image.settings });
    setAtlasImages((current) => current.map((item) => item.id === image.id
      ? { ...item, image: result, version: item.version + 1 }
      : item));
    setStatus("Adjustments applied");
  }

  // Copy the selected texture's current settings onto every atlas texture and
  // bake them (each from its own untouched original, so the result is never
  // cumulative). One undo step for the whole batch.
  async function applyAdjustmentsToAll() {
    const source = selectedAtlasImage;
    if (!source || atlasImages.length === 0) return;
    commitHistory();
    livePreviewRef.current = null;
    const settings = source.settings;
    setStatus(`Applying to ${atlasImages.length} texture${atlasImages.length === 1 ? "" : "s"}...`);
    const baked = await Promise.all(atlasImages.map(async (item) => ({
      id: item.id,
      image: await runWorker<PixelImage>({ type: "adjust", image: item.originalImage, settings })
    })));
    const byId = new Map(baked.map((item) => [item.id, item.image]));
    setAtlasImages((current) => current.map((item) => {
      const image = byId.get(item.id);
      return image
        ? { ...item, image, settings: { ...settings }, version: item.version + 1 }
        : item;
    }));
    setStatus(`Adjustments applied to ${baked.length} texture${baked.length === 1 ? "" : "s"}`);
  }

  // Non-mutating adjustment pass used by the Texture Options live preview.
  // Always edits the unmodified source texture so previews are not cumulative.
  const computeAdjusted = useCallback(
    (image: PixelImage, settings: TextureSettings) =>
      runWorker<PixelImage>({ type: "adjust", image, settings }),
    []
  );

  async function exportSelected() {
    const image = selectedAtlasImage;
    if (!image) return;
    const result = await window.dinorip.savePng({
      defaultName: "texture",
      image: toIpcImage(flipVertical(image.image))
    });
    setStatus(result.canceled ? "Export canceled" : "Texture exported");
  }

  async function exportAll() {
    if (atlasImages.length === 0) return;
    const result = await window.dinorip.exportAllPng({
      images: atlasImages.map((image) => toIpcImage(flipVertical(image.image)))
    });
    setStatus(result.canceled ? "Export all canceled" : `Exported ${result.paths.length} textures`);
  }

  async function exportAtlas() {
    if (atlasImages.length === 0) return;
    setStatus("Rasterizing atlas...");
    const result = await runWorker<AtlasRasterResult>({
      type: "atlas",
      items: atlasImages.map(toAtlasItem)
    });
    const image = atlasRegion
      ? padImageTopLeft(result.image, atlasRegion.width, atlasRegion.height)
      : result.image;
    const save = await window.dinorip.savePng({
      defaultName: "atlas",
      image: toIpcImage(image)
    });
    setStatus(save.canceled ? "Atlas export canceled" : `Atlas exported ${image.width} x ${image.height}`);
  }

  function deleteAtlasImage() {
    if (!selectedAtlasImageId) return;
    commitHistory();
    livePreviewRef.current = null;
    setAtlasImages((current) => current.filter((image) => image.id !== selectedAtlasImageId));
    setRippers((current) => current.map((ripper) => ripper.outputImageId === selectedAtlasImageId
      ? { ...ripper, outputImageId: undefined }
      : ripper));
    setSelectedAtlasImageId(undefined);
    setStatus("Atlas image deleted");
  }

  function updateSelectedSettings(settings: TextureSettings) {
    if (!selectedAtlasImageId) return;
    setAtlasImages((current) => current.map((image) => image.id === selectedAtlasImageId
      ? { ...image, settings }
      : image));
  }

  // Absolute-position setters: the canvas resolves the drag target (and any
  // atlas edge snapping) and hands us the final centre, so these just store it.
  function moveSourceImage(id: string, position: Vec2) {
    setSourceImages((current) => current.map((image) => image.id === id ? { ...image, position } : image));
  }

  function moveAtlasImage(id: string, position: Vec2) {
    setAtlasImages((current) => current.map((image) => image.id === id ? { ...image, position } : image));
  }

  function scaleSourceImage(id: string, scale: Vec2) {
    setSourceImages((current) => current.map((image) => image.id === id ? { ...image, scale } : image));
  }

  function scaleAtlasImage(id: string, scale: Vec2) {
    setAtlasImages((current) => current.map((image) => image.id === id ? { ...image, scale } : image));
  }

  function rotateAtlasImage(id: string, rotation: number) {
    setAtlasImages((current) => current.map((image) => image.id === id ? { ...image, rotation } : image));
  }

  // Auto-arrange every atlas texture into a tight, roughly-square block so the
  // exported atlas wastes as little space as possible.
  function packAtlasImages() {
    if (atlasImages.length < 2) return;
    commitHistory();
    setAtlasImages((current) => {
      const positions = packAtlasPositions(current.map(toAtlasItem));
      return current.map((image, index) => ({ ...image, position: positions[index] ?? image.position }));
    });
    setStatus(`Packed ${atlasImages.length} textures`);
  }

  function moveRipper(id: string, delta: Vec2) {
    setRippers((current) => current.map((ripper) => ripper.id === id
      ? {
          ...ripper,
          points: ripper.points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y })) as RipperState["points"],
          // Translate the curve control points too, so curved edges move with the
          // body instead of being left behind.
          edgeCurves: ripper.edgeCurves?.map((curve) => curve
            ? [
                { x: curve[0].x + delta.x, y: curve[0].y + delta.y },
                { x: curve[1].x + delta.x, y: curve[1].y + delta.y }
              ] as const
            : null)
        }
      : ripper));
  }

  function moveVertex(id: string, index: number, point: Vec2) {
    setRippers((current) => current.map((ripper) => {
      if (ripper.id !== id) return ripper;
      const points = [...ripper.points] as RipperState["points"];
      points[index] = point;
      return { ...ripper, points };
    }));
  }

  // Apply many corner moves at once (group drags, Cmd-uniform-scaling) as a
  // single state update so every affected ripper re-extracts in one pass.
  function moveVertices(updates: Array<{ id: string; index: number; point: Vec2 }>) {
    if (updates.length === 0) return;
    setRippers((current) => current.map((ripper) => {
      const mine = updates.filter((update) => update.id === ripper.id);
      if (mine.length === 0) return ripper;
      const points = [...ripper.points] as RipperState["points"];
      for (const update of mine) points[update.index] = update.point;
      return { ...ripper, points };
    }));
  }

  // Set (or replace) the cubic controls of one ripper edge. Used live while
  // creating a curve (Cmd-drag on an edge) or dragging a curve handle; the
  // surrounding onRipperEditStart/End calls handle the undo step and re-extract.
  function setEdgeCurve(id: string, edge: number, controls: readonly [Vec2, Vec2]) {
    setRippers((current) => current.map((ripper) => {
      if (ripper.id !== id) return ripper;
      const edgeCurves = [...(ripper.edgeCurves ?? [null, null, null, null])];
      edgeCurves[edge] = controls;
      return { ...ripper, edgeCurves };
    }));
  }

  // Remove an edge's curve (double-click a curve handle): the edge snaps straight.
  // A discrete undoable action, so it records history itself; the extraction
  // effect re-bakes automatically when the signature changes.
  function removeEdgeCurve(id: string, edge: number) {
    const target = rippers.find((ripper) => ripper.id === id);
    if (!target?.edgeCurves?.[edge]) return;
    commitHistory();
    setRippers((current) => current.map((ripper) => {
      if (ripper.id !== id) return ripper;
      const edgeCurves = [...(ripper.edgeCurves ?? [null, null, null, null])];
      edgeCurves[edge] = null;
      return { ...ripper, edgeCurves };
    }));
  }

  // Flip a curved ripper between conserve (shape-preserving cutout) and rectify.
  // Discrete undoable action; the extraction effect re-bakes on signature change.
  function toggleConserveShape(ripperId: string) {
    const target = rippers.find((ripper) => ripper.id === ripperId);
    if (!target || !isRipperCurved(target)) return;
    commitHistory();
    setRippers((current) => current.map((ripper) =>
      ripper.id === ripperId ? { ...ripper, conserveShape: !(ripper.conserveShape ?? true) } : ripper));
  }

  // Right-click on an atlas texture: if it belongs to a curved ripper, open the
  // context menu offering the conserve/rectify toggle. Straight rippers have no
  // menu (they are always rectified).
  function onAtlasImageContextMenu(imageId: string | undefined, clientX: number, clientY: number) {
    if (!imageId) return setRipperMenu(null);
    const ripper = rippers.find((item) => item.outputImageId === imageId);
    if (!ripper || !isRipperCurved(ripper)) return setRipperMenu(null);
    setRipperMenu({ ripperId: ripper.id, x: clientX, y: clientY });
  }

  function onRipperEditStart(id: string) {
    beginInteraction();
    editingRipperIdRef.current = id;
    const edited = rippers.find((item) => item.id === id);
    editStartSignatureRef.current = edited ? ripperSignature(edited) : null;
    // Show the last committed pixels until the first live frame is rendered.
    livePreviewRef.current = null;
  }

  function onRipperEditEnd() {
    const editedId = editingRipperIdRef.current;
    const startSignature = editStartSignatureRef.current;
    editingRipperIdRef.current = null;
    editStartSignatureRef.current = null;
    endInteraction();
    if (!editedId) return;
    // A click that only selects a ripper (pointer down then up with no move)
    // changes no geometry. Re-extracting then would do a full-resolution GPU
    // readback and re-rasterize the atlas texture for nothing — the lag felt
    // when clicking a ripper over a large image. Skip the commit when the
    // ripper is unchanged; the live preview was never shown, so the committed
    // pixels are already on screen.
    const edited = rippers.find((item) => item.id === editedId);
    const unchanged = edited != null && startSignature != null && ripperSignature(edited) === startSignature;
    if (unchanged) {
      livePreviewRef.current = null;
      return;
    }
    void commitRipper(editedId, rippers, sourceImages, selectedRipperId);
  }

  // Moving a placed image is a single undo step: snapshot at pointer-down,
  // record on release only if it actually moved.
  function onImageEditStart() {
    beginInteraction();
  }

  function onImageEditEnd() {
    endInteraction();
  }

  // Bakes the just-dragged ripper's final position into state at full
  // resolution (only that ripper, so a single readback) using a non-blocking
  // async GPU readback. The frozen live-preview canvas keeps showing until the
  // committed texture lands — it is pixel-identical, so there is no flash and
  // no release hitch.
  async function commitRipper(
    ripperId: string,
    ripperSnapshot: RipperState[],
    sourceSnapshot: WorkspaceImageState[],
    selectedRipperSnapshot?: string
  ) {
    const index = ripperSnapshot.findIndex((item) => item.id === ripperId);
    const ripper = ripperSnapshot[index];
    if (!ripper) return;

    const runId = autoExtractRun.current + 1;
    autoExtractRun.current = runId;

    let result: ExtractionResult | null = null;
    if (isGpuExtractAvailable()) {
      result = await gpuExtractPerspectiveAsync(ripper, toPlacedImages(sourceSnapshot));
    } else {
      result = await runWorker<ExtractionResult | null>({
        type: "extract",
        ripper,
        images: toPlacedImages(sourceSnapshot)
      });
    }
    if (autoExtractRun.current !== runId) return;

    if (result) {
      const outputImageId = ripper.outputImageId ?? createId("atlas");
      applyExtraction([{ ripper, index, outputImageId, result }], selectedRipperSnapshot);
    }

    // Drop the live preview once the committed texture has had a frame or two to
    // render. Guard against a new drag having started in the meantime.
    const previewImageId = livePreviewRef.current?.imageId;
    if (previewImageId) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (editingRipperIdRef.current === null && livePreviewRef.current?.imageId === previewImageId) {
          livePreviewRef.current = null;
        }
      }));
    }
  }

  return (
    <main className={window.dinorip.platform === "darwin" ? "app app--mac" : "app"}>
      <header className="app__header">
        <h1>dinorip</h1>
        <span className="app__status">{status}</span>
        <div className="app__toolbar">
          <button
            type="button"
            className="icon-button"
            onClick={() => setShowShortcuts(true)}
            title="Shortcuts"
            aria-label="Show keyboard and mouse shortcuts"
          >
            ?
          </button>
        </div>
      </header>
      <div ref={tilesRef} className={tilesClassNameWithState} style={tilesStyle}>
        <TiledPanel title={PANEL_TITLES.ripper} description={PANEL_DESCRIPTIONS.ripper} {...panelProps("ripper")}>
          <div className="panel-canvas-stack">
            <CanvasWorkspace
              kind="source"
              showHeader={false}
              title="Image Ripper"
              emptyLabel="Load an image to begin"
              images={sourceImages}
              rippers={rippers}
              selectedImageId={selectedSourceImageId}
              selectedRipperId={selectedRipperId}
              view={sourceView}
              onViewChange={setSourceView}
              onSelectImage={setSelectedSourceImageId}
              onSelectRipper={setSelectedRipperId}
              onMoveImage={moveSourceImage}
              onScaleImage={scaleSourceImage}
              onMoveRipper={moveRipper}
              onMoveVertex={moveVertex}
              onMoveVertices={moveVertices}
              onSetEdgeCurve={setEdgeCurve}
              onRemoveEdgeCurve={removeEdgeCurve}
              onRipperEditStart={onRipperEditStart}
              onRipperEditEnd={onRipperEditEnd}
              onImageEditStart={onImageEditStart}
              onImageEditEnd={onImageEditEnd}
            />
            <SourceToolbar
              selectedRipperId={selectedRipperId}
              canUndo={undoStack.length > 0}
              canRedo={redoStack.length > 0}
              onLoadImages={() => void loadImages()}
              onAddRipper={addRipper}
              onDeleteRipper={deleteRipper}
              onExtract={() => void extractSelected()}
              onUndo={undo}
              onRedo={redo}
            />
          </div>
        </TiledPanel>
        <TiledPanel title={PANEL_TITLES.atlas} description={PANEL_DESCRIPTIONS.atlas} {...panelProps("atlas")}>
          <div className="panel-canvas-stack">
            <CanvasWorkspace
              kind="atlas"
              showHeader={false}
              background="grid"
              exportRegion={atlasRegion}
              title="Texture Atlas"
              emptyLabel="Extracted textures appear here"
              images={atlasImages}
              selectedImageId={selectedAtlasImageId}
              view={atlasView}
              livePreview={livePreviewRef}
              onViewChange={setAtlasView}
              onSelectImage={setSelectedAtlasImageId}
              onMoveImage={moveAtlasImage}
              onScaleImage={scaleAtlasImage}
              onRotateImage={rotateAtlasImage}
              onImageContextMenu={onAtlasImageContextMenu}
              onImageEditStart={onImageEditStart}
              onImageEditEnd={onImageEditEnd}
            />
            <AtlasToolbar
              hasSelection={Boolean(selectedAtlasImage)}
              hasImages={atlasImages.length > 0}
              sizeWidth={atlasSizeWidth}
              sizeHeight={atlasSizeHeight}
              square={atlasSquare}
              onSetWidth={(value) => setAtlasManualSize((prev) => ({ width: value, height: prev?.height ?? atlasSizeHeight }))}
              onSetHeight={(value) => setAtlasManualSize((prev) => ({ width: prev?.width ?? atlasSizeWidth, height: value }))}
              onToggleSquare={() => setAtlasSquare((value) => !value)}
              onPack={packAtlasImages}
              onExportSelected={() => void exportSelected()}
              onExportAll={() => void exportAll()}
              onExportAtlas={() => void exportAtlas()}
            />
          </div>
        </TiledPanel>
        <TiledPanel title={PANEL_TITLES.tools} {...panelProps("tools")}>
          <SidePanel
            selectedImage={selectedAtlasImage}
            textureCount={atlasImages.length}
            computeAdjusted={computeAdjusted}
            onApply={() => void applyAdjustments()}
            onApplyToAll={() => void applyAdjustmentsToAll()}
            onUpdateSettings={updateSelectedSettings}
          />
        </TiledPanel>
        {dragging && dropPreviewArea && (
          <div className="tile-drop-preview" style={{ gridArea: dropPreviewArea }} aria-hidden="true">
            <div className="tile-drop-preview__titlebar">
              <span className="pixel-check" />
              <span>{PANEL_TITLES[dragging]}</span>
            </div>
            <div className="tile-drop-preview__body" />
          </div>
        )}
        <button
          className="layout-splitter layout-splitter--vertical"
          type="button"
          aria-label="Resize panel columns"
          title="Resize panel columns"
          onPointerDown={(event) => beginLayoutResize("x", event)}
        />
        {span ? (
          <button
            className="layout-splitter layout-splitter--stack"
            type="button"
            aria-label="Resize stacked panels"
            title="Resize stacked panels"
            onPointerDown={(event) => beginLayoutResize("stackY", event)}
          />
        ) : (
          <button
            className="layout-splitter layout-splitter--horizontal"
            type="button"
            aria-label="Resize panel rows"
            title="Resize panel rows"
            onPointerDown={(event) => beginLayoutResize("y", event)}
          />
        )}
      </div>
      {ripperMenu && (() => {
        const menuRipper = rippers.find((item) => item.id === ripperMenu.ripperId);
        if (!menuRipper) return null;
        const conserving = shouldConserve(menuRipper);
        return (
          <>
            <div className="context-menu__backdrop" onPointerDown={() => setRipperMenu(null)} onContextMenu={(event) => { event.preventDefault(); setRipperMenu(null); }} />
            <ul className="context-menu" style={{ left: ripperMenu.x, top: ripperMenu.y }} role="menu" aria-label="Ripper options">
              <li role="none">
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={conserving}
                  onClick={() => { toggleConserveShape(ripperMenu.ripperId); setRipperMenu(null); }}
                >
                  {conserving ? "✓ " : " "}Preserve curved shape
                </button>
              </li>
            </ul>
          </>
        );
      })()}
      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
    </main>
  );
}

function makeWorkspaceImage(name: string, image: PixelImage, position: Vec2, isAtlas: boolean, id = createId(isAtlas ? "atlas" : "source")): WorkspaceImageState {
  return {
    id,
    name,
    image: cloneForState(image),
    originalImage: cloneForState(image),
    position,
    scale: { x: 1, y: 1 },
    rotation: 0,
    settings: { ...defaultTextureSettings },
    version: 0
  };
}

function toAtlasItem(image: WorkspaceImageState): AtlasItem {
  return { image: image.image, position: image.position, scale: image.scale, rotation: image.rotation };
}

// Place a rasterized atlas at the top-left of a larger transparent canvas so the
// exported file matches the manual/square size shown by the white outline.
function padImageTopLeft(image: PixelImage, width: number, height: number): PixelImage {
  if (image.width === width && image.height === height) return image;
  const output = makeImage(width, height);
  const copyWidth = Math.min(width, image.width);
  const copyHeight = Math.min(height, image.height);
  for (let y = 0; y < copyHeight; y += 1) {
    for (let x = 0; x < copyWidth; x += 1) {
      setPixel(output, x, y, getPixel(image, x, y));
    }
  }
  return output;
}

function atlasDropPosition(index: number): Vec2 {
  const column = index % 4;
  const row = Math.floor(index / 4);
  return { x: column * 140, y: -row * 140 };
}

const SOURCE_TILE_GAP = 24;

// World-space bounding box of placed images (centres + half-extents). `top` is
// the largest y, `bottom` the smallest, since world y points up.
function imagesBounds(images: WorkspaceImageState[]): { left: number; right: number; top: number; bottom: number } {
  let left = Infinity;
  let right = -Infinity;
  let top = -Infinity;
  let bottom = Infinity;
  for (const image of images) {
    const halfW = (image.image.width * Math.abs(image.scale.x)) / 2;
    const halfH = (image.image.height * Math.abs(image.scale.y)) / 2;
    left = Math.min(left, image.position.x - halfW);
    right = Math.max(right, image.position.x + halfW);
    top = Math.max(top, image.position.y + halfH);
    bottom = Math.min(bottom, image.position.y - halfH);
  }
  return { left, right, top, bottom };
}

// Lay a freshly added batch out as a shelf-packed grid: images flow left→right
// and wrap to a new row once a row gets too wide, so they sit side by side
// instead of stacking on top of each other. The batch is dropped to the right
// of whatever is already placed (or centred on the origin when the workspace is
// empty), so loading/pasting more images grows the layout sideways.
function layoutAppendedImages(
  existing: WorkspaceImageState[],
  incoming: Array<{ name: string; image: PixelImage }>
): Vec2[] {
  const gap = SOURCE_TILE_GAP;
  const sizes = incoming.map((item) => ({ w: item.image.width, h: item.image.height }));
  // Wrap width chosen to keep the batch roughly square; never narrower than the
  // widest single image so nothing is forced to overflow its own row.
  const totalArea = sizes.reduce((sum, size) => sum + size.w * size.h, 0);
  const widest = Math.max(...sizes.map((size) => size.w));
  const maxRowWidth = Math.max(widest, Math.sqrt(totalArea) * 1.3);

  // Pack relative to a (0,0) top-left origin: rows step downward (−y).
  const centers: Vec2[] = [];
  let cursorX = 0;
  let rowTop = 0;
  let rowHeight = 0;
  let boxRight = 0;
  let boxBottom = 0;
  for (const size of sizes) {
    if (cursorX > 0 && cursorX + size.w > maxRowWidth) {
      cursorX = 0;
      rowTop -= rowHeight + gap;
      rowHeight = 0;
    }
    centers.push({ x: cursorX + size.w / 2, y: rowTop - size.h / 2 });
    cursorX += size.w + gap;
    rowHeight = Math.max(rowHeight, size.h);
    boxRight = Math.max(boxRight, cursorX - gap);
    boxBottom = Math.min(boxBottom, rowTop - rowHeight);
  }

  // Translate the packed box into place.
  let offsetX: number;
  let offsetY: number;
  if (existing.length > 0) {
    const bounds = imagesBounds(existing);
    offsetX = bounds.right + gap;
    offsetY = bounds.top;
  } else {
    offsetX = -boxRight / 2;
    offsetY = -boxBottom / 2;
  }
  return centers.map((center) => ({ x: center.x + offsetX, y: center.y + offsetY }));
}

function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];

  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (itemFiles.length > 0) return itemFiles;

  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

function clipboardImageName(file: File, index: number): string {
  const name = file.name.trim();
  if (name) return name;
  return `clipboard_${index + 1}.${extensionForMime(file.type)}`;
}

function extensionForMime(type: string): string {
  switch (type.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
}

function sourceImageSignature(image: WorkspaceImageState): string {
  return [
    image.id,
    formatNumber(image.position.x),
    formatNumber(image.position.y),
    formatNumber(image.scale.x),
    formatNumber(image.scale.y),
    formatNumber(image.rotation),
    image.image.width,
    image.image.height,
    image.version
  ].join(":");
}

// A cheap structural fingerprint of a snapshot, used to tell whether a pointer
// interaction actually changed anything before recording an undo step.
function snapshotSignature(state: HistorySnapshot): string {
  return [
    state.sourceImages.map(sourceImageSignature).join("|"),
    state.atlasImages.map(sourceImageSignature).join("|"),
    state.rippers.map(ripperSignature).join("|"),
    state.selectedSourceImageId ?? "",
    state.selectedAtlasImageId ?? "",
    state.selectedRipperId ?? ""
  ].join("§");
}

function ripperSignature(ripper: RipperState): string {
  return [
    ripper.id,
    ...ripper.points.flatMap((point) => [formatNumber(point.x), formatNumber(point.y)]),
    // Fold in per-edge curve controls so curve create/move/remove re-extracts and
    // registers as a real change for undo detection. "_" marks a straight edge.
    ...[0, 1, 2, 3].map((edge) => {
      const curve = ripper.edgeCurves?.[edge];
      return curve
        ? `${formatNumber(curve[0].x)},${formatNumber(curve[0].y)},${formatNumber(curve[1].x)},${formatNumber(curve[1].y)}`
        : "_";
    }),
    // Conserve toggle changes extraction output, so it must re-extract / count as
    // a change. Default-on for curved rippers (see core shouldConserve).
    `c${ripper.conserveShape === false ? "0" : "1"}`
  ].join(":");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
