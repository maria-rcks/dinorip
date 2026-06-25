import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

export type PanelId = "ripper" | "atlas" | "tools";
export type PanelEdge = "right" | "left";
export type SpanColumn = "left" | "right";
export type LayoutResizePart = "x" | "y" | "stackY";

export interface SpanState {
  id: PanelId;
  column: SpanColumn;
}

export interface SplitState {
  x: number;
  y: number;
  stackY: number;
}

export type PanelLayoutStyle = CSSProperties & {
  "--split-x": string;
  "--split-y": string;
  "--stack-split-y": string;
};

interface StoredLayout {
  order: PanelId[];
  span: SpanState | null;
  split: SplitState;
}

// `order[slotIndex]` is the panel that fills that tile slot. Slots are laid out
// by CSS grid (see `.app__tiles`), so panels are always tiled; there is no
// free-floating geometry. Dragging a heading swaps two entries of this array.
const DEFAULT_ORDER: PanelId[] = ["atlas", "ripper", "tools"];
// Default arrangement: Image Ripper fills the right column full-height, with
// Texture Atlas (top) and Seam Options (bottom) stacked on the left.
const DEFAULT_SPAN: SpanState = { id: "ripper", column: "right" };
const DEFAULT_SPLIT: SplitState = { x: 0.53, y: 0.66, stackY: 0.65 };
const STORAGE_KEY = "dinorip.panelLayout.v7";
const LEGACY_ORDER_KEY = "dinorip.panelOrder.v1";

function isPanelId(value: unknown): value is PanelId {
  return value === "ripper" || value === "atlas" || value === "tools";
}

function isSpanState(value: unknown): value is SpanState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SpanState>;
  return isPanelId(candidate.id) && (candidate.column === "left" || candidate.column === "right");
}

function validOrder(value: unknown): value is PanelId[] {
  return (
    Array.isArray(value) &&
    value.length === DEFAULT_ORDER.length &&
    value.every(isPanelId) &&
    new Set(value).size === DEFAULT_ORDER.length
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampSplit(part: LayoutResizePart, value: number): number {
  if (part === "y") return clamp(value, 0.28, 0.82);
  return clamp(value, 0.22, 0.78);
}

function normaliseSplit(value: unknown): SplitState {
  if (!value || typeof value !== "object") return { ...DEFAULT_SPLIT };
  const candidate = value as Partial<Record<keyof SplitState, unknown>>;
  return {
    x: typeof candidate.x === "number" ? clampSplit("x", candidate.x) : DEFAULT_SPLIT.x,
    y: typeof candidate.y === "number" ? clampSplit("y", candidate.y) : DEFAULT_SPLIT.y,
    stackY: typeof candidate.stackY === "number" ? clampSplit("stackY", candidate.stackY) : DEFAULT_SPLIT.stackY
  };
}

function load(): StoredLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { order: loadLegacyOrder(), span: { ...DEFAULT_SPAN }, split: { ...DEFAULT_SPLIT } };
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const candidate = parsed as Partial<StoredLayout>;
      return {
        order: validOrder(candidate.order) ? candidate.order : loadLegacyOrder(),
        span: candidate.span === null || candidate.span === undefined
          ? null
          : isSpanState(candidate.span) ? candidate.span : null,
        split: normaliseSplit(candidate.split)
      };
    }
    return { order: loadLegacyOrder(), span: { ...DEFAULT_SPAN }, split: { ...DEFAULT_SPLIT } };
  } catch {
    return { order: loadLegacyOrder(), span: { ...DEFAULT_SPAN }, split: { ...DEFAULT_SPLIT } };
  }
}

function loadLegacyOrder(): PanelId[] {
  try {
    const raw = localStorage.getItem(LEGACY_ORDER_KEY);
    if (!raw) return [...DEFAULT_ORDER];
    const parsed = JSON.parse(raw) as unknown;
    if (validOrder(parsed)) return parsed;
    return [...DEFAULT_ORDER];
  } catch {
    return [...DEFAULT_ORDER];
  }
}

function columnForEdge(edge: PanelEdge): SpanColumn {
  if (edge === "left") return "left";
  return "right";
}

function storedLayout(order: PanelId[], span: SpanState | null, split: SplitState): StoredLayout {
  return { order, span, split };
}

function stackedArea(order: PanelId[], span: SpanState, id: PanelId): string {
  if (span.id === id) return "focus";
  const stackIndex = order.filter((panelId) => panelId !== span.id).indexOf(id);
  return stackIndex === 0 ? "stackA" : "stackB";
}

function slottedArea(order: PanelId[], id: PanelId): string {
  return `slot${order.indexOf(id)}`;
}

function nextSpanForEdge(order: PanelId[], current: SpanState | null, id: PanelId, edge: PanelEdge): SpanState | null {
  const slot = order.indexOf(id);
  if (slot === -1) return current;
  const column = columnForEdge(edge);
  if (current?.id === id && current.column === column) return null;
  return { id, column };
}

function panelFromUnknown(id: string): PanelId | null {
  return isPanelId(id) ? id : null;
}

function dropTargetFromUnknown(id: string | null): PanelId | null {
  return id && isPanelId(id) ? id : null;
}

