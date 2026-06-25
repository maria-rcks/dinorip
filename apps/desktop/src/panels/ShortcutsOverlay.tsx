import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { X } from "lucide-react";
import { SHORTCUTS, gifUrl, renderKeyToken } from "../renderer/shortcutsData";
import type { ShortcutEntry } from "../renderer/shortcutsData";
import { ShaderPreview } from "../preview/ShaderPreview";

interface ShortcutsOverlayProps {
  onClose(): void;
}

// The shortcut currently under the pointer plus the cursor position, so its demo
// can float next to the mouse. Only shortcuts with a `gif` get a hover preview.
interface HoverState {
  shortcut: ShortcutEntry;
  x: number;
  y: number;
}

// Floating preview size, used to keep it on-screen near the cursor.
const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 180;
const CURSOR_GAP = 16;

// A single panel listing every shortcut. Hovering a shortcut that has a demo
// floats its clip (or the shader placeholder until recorded) beside the cursor.
export function ShortcutsOverlay(props: ShortcutsOverlayProps): ReactElement {
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [props]);

  const trackHover = (shortcut: ShortcutEntry, event: ReactPointerEvent) => {
    if (!shortcut.gif) {
      setHover(null);
      return;
    }
    setHover({ shortcut, x: event.clientX, y: event.clientY });
  };

  return createPortal(
    <div className="shortcuts-overlay" role="dialog" aria-modal="true" aria-label="Shortcuts">
      <div className="shortcuts-overlay__backdrop" onPointerDown={props.onClose} />
      <div className="shortcuts-modal">
        <header className="shortcuts-modal__header">
          <h2>Shortcuts</h2>
          <span className="shortcuts-modal__hint">hover to preview</span>
          <button type="button" className="shortcuts-modal__close" onClick={props.onClose} aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div className="shortcuts-list" onPointerLeave={() => setHover(null)}>
          {SHORTCUTS.sections.map((section) => (
            <section key={section.id} className="shortcuts-group">
              <h3>{section.title}</h3>
              <ul>
                {section.shortcuts.map((shortcut) => (
                  <li
                    key={shortcut.action}
                    className={`shortcuts-row${shortcut.gif ? " has-demo" : ""}`}
                    onPointerEnter={(event) => trackHover(shortcut, event)}
                    onPointerMove={(event) => trackHover(shortcut, event)}
                    onPointerLeave={() => setHover(null)}
                  >
                    <span className="shortcuts-row__action">{shortcut.action}</span>
                    <KeyCombos shortcut={shortcut} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
      {hover && <FloatingDemo hover={hover} />}
    </div>,
    document.body
  );
}

// The key chips for one shortcut: tokens joined by "+", alternatives by "or".
function KeyCombos(props: { shortcut: ShortcutEntry }): ReactElement {
  return (
    <span className="shortcuts-row__keys">
      {props.shortcut.keys.map((combo, comboIndex) => (
        <span key={comboIndex} className="shortcuts-combo">
          {comboIndex > 0 && <span className="shortcuts-sep">or</span>}
          {combo.map((token, tokenIndex) => (
            <span key={tokenIndex} className="shortcuts-combo">
              {tokenIndex > 0 && <span className="shortcuts-sep">+</span>}
              <kbd>{renderKeyToken(token)}</kbd>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

// The clip that floats beside the cursor: the recorded GIF, or the wavy shader
// with a "coming soon" label until it is recorded. Clamped to stay on-screen and
// non-interactive so it never steals the hover from the row underneath it.
function FloatingDemo(props: { hover: HoverState }): ReactElement {
  const { shortcut, x, y } = props.hover;
  const url = shortcut.gif ? gifUrl(shortcut.gif) : undefined;

  const flipLeft = x + CURSOR_GAP + PREVIEW_WIDTH > window.innerWidth;
  const left = flipLeft ? x - CURSOR_GAP - PREVIEW_WIDTH : x + CURSOR_GAP;
  const top = clamp(y - PREVIEW_HEIGHT / 2, 8, window.innerHeight - PREVIEW_HEIGHT - 8);

  return (
    <div className="shortcuts-float" style={{ left, top, width: PREVIEW_WIDTH }}>
      <div className="shortcuts-demo__frame">
        {url ? (
          <img className="shortcuts-demo__gif" src={url} alt={`${shortcut.action} demo`} />
        ) : (
          <>
            <ShaderPreview />
            <span className="shortcuts-demo__placeholder">Demo coming soon</span>
          </>
        )}
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
