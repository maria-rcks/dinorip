# Shortcut demo clips

Drop recorded demo GIFs here. Each file is named after the `gif` field of a
shortcut in [`apps/desktop/src/renderer/shortcuts.data.json`](../../apps/desktop/src/renderer/shortcuts.data.json).

- The in-app **Shortcuts** overlay (the keyboard button in the header) shows a
  clip when its file exists, and an empty placeholder until then.
- The README's Shortcuts table embeds each clip once the file exists; it is
  regenerated from the same JSON, so re-run `pnpm gen:shortcuts` after adding a
  clip (it also runs automatically on `pnpm dev` / `pnpm build`).

Expected filenames (one per shortcut):

| Section | File |
| --- | --- |
| General | `undo.gif`, `redo.gif`, `fullscreen.gif`, `paste.gif`, `zoom.gif`, `pan.gif`, `delete-selection.gif` |
| Ripper | `add-ripper.gif`, `extract.gif`, `select-ripper.gif`, `move-ripper.gif`, `move-corner.gif`, `scale-ripper.gif`, `bend-edge.gif`, `reshape-curve.gif`, `remove-curve.gif`, `multi-select-corner.gif`, `move-corners.gif`, `marquee-corners.gif`, `move-image.gif` |
| Atlas | `apply-adjustments.gif`, `move-texture.gif`, `resize-texture.gif`, `delete-texture.gif`, `toggle-conserve.gif` |
