import { useState } from "react";
import type { ReactElement } from "react";
import {
  Download,
  Images,
  Package,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  Upload
} from "lucide-react";
import { MOD_KEY as MOD } from "../renderer/shortcuts";

interface SourceToolbarProps {
  selectedRipperId?: string;
  canUndo: boolean;
  canRedo: boolean;
  onLoadImages(): void;
  onAddRipper(): void;
  onDeleteRipper(): void;
  onExtract(): void;
  onUndo(): void;
  onRedo(): void;
}

interface AtlasToolbarProps {
  hasSelection: boolean;
  hasImages: boolean;
  /** Live width/height (px) of the exported atlas, shown in the size changer. */
  sizeWidth: number;
  sizeHeight: number;
  /** Whether the export region is padded to a square. */
  square: boolean;
  onSetWidth(value: number): void;
  onSetHeight(value: number): void;
  onToggleSquare(): void;
  onExportSelected(): void;
  onExportAll(): void;
  onExportAtlas(): void;
}

export function SourceToolbar(props: SourceToolbarProps): ReactElement {
  return (
    <div className="panel-toolbar panel-toolbar--bottom">
      <button type="button" onClick={props.onUndo} disabled={!props.canUndo} title={`Undo (${MOD}+Z)`} aria-label="Undo">
        <Undo2 size={12} />
      </button>
      <button type="button" onClick={props.onRedo} disabled={!props.canRedo} title={`Redo (${MOD}+Shift+Z)`} aria-label="Redo">
        <Redo2 size={12} />
      </button>
      <button type="button" onClick={props.onDeleteRipper} disabled={!props.selectedRipperId} title="Delete the selected ripper (Del)">
        <Trash2 size={12} />
        Delete Ripper
      </button>
      <button type="button" onClick={props.onLoadImages} title="Load source images">
        <Upload size={12} />
        Load Image
      </button>
      <button type="button" onClick={props.onAddRipper} title="Add a ripper (A)">
        <Plus size={12} />
        Add Ripper
      </button>
      <button type="button" onClick={props.onExtract} disabled={!props.selectedRipperId} title="Extract the selected ripper (Enter)">
        <Scissors size={12} />
        Extract
      </button>
    </div>
  );
}

export function AtlasToolbar(props: AtlasToolbarProps): ReactElement {
  return (
    <div className="panel-toolbar panel-toolbar--bottom panel-toolbar--split">
      <div className="atlas-size" title="Exported atlas size (px)">
        <SizeField label="Atlas width" value={props.sizeWidth} onCommit={props.onSetWidth} />
        <span className="atlas-size__x" aria-hidden="true">×</span>
        <SizeField label="Atlas height" value={props.sizeHeight} onCommit={props.onSetHeight} />
        <button
          type="button"
          className={`atlas-size__square${props.square ? " is-active" : ""}`}
          aria-pressed={props.square}
          onClick={props.onToggleSquare}
          title="Pad export to a square"
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="atlas-exports">
        <button type="button" onClick={props.onExportSelected} disabled={!props.hasSelection} title="Export the selected texture">
          <Download size={12} />
          Export
        </button>
        <button type="button" onClick={props.onExportAll} disabled={!props.hasImages} title="Export each texture individually">
          <Images size={12} />
          Export All
        </button>
        <button type="button" onClick={props.onExportAtlas} disabled={!props.hasImages} title="Export the whole atlas">
          <Package size={12} />
          Export Atlas
        </button>
      </div>
    </div>
  );
}

// Numeric size box that only commits on blur/Enter so typing intermediate
// values (e.g. clearing the field before retyping) does not fight the live
// auto-fitted readout fed back through `value`.
function SizeField(props: { label: string; value: number; onCommit(value: number): void }): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(props.value);
  const commit = () => {
    if (draft === null) return;
    const parsed = Math.round(Number(draft));
    if (Number.isFinite(parsed) && parsed > 0) props.onCommit(parsed);
    setDraft(null);
  };
  return (
    <input
      className="atlas-size__field"
      type="number"
      min={1}
      inputMode="numeric"
      aria-label={props.label}
      value={text}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(null);
      }}
    />
  );
}
