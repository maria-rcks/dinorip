import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { VIEWPORT_MAX_ZOOM, VIEWPORT_MIN_ZOOM } from "@dinorip/ipc-contracts";
import type { MenuCommand, UpdateState } from "@dinorip/ipc-contracts";
import {
  computeAtlasBounds,
  createRipper,
  deleteRipperPoint,
  packAtlasPositions,
  findOwnerImageIndex,
  getPixel,
  insertRipperPoint,
  inferExtractionSize,
  isRipperCurved,
  makeImage,
  MIN_RIPPER_POINTS,
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
import { CanvasWorkspace, WORKSPACE_RENDER_EVENT } from "./workspaces/CanvasWorkspace";
import type { WorkspaceLivePreview } from "./workspaces/CanvasWorkspace";
import { SidePanel } from "./panels/SidePanel";
import { TiledPanel } from "./panels/TiledPanel";
import { usePanelLayout } from "./panels/usePanelLayout";
import type { LayoutResizePart, PanelId } from "./panels/usePanelLayout";
import { AtlasToolbar, SourceToolbar } from "./panels/PixelToolbars";
import { ShortcutsOverlay } from "./panels/ShortcutsOverlay";
import {
  getUpdateVersion,
  isUpdateActionable,
  shouldShowUpdateModal,
  UpdateIndicator,
  UpdateModal
} from "./panels/UpdateOverlay";
import { defaultTextureSettings, defaultViewState } from "./renderer/types";
import type { RipperState, TextureSettings, ViewState, WorkspaceImageState, WorkspaceKind } from "./renderer/types";
import { cloneForState, fromIpcImage, pixelImageFromBlob, toIpcImage } from "./renderer/imageCanvas";
import { gpuExtractPerspective, gpuRenderLivePreview, isGpuExtractAvailable } from "./renderer/gpuExtract";
import {
  recordAsyncCommit,
  recordStaleExtractionSkipped,
  recordSyncExtraction
} from "./renderer/perf";

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
const GPU_COMMIT_PIXEL_LIMIT = 300_000;
const MAX_COMMIT_PIXEL_LIMIT = 300_000;
const LIVE_PREVIEW_MAX_RENDER_SIZE = 1024;
const LIVE_PREVIEW_PIXEL_LIMIT = 300_000;

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
  selectedAtlasImageIds: string[];
  selectedRipperIds: string[];
}

interface SerializedPixelImage {
  width: number;
  height: number;
  data: string;
}

interface SerializedWorkspaceImage {
  id: string;
  name: string;
  image: SerializedPixelImage;
  originalImage: SerializedPixelImage;
  position: Vec2;
  scale: Vec2;
  rotation: number;
  settings: TextureSettings;
  version: number;
}

interface ProjectFile {
  format: "dinorip-project";
  version: 1;
  sourceImages: SerializedWorkspaceImage[];
  atlasImages: SerializedWorkspaceImage[];
  rippers: RipperState[];
  sourceView: ViewState;
  atlasView: ViewState;
  atlasManualSize: { width: number; height: number } | null;
  atlasSquare: boolean;
  selectedSourceImageId?: string;
  selectedAtlasImageId?: string;
  selectedRipperId?: string;
  selectedAtlasImageIds?: string[];
  selectedRipperIds?: string[];
}

interface ImageContextMenu {
  kind: WorkspaceKind;
  imageId: string;
  x: number;
  y: number;
}

interface AppState extends HistorySnapshot {
  imageMenu: ImageContextMenu | null;
  atlasManualSize: { width: number; height: number } | null;
  atlasSquare: boolean;
  sourceView: ViewState;
  atlasView: ViewState;
  status: string;
  showShortcuts: boolean;
  resizingPart: LayoutResizePart | null;
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];
}

// AppState fields are data-only. The reducer uses `typeof value === "function"`
// to support functional updaters, so adding function-valued state would need a
// different action shape.
type AppStateValue<K extends keyof AppState> = AppState[K] | ((current: AppState[K]) => AppState[K]);
type RefMirroredAppStateKey = "sourceImages" | "rippers";
type PlainAppStateKey = Exclude<keyof AppState, RefMirroredAppStateKey>;
type AppStateSetAction<K extends keyof AppState> = { type: "set"; key: K; value: AppStateValue<K> };

type AppStateAction =
  | { [K in PlainAppStateKey]-?: AppStateSetAction<K> }[PlainAppStateKey]
  | { [K in RefMirroredAppStateKey]-?: AppStateSetAction<K> & { refMirrored: true } }[RefMirroredAppStateKey]
  | { type: "resetBenchmarkWorkspace" };

const initialAppState: AppState = {
  sourceImages: [],
  atlasImages: [],
  rippers: [],
  selectedSourceImageId: undefined,
  selectedAtlasImageId: undefined,
  selectedRipperId: undefined,
  selectedAtlasImageIds: [],
  selectedRipperIds: [],
  imageMenu: null,
  atlasManualSize: null,
  atlasSquare: false,
  sourceView: defaultViewState,
  atlasView: defaultViewState,
  status: "",
  showShortcuts: false,
  resizingPart: null,
  undoStack: [],
  redoStack: []
};

function appStateReducer(state: AppState, action: AppStateAction): AppState {
  if (action.type === "resetBenchmarkWorkspace") {
    return {
      ...state,
      sourceImages: [],
      atlasImages: [],
      rippers: [],
      selectedSourceImageId: undefined,
      selectedAtlasImageId: undefined,
      selectedRipperId: undefined,
      selectedAtlasImageIds: [],
      selectedRipperIds: [],
      undoStack: [],
      redoStack: [],
      imageMenu: null,
      sourceView: defaultViewState,
      atlasView: defaultViewState,
      status: "Benchmark reset"
    };
  }

  // `sourceImages` and `rippers` are mirrored into refs so pointer-up
  // finalization can read geometry before React commits the next render. Any
  // reducer write to those keys must go through setSourceImages/setRippers, or
  // must update the matching ref before dispatching.
  const current = state[action.key];
  const value = action.value;
  const next = typeof value === "function" ? (value as (currentValue: typeof current) => typeof current)(current) : value;
  return Object.is(current, next) ? state : { ...state, [action.key]: next };
}

type ResolvedExtraction = {
  ripper: RipperState;
  index: number;
  outputImageId: string;
  outputSize: ExtractionOutputSize;
  result: ExtractionResult;
};

type ExtractionJob = {
  ripper: RipperState;
  index: number;
  outputImageId: string;
  outputSize: ExtractionOutputSize;
};

type ExtractionOutputSize = {
  width: number;
  height: number;
  pixels: number;
};

type MutableRef<T> = {
  current: T;
};