function swapPanels(order: PanelId[], a: PanelId, b: PanelId): PanelId[] {
  if (a === b) return order;
  const next = [...order];
  const ia = next.indexOf(a);
  const ib = next.indexOf(b);
  if (ia === -1 || ib === -1) return order;
  next[ia] = b;
  next[ib] = a;
  return next;
}

function movePanelToIndex(order: PanelId[], id: PanelId, targetIndex: number): PanelId[] {
  const target = order[targetIndex];
  if (!target || target === id) return order;
  return swapPanels(order, id, target);
}

function layoutArea(order: PanelId[], span: SpanState | null, id: PanelId): string {
  return span ? stackedArea(order, span, id) : slottedArea(order, id);
}

function defaultLayout(): StoredLayout {
  return { order: [...DEFAULT_ORDER], span: { ...DEFAULT_SPAN }, split: { ...DEFAULT_SPLIT } };
}

function activeColumnClass(span: SpanState | null): string {
  return span ? `app__tiles--span-${span.column}` : "";
}

function persist(layout: StoredLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* storage disabled; keep the in-memory layout */
  }
}

export function usePanelLayout() {
  const [initialLayout] = useState<StoredLayout>(load);
  const [order, setOrder] = useState<PanelId[]>(initialLayout.order);
  const [span, setSpan] = useState<SpanState | null>(initialLayout.span);
  const [split, setSplit] = useState<SplitState>(initialLayout.split);
  const [activeId, setActiveId] = useState<PanelId>("tools");
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [dropTarget, setDropTarget] = useState<PanelId | null>(null);
  // Mirror drag state in refs so endDrag can read the final values and perform
  // the swap without doing side effects inside a setState updater (StrictMode
  // double-invokes updaters, which would run the swap twice and cancel it).
  const draggingRef = useRef<PanelId | null>(null);
  const dropTargetRef = useRef<PanelId | null>(null);

  useEffect(() => {
    persist(storedLayout(order, span, split));
  }, [order, span, split]);

  const areaOf = useCallback((id: PanelId) => layoutArea(order, span, id), [order, span]);

  const tilesStyle = useMemo<PanelLayoutStyle>(() => ({
    "--split-x": `${(split.x * 100).toFixed(2)}%`,
    "--split-y": `${(split.y * 100).toFixed(2)}%`,
    "--stack-split-y": `${(split.stackY * 100).toFixed(2)}%`
  }), [split]);

  const activate = useCallback((id: string) => {
    const panel = panelFromUnknown(id);
    if (panel) setActiveId(panel);
  }, []);

  const swap = useCallback((a: PanelId, b: PanelId) => {
    setOrder((current) => swapPanels(current, a, b));
  }, []);

  const beginDrag = useCallback((id: string) => {
    const panel = panelFromUnknown(id);
    if (panel) {
      draggingRef.current = panel;
      dropTargetRef.current = null;
      setDragging(panel);
      setDropTarget(null);
    }
  }, []);

  const dragOver = useCallback((id: string | null) => {
    const target = dropTargetFromUnknown(id);
    dropTargetRef.current = target;
    setDropTarget(target);
  }, []);

  const endDrag = useCallback(() => {
    const draggedId = draggingRef.current;
    const target = dropTargetRef.current;
    draggingRef.current = null;
    dropTargetRef.current = null;
    if (draggedId && target && draggedId !== target) swap(draggedId, target);
    setDragging(null);
    setDropTarget(null);
  }, [swap]);

  const extendPanel = useCallback((id: string, edge: PanelEdge) => {
    const panel = panelFromUnknown(id);
    if (!panel) return;
    setSpan((current) => nextSpanForEdge(order, current, panel, edge));
    setActiveId(panel);
  }, [order]);

  const resizeLayout = useCallback((part: LayoutResizePart, value: number) => {
    setSplit((current) => ({ ...current, [part]: clampSplit(part, value) }));
  }, []);

  const movePanelToSlot = useCallback((id: string, slotIndex: number) => {
    const panel = panelFromUnknown(id);
    if (!panel) return;
    setOrder((current) => movePanelToIndex(current, panel, slotIndex));
    setSpan(null);
    setActiveId(panel);
  }, []);

  const fillPanel = useCallback((id: string, column: SpanColumn) => {
    const panel = panelFromUnknown(id);
    if (!panel) return;
    setSpan({ id: panel, column });
    setActiveId(panel);
  }, []);

  const clearSpan = useCallback(() => {
    setSpan(null);
  }, []);

  const reset = useCallback(() => {
    const next = defaultLayout();
    setOrder(next.order);
    setSpan(next.span);
    setSplit(next.split);
    setActiveId("tools");
    draggingRef.current = null;
    dropTargetRef.current = null;
    setDragging(null);
    setDropTarget(null);
  }, []);

  return {
    order,
    span,
    split,
    tilesStyle,
    tilesClassName: ["app__tiles", activeColumnClass(span)].filter(Boolean).join(" "),
    areaOf,
    activeId,
    dragging,
    dropTarget,
    activate,
    beginDrag,
    dragOver,
    endDrag,
    extendPanel,
    resizeLayout,
    movePanelToSlot,
    fillPanel,
    clearSpan,
    reset
  };
}
