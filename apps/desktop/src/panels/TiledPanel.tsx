import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactElement, ReactNode } from "react";
import type { PanelEdge } from "./usePanelLayout";
import { PanelGlyph } from "./PanelGlyph";

interface TiledPanelProps {
  id: string;
  title: string;
  /** Optional one-line blurb shown under the title. */
  description?: string;
  area: string;
  active?: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
  children: ReactNode;
  onActivate(id: string): void;
  /** Begin a heading drag that will reorder/swap panels between tile slots. */
  onDragStart(id: string): void;
  /** Report the panel currently under the pointer (or null) so it can be highlighted. */
  onDragOver(targetId: string | null): void;
  /** Finish the drag; the hook swaps the dragged panel into the hovered slot. */
  onDragEnd(): void;
  onExtend(id: string, edge: PanelEdge): void;
}

// Tiled panels never float: geometry is owned entirely by the CSS grid via
// `grid-area: slotN`. Dragging the heading only reorders which panel fills
// which slot; it never produces an arbitrary x/y/width/height frame.
export function TiledPanel(props: TiledPanelProps): ReactElement {
  const draggingPointer = useRef({ active: false, pointerId: -1 });
  const extendingPointer = useRef<{ edge: PanelEdge; pointerId: number } | null>(null);
  const handledExtendPointer = useRef(false);
  const lastTarget = useRef<string | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ghostFrame = useRef(0);
  const pendingPointer = useRef<{ x: number; y: number } | null>(null);
  const dragListeners = useRef<{
    move(event: PointerEvent): void;
    end(event: PointerEvent): void;
  } | null>(null);
  const [ghostStart, setGhostStart] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => () => {
    if (ghostFrame.current !== 0) window.cancelAnimationFrame(ghostFrame.current);
    removeDragListeners();
  }, []);

  const findPanelIdAt = (clientX: number, clientY: number): string | null => {
    const element = document.elementFromPoint(clientX, clientY);
    const panel = element?.closest<HTMLElement>("[data-panel-id]");
    return panel?.dataset.panelId ?? null;
  };

  const reportTarget = (targetId: string | null) => {
    const nextTarget = targetId === props.id ? null : targetId;
    if (lastTarget.current === nextTarget) return;
    lastTarget.current = nextTarget;
    props.onDragOver(nextTarget);
  };

  const moveGhost = (clientX: number, clientY: number) => {
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.style.transform = `translate3d(${clientX + 14}px, ${clientY + 14}px, 0)`;
    }
  };

  const trackPointer = (clientX: number, clientY: number) => {
    pendingPointer.current = { x: clientX, y: clientY };
    reportTarget(findPanelIdAt(clientX, clientY));
    if (ghostFrame.current !== 0) return;
    ghostFrame.current = window.requestAnimationFrame(() => {
      ghostFrame.current = 0;
      const pointer = pendingPointer.current;
      if (!pointer) return;
      moveGhost(pointer.x, pointer.y);
    });
  };

  const removeDragListeners = () => {
    const listeners = dragListeners.current;
    if (!listeners) return;
    window.removeEventListener("pointermove", listeners.move, true);
    window.removeEventListener("pointerup", listeners.end, true);
    window.removeEventListener("pointercancel", listeners.end, true);
    dragListeners.current = null;
  };

  const beginDrag = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    props.onActivate(props.id);
    draggingPointer.current.active = true;
    draggingPointer.current.pointerId = event.pointerId;
    lastTarget.current = null;
    pendingPointer.current = { x: event.clientX, y: event.clientY };
    setGhostStart({ x: event.clientX, y: event.clientY });
    props.onDragStart(props.id);

    const move = (pointerEvent: PointerEvent) => {
      if (!draggingPointer.current.active || draggingPointer.current.pointerId !== pointerEvent.pointerId) return;
      pointerEvent.preventDefault();
      trackPointer(pointerEvent.clientX, pointerEvent.clientY);
    };
    const end = (pointerEvent: PointerEvent) => {
      if (!draggingPointer.current.active || draggingPointer.current.pointerId !== pointerEvent.pointerId) return;
      pointerEvent.preventDefault();
      if (ghostFrame.current !== 0) {
        window.cancelAnimationFrame(ghostFrame.current);
        ghostFrame.current = 0;
      }
      moveGhost(pointerEvent.clientX, pointerEvent.clientY);
      reportTarget(findPanelIdAt(pointerEvent.clientX, pointerEvent.clientY));
      removeDragListeners();
      draggingPointer.current.active = false;
      lastTarget.current = null;
      pendingPointer.current = null;
      setGhostStart(null);
      props.onDragEnd();
    };

    removeDragListeners();
    dragListeners.current = { move, end };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  };

  const cancelDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!draggingPointer.current.active || draggingPointer.current.pointerId !== event.pointerId) return;
    if (ghostFrame.current !== 0) {
      window.cancelAnimationFrame(ghostFrame.current);
      ghostFrame.current = 0;
    }
    removeDragListeners();
    draggingPointer.current.active = false;
    lastTarget.current = null;
    pendingPointer.current = null;
    setGhostStart(null);
    props.onDragOver(null);
    props.onDragEnd();
  };

  const beginExtend = (event: React.PointerEvent<HTMLElement>, edge: PanelEdge) => {
    event.preventDefault();
    event.stopPropagation();
    props.onActivate(props.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    handledExtendPointer.current = false;
    extendingPointer.current = { edge, pointerId: event.pointerId };
  };

  const endExtend = (event: React.PointerEvent<HTMLElement>) => {
    const extending = extendingPointer.current;
    if (!extending || extending.pointerId !== event.pointerId) return;
    extendingPointer.current = null;
    handledExtendPointer.current = true;
    props.onExtend(props.id, extending.edge);
  };

  const cancelExtend = (event: React.PointerEvent<HTMLElement>) => {
    if (extendingPointer.current?.pointerId === event.pointerId) extendingPointer.current = null;
  };

  const clickExtend = (event: React.MouseEvent<HTMLElement>, edge: PanelEdge) => {
    event.preventDefault();
    event.stopPropagation();
    if (handledExtendPointer.current) {
      handledExtendPointer.current = false;
      return;
    }
    props.onActivate(props.id);
    props.onExtend(props.id, edge);
  };

  const className = [
    "tiled-panel",
    props.active ? "tiled-panel--active" : "",
    props.dragging ? "tiled-panel--dragging" : "",
    props.dropTarget ? "tiled-panel--drop" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <section
        className={className}
        data-panel-id={props.id}
        style={{ gridArea: props.area }}
        onPointerDown={() => props.onActivate(props.id)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="tiled-panel__body">{props.children}</div>
        <header className="tiled-panel__heading">
          <div
            className="tiled-panel__title"
            onPointerDown={beginDrag}
            onPointerCancel={cancelDrag}
            title="Drag onto another panel to swap tiles"
          >
            <PanelGlyph id={props.id} />
            <h2>{props.title}</h2>
          </div>
          {props.description && <p className="tiled-panel__desc">{props.description}</p>}
        </header>
        {(["left", "right"] as const).map((edge) => (
          <button
            key={edge}
            className={`tile-extend-handle tile-extend-handle--${edge}`}
            type="button"
            aria-label={`Extend ${props.title} ${edge}`}
            title="Extend tile"
            onPointerDown={(event) => beginExtend(event, edge)}
            onPointerUp={endExtend}
            onPointerCancel={cancelExtend}
            onClick={(event) => clickExtend(event, edge)}
          />
        ))}
      </section>
      {ghostStart && createPortal(
        <div
          ref={ghostRef}
          className="tile-drag-ghost"
          style={{ transform: `translate3d(${ghostStart.x + 14}px, ${ghostStart.y + 14}px, 0)` }}
          aria-hidden="true"
        >
          <div className="tile-drag-ghost__titlebar">
            <span className="pixel-check" />
            <span>{props.title}</span>
          </div>
          <div className="tile-drag-ghost__body" />
        </div>,
        document.body
      )}
    </>
  );
}