function useLazyRef<T>(factory: () => T): MutableRef<T> {
  const ref = useRef<T | null>(null);
  if (ref.current === null) ref.current = factory();
  return ref as MutableRef<T>;
}

function requestCanvasRender() {
  window.dispatchEvent(new Event(WORKSPACE_RENDER_EVENT));
}

function toPlacedImages(sourceSnapshot: WorkspaceImageState[]): PlacedImage[] {
  return sourceSnapshot.map((image) => ({
    image: image.image,
    position: image.position,
    scale: image.scale
  }));
}

function buildExtractionInputs(ripperSnapshot: RipperState[], sourceSnapshot: WorkspaceImageState[]) {
  const sourceItems = toPlacedImages(sourceSnapshot);
  const allJobs = ripperSnapshot.map((ripper, index): ExtractionJob => ({
    ripper,
    index,
    outputImageId: ripper.outputImageId ?? createId("atlas"),
    outputSize: extractionOutputSize(ripper)
  }));
  const jobs: ExtractionJob[] = [];
  const skipped: ExtractionJob[] = [];
  for (const job of allJobs) {
    if (job.outputSize.pixels <= MAX_COMMIT_PIXEL_LIMIT) jobs.push(job);
    else skipped.push(job);
  }
  return { sourceItems, jobs, skipped };
}

function extractionOutputSize(ripper: RipperState): ExtractionOutputSize {
  const size = inferExtractionSize(ripper);
  return {
    width: size.width,
    height: size.height,
    pixels: size.width * size.height
  };
}

function tooLargeStatus(size: Pick<ExtractionOutputSize, "width" | "height">): string {
  return `Texture too large to finalize ${size.width} x ${size.height}`;
}

function ripperSignaturesForIds(rippers: RipperState[], ids: string[]): string {
  const idSet = new Set(ids);
  const signatures: string[] = [];
  for (const ripper of rippers) {
    if (idSet.has(ripper.id)) signatures.push(ripperSignature(ripper));
  }
  return signatures.join("|");
}

export function App(): ReactElement {
  return useApp();
}

