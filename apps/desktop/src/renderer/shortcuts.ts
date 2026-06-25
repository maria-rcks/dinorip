// The modifier key shown in shortcut hints: ⌘ on macOS, Ctrl elsewhere. Kept in
// one place so every tooltip across the toolbars matches the real key handling
// (which accepts both metaKey and ctrlKey).
export const MOD_KEY = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac")
  ? "⌘"
  : "Ctrl";