function useApp(): ReactElement {
  const [appState, dispatchAppState] = useReducer(appStateReducer, initialAppState);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string | null>(null);
  const updateActionInFlightRef = useRef(false);
  const {
    sourceImages,
    atlasImages,
    rippers,
    selectedSourceImageId,
    selectedAtlasImageId,
    selectedRipperId,
    selectedAtlasImageIds,
    selectedRipperIds,
    imageMenu,
    atlasManualSize,
    atlasSquare,
    sourceView,
    atlasView,
    status,
    showShortcuts,
    resizingPart,
    undoStack,
    redoStack
  } = appState;
  const setAppState = <K extends PlainAppStateKey>(key: K, value: AppStateValue<K>) => {
    dispatchAppState({ type: "set", key, value } as AppStateAction);
  };
  // Setter wrappers mirror React state into refs immediately, so pointer-up
  // finalization can bake the newest geometry even before the next render lands.
  const setSourceImages = (value: AppStateValue<"sourceImages">) => {
    const next = typeof value === "function"
      ? (value as (current: WorkspaceImageState[]) => WorkspaceImageState[])(latestSourceImagesRef.current)
      : value;
    latestSourceImagesRef.current = next;
    dispatchAppState({ type: "set", key: "sourceImages", value: next, refMirrored: true });
  };
  const setAtlasImages = (value: AppStateValue<"atlasImages">) => setAppState("atlasImages", value);
  const setRippers = (value: AppStateValue<"rippers">) => {
    const next = typeof value === "function"
      ? (value as (current: RipperState[]) => RipperState[])(latestRippersRef.current)
      : value;
    latestRippersRef.current = next;
    dispatchAppState({ type: "set", key: "rippers", value: next, refMirrored: true });
  };
  const setSelectedSourceImageId = (value: AppStateValue<"selectedSourceImageId">) => setAppState("selectedSourceImageId", value);
  const setSelectedAtlasImageId = (value: AppStateValue<"selectedAtlasImageId">) => setAppState("selectedAtlasImageId", value);
  const setSelectedRipperId = (value: AppStateValue<"selectedRipperId">) => setAppState("selectedRipperId", value);
  const setSelectedAtlasImageIds = (value: AppStateValue<"selectedAtlasImageIds">) => setAppState("selectedAtlasImageIds", value);
  const setSelectedRipperIds = (value: AppStateValue<"selectedRipperIds">) => setAppState("selectedRipperIds", value);
  const setImageMenu = (value: AppStateValue<"imageMenu">) => setAppState("imageMenu", value);
  const setAtlasManualSize = (value: AppStateValue<"atlasManualSize">) => setAppState("atlasManualSize", value);
  const setAtlasSquare = (value: AppStateValue<"atlasSquare">) => setAppState("atlasSquare", value);
  const setSourceView = (value: AppStateValue<"sourceView">) => setAppState("sourceView", value);
  const setAtlasView = (value: AppStateValue<"atlasView">) => setAppState("atlasView", value);
  const setStatus = (value: AppStateValue<"status">) => setAppState("status", value);
  const setShowShortcuts = (value: AppStateValue<"showShortcuts">) => setAppState("showShortcuts", value);
  const setResizingPart = (value: AppStateValue<"resizingPart">) => setAppState("resizingPart", value);
  const setUndoStack = (value: AppStateValue<"undoStack">) => setAppState("undoStack", value);
  const setRedoStack = (value: AppStateValue<"redoStack">) => setAppState("redoStack", value);
  const currentProjectPathRef = useRef<string | undefined>(undefined);
  const latestSourceImagesRef = useRef<WorkspaceImageState[]>(sourceImages);
  const latestRippersRef = useRef<RipperState[]>(rippers);
  const tilesRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const resizeFrame = useRef(0);
  const pendingResize = useRef<{ part: LayoutResizePart; clientX: number; clientY: number } | null>(null);
  const resizeListeners = useRef<{
    move(event: PointerEvent): void;
    end(event: PointerEvent): void;
  } | null>(null);
  const autoExtractRun = useRef(0);
  const pendingJobs = useLazyRef(() => new Map<string, { resolve: (value: any) => void; reject: (reason: Error) => void }>());
  const pendingJobsMap = pendingJobs.current;
  // Live GPU projection shown in place of the atlas image while a ripper is
  // dragged. Mutated through setLivePreview(), which explicitly redraws canvases.
  const livePreviewRef = useRef<WorkspaceLivePreview | null>(null);
  const editingRipperIdRef = useRef<string | null>(null);
  const editingRipperIdsRef = useRef<string[]>([]);
  // Geometry signature of the ripper at the moment an edit began. Lets edit-end
  // tell a real drag from a click that only selected the ripper, so a pure
  // selection skips the full-resolution re-extraction entirely.
  const editStartSignatureRef = useRef<string | null>(null);

  // Undo/redo history. Each entry is a full workspace snapshot; the stacks are
  // React state so the toolbar buttons can reflect whether they are available.
  // `interactionSnapshot` holds the pre-drag state for a single pointer
  // interaction so a drag becomes one undo step (and a click that moves nothing
  // records none).
  const interactionSnapshot = useRef<HistorySnapshot | null>(null);

  latestSourceImagesRef.current = sourceImages;
  latestRippersRef.current = rippers;

  useEffect(() => {
    let mounted = true;
    let receivedPush = false;
    const unsubscribe = window.dinorip.onUpdateState((state) => {
      receivedPush = true;
      if (mounted) setUpdateState(state);
    });
    void window.dinorip.getUpdateState().then((state) => {
      if (mounted && !receivedPush) setUpdateState(state);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const version = getUpdateVersion(updateState);
    if (dismissedUpdateVersion && dismissedUpdateVersion !== version) {
      setDismissedUpdateVersion(null);
    }
  }, [dismissedUpdateVersion, updateState]);

  function updateCurrentProjectPath(path: string | undefined) {
    currentProjectPathRef.current = path;
  }

  function setLivePreview(preview: WorkspaceLivePreview | null) {
    livePreviewRef.current = preview;
    requestCanvasRender();
  }

  function clearLivePreviews() {
    setLivePreview(null);
  }

  function clearLivePreviewIfCached(imageId: string) {
    if (livePreviewRef.current?.imageId === imageId) setLivePreview(null);
  }

  function scheduleLivePreviewFallback(imageId: string | undefined) {
    if (!imageId) return;
    window.setTimeout(() => {
      if (editingRipperIdRef.current !== null) return;
      if (livePreviewRef.current?.imageId === imageId) setLivePreview(null);
    }, 2000);
  }

  function snapshot(): HistorySnapshot {
    return {
      sourceImages: latestSourceImagesRef.current,
      atlasImages,
      rippers: latestRippersRef.current,
      selectedSourceImageId,
      selectedAtlasImageId,
      selectedRipperId,
      selectedAtlasImageIds,
      selectedRipperIds
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
    clearLivePreviews();
    editingRipperIdRef.current = null;
    editingRipperIdsRef.current = [];
    interactionSnapshot.current = null;
    setSourceImages(state.sourceImages);
    setAtlasImages(state.atlasImages);
    setRippers(state.rippers);
    setSelectedSourceImageId(state.selectedSourceImageId);
    setSelectedAtlasImageId(state.selectedAtlasImageId);
    setSelectedRipperId(state.selectedRipperId);
    setSelectedAtlasImageIds(state.selectedAtlasImageIds);
    setSelectedRipperIds(state.selectedRipperIds);
    setImageMenu(null);
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
      const pending = pendingJobsMap.get(response.id);
      if (!pending) return;
      pendingJobsMap.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [pendingJobsMap]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const api = {
      loadBenchmarkSource: (name: string, image: PixelImage) => {
        appendSourceImages([{ name, image }]);
        const fitZoom = Math.min(1, 520 / Math.max(image.width, image.height));
        setSourceView({ zoom: clamp(fitZoom, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM), pan: { x: 0, y: 0 } });
        setStatus(`Benchmark loaded ${image.width} x ${image.height}`);
      },
      resetBenchmarkWorkspace: () => {
        autoExtractRun.current += 1;
        clearLivePreviews();
        editingRipperIdRef.current = null;
        editingRipperIdsRef.current = [];
        editStartSignatureRef.current = null;
        interactionSnapshot.current = null;
        updateCurrentProjectPath(undefined);
        latestSourceImagesRef.current = [];
        latestRippersRef.current = [];
        dispatchAppState({ type: "resetBenchmarkWorkspace" });
      }
    };
    window.__dinoripDev = api;
    return () => {
      if (window.__dinoripDev === api) window.__dinoripDev = undefined;
    };
  });

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

      if (mod && key === "s") {
        event.preventDefault();
        void saveProject();
        return;
      }

      if (mod && key === "o") {
        event.preventDefault();
        if (event.shiftKey) void loadImages();
        else void openProject();
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

      if (mod && key === "a" && !typing) {
        event.preventDefault();
        selectAllActivePanel();
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

      // Delete: remove the selected object. Source/atlas image selection clears
      // competing selections, so the shortcut targets the last picked thing.
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedRipperId) {
          event.preventDefault();
          deleteRipper();
        } else if (selectedAtlasImageId) {
          event.preventDefault();
          deleteAtlasImage();
        } else if (selectedSourceImageId) {
          event.preventDefault();
          deleteSourceImage();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => window.dinorip.onMenuCommand((command: MenuCommand) => {
    switch (command) {
      case "open-project":
        void openProject();
        break;
      case "save-project":
        void saveProject();
        break;
      case "load-image":
        void loadImages();
        break;
      case "export-selected":
        void exportSelected();
        break;
      case "export-all":
        void exportAll();
        break;
      case "export-atlas":
        void exportAtlas();
        break;
      case "select-all":
        selectAllActivePanel();
        break;
      case "undo":
        undo();
        break;
      case "redo":
        redo();
        break;
      case "toggle-fullscreen":
        void window.dinorip.toggleFullscreen();
        break;
    }
  }));

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
  const extractionSnapshotRef = useLazyRef(() => ({
    sourceExtractionKey,
    ripperExtractionKey,
    sourceImages,
    rippers
  }));
  if (
    extractionSnapshotRef.current.sourceExtractionKey !== sourceExtractionKey ||
    extractionSnapshotRef.current.ripperExtractionKey !== ripperExtractionKey
  ) {
    extractionSnapshotRef.current = { sourceExtractionKey, ripperExtractionKey, sourceImages, rippers };
  }
  const selectedRipperIdRef = useRef<string | undefined>(selectedRipperId);
  selectedRipperIdRef.current = selectedRipperId;
  const extractionSnapshot = extractionSnapshotRef.current;
  const autoExtractorsRef = useRef({ autoExtractGpu, autoExtractRippers });
  autoExtractorsRef.current.autoExtractGpu = autoExtractGpu;
  autoExtractorsRef.current.autoExtractRippers = autoExtractRippers;
  const autoExtractors = autoExtractorsRef.current;

  useEffect(() => {
    const {
      sourceImages: sourceSnapshot,
      rippers: ripperSnapshot
    } = extractionSnapshot;
    if (sourceSnapshot.length === 0 || ripperSnapshot.length === 0) return;
    const selectedRipperSnapshot = selectedRipperIdRef.current;
    const runId = autoExtractRun.current + 1;
    autoExtractRun.current = runId;
    // The GPU path is fast enough to project live, so coalesce a burst of
    // pointer-move updates into the next animation frame and extract with no
    // perceptible debounce. The CPU/worker path stays debounced as a fallback.
    if (isGpuExtractAvailable()) {
      const frame = window.requestAnimationFrame(() => {
        if (autoExtractRun.current !== runId) {
          recordStaleExtractionSkipped();
          return;
        }
        const editingId = editingRipperIdRef.current;
        const editingRipper = editingId ? ripperSnapshot.find((item) => item.id === editingId) : undefined;
        // While dragging an already-extracted ripper, project only the grabbed
        // ripper live. Multi-selected rippers still finalize together on release
        // without paying live-preview cost for every selected item per frame.
        if (editingRipper?.outputImageId) {
          const previewSize = inferExtractionSize(editingRipper);
          const canRenderLivePreview = previewSize.width * previewSize.height <= LIVE_PREVIEW_PIXEL_LIMIT;
          const preview = canRenderLivePreview
              ? gpuRenderLivePreview(editingRipper, toPlacedImages(sourceSnapshot), LIVE_PREVIEW_MAX_RENDER_SIZE)
            : null;
          if (preview) {
            setLivePreview({ imageId: editingRipper.outputImageId, ...preview });
            return;
          }
        }
        // If a brand-new or too-large ripper is being dragged, defer the full
        // bake to pointer-up. Readbacks on every move are the freeze case.
        if (editingRipper) {
          setLivePreview(null);
          return;
        }
        // Otherwise bake into state (creates the atlas image, refines to full
        // resolution, and feeds the export/seamless pipeline).
        autoExtractors.autoExtractGpu(runId, ripperSnapshot, sourceSnapshot, selectedRipperSnapshot);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const timeout = window.setTimeout(() => {
      autoExtractors.autoExtractRippers(runId, ripperSnapshot, sourceSnapshot, selectedRipperSnapshot);
    }, AUTO_EXTRACT_DELAY_MS);
    return () => window.clearTimeout(timeout);
    // Deliberately not keyed on `selectedRipperId`: only geometry/source changes
    // need a re-extraction. Selecting a ripper must not re-project every ripper
    // (that re-rasterizes the atlas and is what made clicking a ripper lag).
  }, [autoExtractors, extractionSnapshot, ripperExtractionKey, sourceExtractionKey]);

  useEffect(() => () => {
    if (resizeFrame.current !== 0) window.cancelAnimationFrame(resizeFrame.current);
    removeResizeListeners();
  }, []);

  const runWorker = useCallback(<T,>(message: Omit<Record<string, unknown>, "id">): Promise<T> => {
    const worker = workerRef.current;
    if (!worker) throw new Error("Processing worker is not ready.");
    const id = createId("job");
    const promise = new Promise<T>((resolve, reject) => {
      pendingJobsMap.set(id, { resolve, reject });
    });
    worker.postMessage({ id, ...message });
    return promise;
  }, [pendingJobsMap]);

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

  async function saveProject() {
    try {
      const contents = JSON.stringify(projectFromState());
      const result = await window.dinorip.saveProject({
        defaultName: "dinorip-project",
        path: currentProjectPathRef.current,
        contents
      });
      if (result.canceled) {
        setStatus("Save project canceled");
        return;
      }
      const savedPath = result.paths[0];
      if (savedPath) updateCurrentProjectPath(savedPath);
      setStatus(savedPath ? `Project saved: ${fileNameFromPath(savedPath)}` : "Project saved");
    } catch (error) {
      setStatus(`Project save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function openProject() {
    try {
      const result = await window.dinorip.openProject();
      if (result.canceled || !result.contents) {
        setStatus("Open project canceled");
        return;
      }
      loadProject(JSON.parse(result.contents) as ProjectFile);
      updateCurrentProjectPath(result.path);
      setStatus(`Project loaded${result.path ? `: ${fileNameFromPath(result.path)}` : ""}`);
    } catch (error) {
      setStatus(`Project load failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function projectFromState(): ProjectFile {
    return {
      format: "dinorip-project",
      version: 1,
      sourceImages: sourceImages.map(serializeWorkspaceImage),
      atlasImages: atlasImages.map(serializeWorkspaceImage),
      rippers,
      sourceView,
      atlasView,
      atlasManualSize,
      atlasSquare,
      selectedSourceImageId,
      selectedAtlasImageId,
      selectedRipperId,
      selectedAtlasImageIds,
      selectedRipperIds
    };
  }

  function loadProject(project: ProjectFile) {
    if (project.format !== "dinorip-project" || project.version !== 1) {
      throw new Error("Unsupported project file.");
    }
    autoExtractRun.current += 1;
    clearLivePreviews();
    editingRipperIdRef.current = null;
    editingRipperIdsRef.current = [];
    editStartSignatureRef.current = null;
    interactionSnapshot.current = null;
    setSourceImages(project.sourceImages.map(deserializeWorkspaceImage));
    setAtlasImages(project.atlasImages.map(deserializeWorkspaceImage));
    setRippers(project.rippers);
    setSourceView(project.sourceView);
    setAtlasView(project.atlasView);
    setAtlasManualSize(project.atlasManualSize);
    setAtlasSquare(project.atlasSquare);
    setSelectedSourceImageId(project.selectedSourceImageId);
    setSelectedAtlasImageId(project.selectedAtlasImageId);
    setSelectedRipperId(project.selectedRipperId);
    setSelectedAtlasImageIds(project.selectedAtlasImageIds ?? compactIds([project.selectedAtlasImageId]));
    setSelectedRipperIds(project.selectedRipperIds ?? compactIds([project.selectedRipperId]));
    setUndoStack([]);
    setRedoStack([]);
    setImageMenu(null);
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
    setSelectedAtlasImageId(undefined);
    setSelectedAtlasImageIds([]);
    setSelectedRipperId(undefined);
    setSelectedRipperIds([]);
  }

  function addRipper() {
    commitHistory();
    const center = { x: -sourceView.pan.x / sourceView.zoom, y: sourceView.pan.y / sourceView.zoom };
    const ripper = createRipper(center, RIPPER_WORLD_SIZE);
    const next: RipperState = { id: createId("ripper"), points: ripper.points };
    setRippers((current) => [...current, next]);
    setSelectedRipperId(next.id);
    setSelectedRipperIds([next.id]);
    setSelectedSourceImageId(undefined);
    setSelectedAtlasImageId(undefined);
    setSelectedAtlasImageIds([]);
    setStatus(sourceImages.length > 0 ? "Ripper added; extracting..." : "Ripper added");
  }

  function deleteRipper() {
    const ids = selectedRipperIds.length > 0 ? selectedRipperIds : compactIds([selectedRipperId]);
    if (ids.length === 0) return;
    commitHistory();
    clearLivePreviews();
    setImageMenu(null);
    const idSet = new Set(ids);
    const outputIds = new Set<string>();
    for (const item of rippers) {
      if (idSet.has(item.id) && item.outputImageId) outputIds.add(item.outputImageId);
    }
    setRippers((current) => current.filter((item) => !idSet.has(item.id)));
    if (outputIds.size > 0) setAtlasImages((current) => current.filter((item) => !outputIds.has(item.id)));
    setSelectedRipperId(undefined);
    setSelectedRipperIds([]);
    if (selectedAtlasImageId && outputIds.has(selectedAtlasImageId)) setSelectedAtlasImageId(undefined);
    setSelectedAtlasImageIds((current) => current.filter((id) => !outputIds.has(id)));
    setStatus(ids.length === 1 ? "Ripper deleted" : `${ids.length} rippers deleted`);
  }

  async function extractSelected() {
    const ripper = rippers.find((item) => item.id === selectedRipperId);
    if (!ripper) return;
    if (sourceImages.length === 0) {
      setStatus("Load a source image first");
      return;
    }

    const outputSize = extractionOutputSize(ripper);
    if (outputSize.pixels > MAX_COMMIT_PIXEL_LIMIT) {
      setStatus(tooLargeStatus(outputSize));
      return;
    }

    clearLivePreviews();
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
      setSelectedAtlasImageIds([existingOutputId]);
    } else {
      const atlasImage = makeWorkspaceImage(`texture_${atlasImages.length}`, result.image, atlasDropPosition(atlasImages.length), true);
      setAtlasImages((current) => [...current, atlasImage]);
      setRippers((current) => current.map((item) => item.id === ripper.id ? { ...item, outputImageId: atlasImage.id } : item));
      setSelectedAtlasImageId(atlasImage.id);
      setSelectedAtlasImageIds([atlasImage.id]);
    }
    setStatus(`Extracted ${result.image.width} x ${result.image.height}`);
  }

  function reportOversizedExtractions(skipped: ExtractionJob[], selectedRipperSnapshot?: string) {
    if (skipped.length === 0) return;
    const selected = selectedRipperSnapshot
      ? skipped.find((job) => job.ripper.id === selectedRipperSnapshot)
      : undefined;
    const largest = skipped.reduce((best, job) =>
      job.outputSize.pixels > best.outputSize.pixels ? job : best, skipped[0]!);
    const job = selected ?? largest;
    const suffix = skipped.length > 1 ? ` (${skipped.length} oversized rippers skipped)` : "";
    setStatus(`${tooLargeStatus(job.outputSize)}${suffix}`);
  }

  function applyExtraction(extracted: ResolvedExtraction[]) {
    if (extracted.length === 0) return;

    setAtlasImages((current) => {
      const next = [...current];
      const indexById = new Map(next.map((image, index) => [image.id, index]));
      let appended = 0;
      for (const item of extracted) {
        const extractedImage = item.result.image;
        const existingIndex = indexById.get(item.outputImageId) ?? -1;
        if (existingIndex >= 0) {
          const existing = next[existingIndex]!;
          // The freshly extracted image is owned and never mutated in place, so
          // it can back both fields without copying (saves two full-image copies
          // per committed texture).
          next[existingIndex] = {
            ...existing,
            image: extractedImage,
            originalImage: extractedImage,
            version: existing.version + 1
          };
        } else {
          const index = next.length;
          next.push(makeWorkspaceImage(
            `texture_${item.index}`,
            extractedImage,
            atlasDropPosition(current.length + appended),
            true,
            item.outputImageId
          ));
          indexById.set(item.outputImageId, index);
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
    if (autoExtractRun.current !== runId) {
      recordStaleExtractionSkipped();
      return;
    }
    const { sourceItems, jobs, skipped } = buildExtractionInputs(ripperSnapshot, sourceSnapshot);
    if (jobs.length === 0) {
      reportOversizedExtractions(skipped, selectedRipperSnapshot);
      return;
    }
    // Large readbacks can still stall while their buffers are realized on the UI
    // thread. Keep the synchronous GPU path for small instant updates, and send
    // larger auto-bakes through the worker instead.
    if (jobs.some((job) => job.outputSize.pixels > GPU_COMMIT_PIXEL_LIMIT)) {
      void autoExtractRippers(runId, ripperSnapshot, sourceSnapshot, selectedRipperSnapshot);
      return;
    }
    const extracted: ResolvedExtraction[] = [];
    let sawNullResult = false;
    for (const job of jobs) {
      if (autoExtractRun.current !== runId) {
        recordStaleExtractionSkipped();
        return;
      }
      const ownerIndex = findOwnerImageIndex(job.ripper, sourceItems);
      if (ownerIndex < 0) continue;
      const started = performance.now();
      const result = gpuExtractPerspective(job.ripper, sourceItems);
      recordSyncExtraction(performance.now() - started);
      if (result) extracted.push({ ...job, result });
      else sawNullResult = true;
    }
    if (autoExtractRun.current !== runId) return;
    // Ownerless rippers are legitimately empty. Only fall back when an owned
    // ripper failed to draw, which means the GPU path could not render it.
    if (sawNullResult && jobs.length > 0) {
      void autoExtractRippers(runId, ripperSnapshot, sourceSnapshot, selectedRipperSnapshot);
      return;
    }
    applyExtraction(extracted);
    reportOversizedExtractions(skipped, selectedRipperSnapshot);
  }

  function autoExtractRippers(
    runId: number,
    ripperSnapshot: RipperState[],
    sourceSnapshot: WorkspaceImageState[],
    selectedRipperSnapshot?: string
  ) {
    const { sourceItems, jobs, skipped } = buildExtractionInputs(ripperSnapshot, sourceSnapshot);
    if (jobs.length === 0) {
      reportOversizedExtractions(skipped, selectedRipperSnapshot);
      return;
    }
    if (autoExtractRun.current !== runId) return;
    void Promise.allSettled(jobs.map(async (job) => ({
      ...job,
      result: await runWorker<ExtractionResult | null>({
        type: "extract",
        ripper: job.ripper,
          images: sourceItems
        })
    }))).then((settled) => {
      if (autoExtractRun.current !== runId) return;

      const extracted = settled
        .filter((item): item is PromiseFulfilledResult<typeof jobs[number] & { result: ExtractionResult | null }> => item.status === "fulfilled")
        .map((item) => item.value)
        .filter((item): item is ResolvedExtraction => item.result !== null);
      applyExtraction(extracted);
      reportOversizedExtractions(skipped, selectedRipperSnapshot);
    });
  }

  // Bake the current adjustments into the selected texture (from its untouched
  // original, so repeated applies are not cumulative). Undoable via history.
  async function applyAdjustments() {
    const image = selectedAtlasImage;
    if (!image) return;
    commitHistory();
    clearLivePreviews();
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
    clearLivePreviews();
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
    [runWorker]
  );
  const closeShortcuts = useCallback(() => setShowShortcuts(false), []);
  const updateModalOpen = shouldShowUpdateModal(updateState, dismissedUpdateVersion);
  const openUpdateModal = useCallback(() => setDismissedUpdateVersion(null), []);
  const closeUpdateModal = useCallback(() => {
    setDismissedUpdateVersion(getUpdateVersion(updateState));
  }, [updateState]);
  const handleUpdatePrimaryAction = useCallback(() => {
    if (!updateState || updateState.status === "downloading" || updateActionInFlightRef.current) return;
    updateActionInFlightRef.current = true;
    const action = updateState.status === "downloaded" || updateState.errorContext === "install"
      ? window.dinorip.installUpdate()
      : window.dinorip.downloadUpdate();
    void action
      .then((result) => {
        setUpdateState(result.state);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Update action failed";
        setStatus(message);
      })
      .finally(() => {
        updateActionInFlightRef.current = false;
      });
  }, [updateState]);

  async function exportSelected() {
    const images = selectedAtlasImageIds.length > 1
      ? atlasImages.filter((image) => selectedAtlasImageIds.includes(image.id))
      : selectedAtlasImage ? [selectedAtlasImage] : [];
    if (images.length === 0) return;
    if (images.length > 1) {
      const result = await window.dinorip.exportAllPng({
        images: images.map((image) => toIpcImage(image.image))
      });
      setStatus(result.canceled ? "Export selected canceled" : `Exported ${result.paths.length} selected textures`);
      return;
    }
    const image = images[0]!;
    const result = await window.dinorip.savePng({
      defaultName: "texture",
      image: toIpcImage(image.image)
    });
    setStatus(result.canceled ? "Export canceled" : "Texture exported");
  }

  async function exportAll() {
    if (atlasImages.length === 0) return;
    const result = await window.dinorip.exportAllPng({
      images: atlasImages.map((image) => toIpcImage(image.image))
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

  function deleteSourceImage(id = selectedSourceImageId) {
    if (!id || !sourceImages.some((image) => image.id === id)) return;
    commitHistory();
    clearLivePreviews();
    setImageMenu(null);
    setSourceImages((current) => current.filter((image) => image.id !== id));
    if (selectedSourceImageId === id) setSelectedSourceImageId(undefined);
    setStatus("Source image deleted");
  }

  function deleteAtlasImage(id = selectedAtlasImageId) {
    const ids = id && selectedAtlasImageIds.includes(id) && selectedAtlasImageIds.length > 1
      ? selectedAtlasImageIds
      : compactIds([id]);
    if (ids.length === 0 || !ids.some((item) => atlasImages.some((image) => image.id === item))) return;
    commitHistory();
    clearLivePreviews();
    setImageMenu(null);
    setAtlasImages((current) => current.filter((image) => !ids.includes(image.id)));
    setRippers((current) => current.map((ripper) => ripper.outputImageId && ids.includes(ripper.outputImageId)
      ? { ...ripper, outputImageId: undefined }
      : ripper));
    if (selectedAtlasImageId && ids.includes(selectedAtlasImageId)) setSelectedAtlasImageId(undefined);
    setSelectedAtlasImageIds((current) => current.filter((item) => !ids.includes(item)));
    setStatus(ids.length === 1 ? "Atlas image deleted" : `${ids.length} atlas textures deleted`);
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

  function moveAtlasImages(updates: Array<{ id: string; position: Vec2 }>) {
    if (updates.length === 0) return;
    const byId = new Map(updates.map((update) => [update.id, update.position]));
    setAtlasImages((current) => current.map((image) => {
      const position = byId.get(image.id);
      return position ? { ...image, position } : image;
    }));
  }

  function scaleSourceImage(id: string, scale: Vec2) {
    setSourceImages((current) => current.map((image) => image.id === id ? { ...image, scale } : image));
  }

  function scaleAtlasImage(id: string, scale: Vec2) {
    setAtlasImages((current) => current.map((image) => image.id === id ? { ...image, scale } : image));
  }

  function transformAtlasImages(updates: Array<{ id: string; position: Vec2; scale: Vec2 }>) {
    if (updates.length === 0) return;
    const byId = new Map(updates.map((update) => [update.id, update]));
    setAtlasImages((current) => current.map((image) => {
      const update = byId.get(image.id);
      return update ? { ...image, position: update.position, scale: update.scale } : image;
    }));
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
          points: ripper.points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y })),
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

  function moveRippers(ids: string[], delta: Vec2) {
    const idSet = new Set(ids);
    setRippers((current) => current.map((ripper) => idSet.has(ripper.id)
      ? {
          ...ripper,
          points: ripper.points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y })),
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
      const points = [...ripper.points];
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
      const points = [...ripper.points];
      for (const update of mine) points[update.index] = update.point;
      return { ...ripper, points };
    }));
  }

  function insertVertex(id: string, edge: number) {
    const target = latestRippersRef.current.find((ripper) => ripper.id === id);
    if (!target) return;
    commitHistory();
    setRippers((current) => current.map((ripper) => ripper.id === id ? insertRipperPoint(ripper, edge) : ripper));
    setSelectedRipperId(id);
    setSelectedRipperIds([id]);
    setSelectedSourceImageId(undefined);
    setSelectedAtlasImageId(target.outputImageId);
    setSelectedAtlasImageIds(target.outputImageId ? [target.outputImageId] : []);
    setStatus("Corner added");
  }

  function deleteVertex(id: string, index: number) {
    const target = latestRippersRef.current.find((ripper) => ripper.id === id);
    if (!target) return;
    if (target.points.length <= MIN_RIPPER_POINTS) {
      setStatus(`Rippers need at least ${MIN_RIPPER_POINTS} corners`);
      return;
    }
    commitHistory();
    setRippers((current) => current.map((ripper) => ripper.id === id ? deleteRipperPoint(ripper, index) : ripper));
    setSelectedRipperId(id);
    setSelectedRipperIds([id]);
    setSelectedSourceImageId(undefined);
    setSelectedAtlasImageId(target.outputImageId);
    setSelectedAtlasImageIds(target.outputImageId ? [target.outputImageId] : []);
    setStatus("Corner deleted");
  }

  // Set (or replace) the cubic controls of one ripper edge. Used live while
  // creating a curve (Cmd-drag on an edge) or dragging a curve handle; the
  // surrounding onRipperEditStart/End calls handle the undo step and re-extract.
  function setEdgeCurve(id: string, edge: number, controls: readonly [Vec2, Vec2]) {
    setRippers((current) => current.map((ripper) => {
      if (ripper.id !== id) return ripper;
      const edgeCurves = Array.from({ length: ripper.points.length }, (_, index) => ripper.edgeCurves?.[index] ?? null);
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
      const edgeCurves = Array.from({ length: ripper.points.length }, (_, index) => ripper.edgeCurves?.[index] ?? null);
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

  function selectSourceImage(id?: string) {
    setSelectedSourceImageId(id);
    if (id) {
      setSelectedAtlasImageId(undefined);
      setSelectedAtlasImageIds([]);
      setSelectedRipperId(undefined);
      setSelectedRipperIds([]);
    }
    setImageMenu(null);
  }

  function selectAtlasImage(id?: string) {
    setSelectedAtlasImageId(id);
    setSelectedAtlasImageIds(id ? [id] : []);
    if (id) {
      setSelectedSourceImageId(undefined);
      setSelectedRipperId(undefined);
      setSelectedRipperIds([]);
    }
    setImageMenu(null);
  }

  function selectRipper(id?: string) {
    const outputImageId = id ? rippers.find((ripper) => ripper.id === id)?.outputImageId : undefined;
    setSelectedRipperId(id);
    setSelectedRipperIds(id ? [id] : []);
    if (id) {
      setSelectedSourceImageId(undefined);
      setSelectedAtlasImageId(outputImageId);
      setSelectedAtlasImageIds(outputImageId ? [outputImageId] : []);
    }
    setImageMenu(null);
  }

  function selectRippers(ids: string[]) {
    const next = ids.filter((id) => rippers.some((ripper) => ripper.id === id));
    const outputImageId = next[0] ? rippers.find((ripper) => ripper.id === next[0])?.outputImageId : undefined;
    setSelectedRipperIds(next);
    setSelectedRipperId(next[0]);
    if (next.length > 0) {
      setSelectedSourceImageId(undefined);
      setSelectedAtlasImageId(outputImageId);
      setSelectedAtlasImageIds(outputImageId ? [outputImageId] : []);
    }
    setImageMenu(null);
  }

  function selectAllActivePanel() {
    if (activeId === "atlas") {
      const ids = atlasImages.map((image) => image.id);
      setSelectedAtlasImageIds(ids);
      setSelectedAtlasImageId(ids[0]);
      if (ids.length > 0) {
        setSelectedSourceImageId(undefined);
        setSelectedRipperId(undefined);
        setSelectedRipperIds([]);
      }
      setStatus(ids.length === 0 ? "No textures to select" : `Selected ${ids.length} texture${ids.length === 1 ? "" : "s"}`);
      return;
    }

    const ids = rippers.map((ripper) => ripper.id);
    const outputImageId = ids[0] ? rippers.find((ripper) => ripper.id === ids[0])?.outputImageId : undefined;
    setSelectedRipperIds(ids);
    setSelectedRipperId(ids[0]);
    if (ids.length > 0) {
      setSelectedSourceImageId(undefined);
      setSelectedAtlasImageId(outputImageId);
      setSelectedAtlasImageIds(outputImageId ? [outputImageId] : []);
    }
    setStatus(ids.length === 0 ? "No rippers to select" : `Selected ${ids.length} ripper${ids.length === 1 ? "" : "s"}`);
  }

  function onSourceImageContextMenu(imageId: string | undefined, clientX: number, clientY: number) {
    if (!imageId) return setImageMenu(null);
    setSelectedSourceImageId(imageId);
    setSelectedAtlasImageId(undefined);
    setSelectedAtlasImageIds([]);
    setSelectedRipperId(undefined);
    setSelectedRipperIds([]);
    setImageMenu({ kind: "source", imageId, x: clientX, y: clientY });
  }

  function onAtlasImageContextMenu(imageId: string | undefined, clientX: number, clientY: number) {
    if (!imageId) return setImageMenu(null);
    setSelectedAtlasImageId(imageId);
    setSelectedAtlasImageIds(imageId ? [imageId] : []);
    setSelectedSourceImageId(undefined);
    setSelectedRipperId(undefined);
    setSelectedRipperIds([]);
    setImageMenu({ kind: "atlas", imageId, x: clientX, y: clientY });
  }

  function onRipperEditStart(id: string, editedIdsOverride?: string[]) {
    beginInteraction();
    editingRipperIdRef.current = id;
    const latestRippers = latestRippersRef.current;
    const editedIds = editedIdsOverride && editedIdsOverride.length > 0
      ? editedIdsOverride
      : selectedRipperIds.length > 1 && selectedRipperIds.includes(id) ? selectedRipperIds : [id];
    editingRipperIdsRef.current = editedIds;
    editStartSignatureRef.current = ripperSignaturesForIds(latestRippers, editedIds);
    // Show the last committed pixels until the first live frame is rendered.
    clearLivePreviews();
  }

  function onRipperEditEnd() {
    const editedId = editingRipperIdRef.current;
    const editedIds = editingRipperIdsRef.current;
    const startSignature = editStartSignatureRef.current;
    editingRipperIdRef.current = null;
    editingRipperIdsRef.current = [];
    editStartSignatureRef.current = null;
    endInteraction();
    if (!editedId) return;
    const latestRippers = latestRippersRef.current;
    const latestSourceImages = latestSourceImagesRef.current;
    // A click that only selects a ripper (pointer down then up with no move)
    // changes no geometry. Re-extracting then would do a full-resolution GPU
    // readback and re-rasterize the atlas texture for nothing — the lag felt
    // when clicking a ripper over a large image. Skip the commit when the
    // ripper is unchanged; the live preview was never shown, so the committed
    // pixels are already on screen.
    const endSignature = ripperSignaturesForIds(latestRippers, editedIds);
    const unchanged = startSignature != null && endSignature === startSignature;
    if (unchanged) {
      clearLivePreviews();
      return;
    }
    if (editedIds.length > 1) {
      const previewImageId = livePreviewRef.current?.imageId;
      const runId = autoExtractRun.current + 1;
      autoExtractRun.current = runId;
      void autoExtractRippers(runId, latestRippers, latestSourceImages, selectedRipperIdRef.current);
      scheduleLivePreviewFallback(previewImageId);
      return;
    }
    void commitRipper(editedId, latestRippers, latestSourceImages);
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
    sourceSnapshot: WorkspaceImageState[]
  ) {
    const index = ripperSnapshot.findIndex((item) => item.id === ripperId);
    const ripper = ripperSnapshot[index];
    if (!ripper) return;

    const runId = autoExtractRun.current + 1;
    autoExtractRun.current = runId;

    let result: ExtractionResult | null = null;
    const started = performance.now();
    const outputSize = extractionOutputSize(ripper);
    if (outputSize.pixels > MAX_COMMIT_PIXEL_LIMIT) {
      clearLivePreviews();
      setStatus(tooLargeStatus(outputSize));
      return;
    }
    const useGpuCommit = isGpuExtractAvailable() && outputSize.pixels <= GPU_COMMIT_PIXEL_LIMIT;
    if (useGpuCommit) {
      result = gpuExtractPerspective(ripper, toPlacedImages(sourceSnapshot));
    }
    if (!result) {
      if (outputSize.pixels > GPU_COMMIT_PIXEL_LIMIT) {
        setStatus(`Finalizing large texture ${outputSize.width} x ${outputSize.height}...`);
      }
      result = await runWorker<ExtractionResult | null>({
        type: "extract",
        ripper,
        images: toPlacedImages(sourceSnapshot)
      });
    }
    recordAsyncCommit(performance.now() - started);
    if (autoExtractRun.current !== runId) return;

    if (result) {
      const outputImageId = ripper.outputImageId ?? createId("atlas");
      applyExtraction([{ ripper, index, outputImageId, outputSize, result }]);
    }

    // Usually the atlas workspace clears this as soon as its async display cache
    // is ready. Keep a fallback so a failed cache build cannot leave a stale
    // live canvas stuck forever.
    scheduleLivePreviewFallback(livePreviewRef.current?.imageId);
  }

  return (
    <main className={window.dinorip.platform === "darwin" ? "app app--mac" : "app"}>
      <header className="app__header">
        <h1>dinorip</h1>
        <span className="app__status">{status}</span>
        <div className="app__toolbar">
          {isUpdateActionable(updateState) && !updateModalOpen ? (
            <UpdateIndicator state={updateState} onOpen={openUpdateModal} />
          ) : null}
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
              selectedRipperIds={selectedRipperIds}
              view={sourceView}
              onViewChange={setSourceView}
              onSelectImage={selectSourceImage}
              onSelectRipper={selectRipper}
              onSelectRippers={selectRippers}
              onMoveImage={moveSourceImage}
              onScaleImage={scaleSourceImage}
              onMoveRipper={moveRipper}
              onMoveRippers={moveRippers}
              onMoveVertex={moveVertex}
              onMoveVertices={moveVertices}
              onInsertVertex={insertVertex}
              onDeleteVertex={deleteVertex}
              onSetEdgeCurve={setEdgeCurve}
              onRemoveEdgeCurve={removeEdgeCurve}
              onImageContextMenu={onSourceImageContextMenu}
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
              selectedImageIds={selectedAtlasImageIds}
              view={atlasView}
              livePreview={livePreviewRef}
              onLivePreviewCached={clearLivePreviewIfCached}
              onViewChange={setAtlasView}
              onSelectImage={selectAtlasImage}
              onMoveImage={moveAtlasImage}
              onMoveImages={moveAtlasImages}
              onScaleImage={scaleAtlasImage}
              onTransformImages={transformAtlasImages}
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
      {imageMenu && (() => {
        const image = imageMenu.kind === "source"
          ? sourceImages.find((item) => item.id === imageMenu.imageId)
          : atlasImages.find((item) => item.id === imageMenu.imageId);
        if (!image) return null;
        const menuRipper = imageMenu.kind === "atlas"
          ? rippers.find((item) => item.outputImageId === imageMenu.imageId)
          : undefined;
        const conserving = menuRipper ? shouldConserve(menuRipper) : false;
        return (
          <>
            <div className="context-menu__backdrop" onPointerDown={() => setImageMenu(null)} onContextMenu={(event) => { event.preventDefault(); setImageMenu(null); }} />
            <ul className="context-menu" style={{ left: imageMenu.x, top: imageMenu.y }} role="menu" aria-label={`${imageMenu.kind === "source" ? "Source image" : "Texture"} actions`}>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (imageMenu.kind === "source") deleteSourceImage(imageMenu.imageId);
                    else deleteAtlasImage(imageMenu.imageId);
                  }}
                >
                  Delete {imageMenu.kind === "source" ? "Image" : "Texture"}
                </button>
              </li>
              {menuRipper && isRipperCurved(menuRipper) && (
                <li role="none">
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={conserving}
                    onClick={() => { toggleConserveShape(menuRipper.id); setImageMenu(null); }}
                  >
                    {conserving ? "✓ " : " "}Preserve curved shape
                  </button>
                </li>
              )}
            </ul>
          </>
        );
      })()}
      {showShortcuts && <ShortcutsOverlay onClose={closeShortcuts} />}
      {updateModalOpen && updateState ? (
        <UpdateModal
          state={updateState}
          onClose={closeUpdateModal}
          onPrimaryAction={handleUpdatePrimaryAction}
        />
      ) : null}
    </main>
  );
}

function makeWorkspaceImage(name: string, image: PixelImage, position: Vec2, isAtlas: boolean, id = createId(isAtlas ? "atlas" : "source")): WorkspaceImageState {
  const storedImage = cloneForState(image);
  return {
    id,
    name,
    image: storedImage,
    originalImage: isAtlas ? cloneForState(image) : storedImage,
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

  const itemFiles: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) itemFiles.push(file);
  }
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

function serializeWorkspaceImage(image: WorkspaceImageState): SerializedWorkspaceImage {
  return {
    id: image.id,
    name: image.name,
    image: serializePixelImage(image.image),
    originalImage: serializePixelImage(image.originalImage),
    position: image.position,
    scale: image.scale,
    rotation: image.rotation,
    settings: image.settings,
    version: image.version
  };
}

function deserializeWorkspaceImage(image: SerializedWorkspaceImage): WorkspaceImageState {
  return {
    id: image.id,
    name: image.name,
    image: deserializePixelImage(image.image),
    originalImage: deserializePixelImage(image.originalImage),
    position: image.position,
    scale: image.scale,
    rotation: image.rotation,
    settings: image.settings,
    version: image.version
  };
}

function serializePixelImage(image: PixelImage): SerializedPixelImage {
  return {
    width: image.width,
    height: image.height,
    data: bytesToBase64(image.data)
  };
}

function deserializePixelImage(image: SerializedPixelImage): PixelImage {
  return {
    width: image.width,
    height: image.height,
    data: base64ToBytes(image.data)
  };
}

function bytesToBase64(bytes: Uint8ClampedArray): string {
  const chunkSize = 32_768;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8ClampedArray {
  const binary = atob(value);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function compactIds(ids: Array<string | undefined>): string[] {
  return ids.filter((id): id is string => Boolean(id));
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || path;
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
    state.selectedRipperId ?? "",
    state.selectedAtlasImageIds.join(","),
    state.selectedRipperIds.join(",")
  ].join("§");
}

function ripperSignature(ripper: RipperState): string {
  return [
    ripper.id,
    `p${ripper.points.length}`,
    ...ripper.points.flatMap((point) => [formatNumber(point.x), formatNumber(point.y)]),
    // Fold in per-edge curve controls so curve create/move/remove re-extracts and
    // registers as a real change for undo detection. "_" marks a straight edge.
    ...ripper.points.map((_, edge) => {
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
