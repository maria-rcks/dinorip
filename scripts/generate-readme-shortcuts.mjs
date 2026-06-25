#!/usr/bin/env node
// Regenerates the "## Shortcuts" section of the README from the single source of
// truth at apps/desktop/src/renderer/shortcuts.data.json, so the docs never
// drift from what the in-app Shortcuts overlay shows. Never edit the README's
// Shortcuts section by hand — it lives between the SHORTCUTS markers and is
// overwritten by this script.
//
//   node scripts/generate-readme-shortcuts.mjs          # rewrite the README
//   node scripts/generate-readme-shortcuts.mjs --check   # exit 1 if stale (CI)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_PATH = path.join(REPO_ROOT, "apps/desktop/src/renderer/shortcuts.data.json");
const README_PATH = path.join(REPO_ROOT, "README.md");
const GIF_DIR_REL = "assets/shortcuts";

const START_MARKER = "<!-- SHORTCUTS:START -->";
const END_MARKER = "<!-- SHORTCUTS:END -->";

// In the README the modifier is spelled out for both platforms (the app shows
// the one for the current OS instead).
const MOD_LABEL = "⌘/Ctrl";

/** Render one key token: the "mod" placeholder becomes the cross-platform label. */
function renderToken(token) {
  return token === "mod" ? MOD_LABEL : token;
}

/** Render a shortcut's combos: tokens joined by " + ", alternatives by ", or ". */
function renderKeys(keys) {
  return keys.map((combo) => combo.map(renderToken).join(" + ")).join(", or ");
}

/** Whether a shortcut has a recorded clip on disk (no gif field => never). */
function hasGif(shortcut) {
  return Boolean(shortcut.gif) && existsSync(path.join(REPO_ROOT, GIF_DIR_REL, shortcut.gif));
}

/** A demo cell links the recorded GIF when it exists, otherwise stays empty. */
function renderDemo(shortcut) {
  if (!hasGif(shortcut)) return "";
  return `![${shortcut.action} demo](${GIF_DIR_REL}/${shortcut.gif})`;
}

export function generateShortcutsSection(doc) {
  // Only show the Demo column once at least one clip has been recorded, so the
  // table stays clean while the clips are still being produced.
  const anyGif = doc.sections.some((section) => section.shortcuts.some(hasGif));

  const lines = [
    "<!-- Generated from apps/desktop/src/renderer/shortcuts.data.json by scripts/generate-readme-shortcuts.mjs. Do not edit by hand; run `pnpm gen:shortcuts`. -->",
    "## Shortcuts",
    ""
  ];
  if (doc.intro) lines.push(`> ${doc.intro}`, "");

  for (const section of doc.sections) {
    lines.push(`### ${section.title}`, "");
    lines.push(anyGif ? "| Action | Shortcut | Demo |" : "| Action | Shortcut |");
    lines.push(anyGif ? "| --- | --- | --- |" : "| --- | --- |");
    for (const shortcut of section.shortcuts) {
      const cells = [shortcut.action, renderKeys(shortcut.keys)];
      if (anyGif) cells.push(renderDemo(shortcut));
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
    if (section.note) lines.push(`> ${section.note}`, "");
  }

  // Trim the trailing blank line; the marker block reintroduces spacing.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function buildReadme(currentReadme, section) {
  const start = currentReadme.indexOf(START_MARKER);
  const end = currentReadme.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `README.md is missing the ${START_MARKER} / ${END_MARKER} markers around the Shortcuts section.`
    );
  }
  const before = currentReadme.slice(0, start + START_MARKER.length);
  const after = currentReadme.slice(end);
  return `${before}\n${section}\n${after}`;
}

function main() {
  const check = process.argv.includes("--check");
  const doc = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  const currentReadme = readFileSync(README_PATH, "utf8");
  const section = generateShortcutsSection(doc);
  const nextReadme = buildReadme(currentReadme, section);

  if (nextReadme === currentReadme) {
    if (!check) console.log("README shortcuts already up to date.");
    return;
  }
  if (check) {
    console.error("README shortcuts are out of date. Run `pnpm gen:shortcuts` and commit the result.");
    process.exit(1);
  }
  writeFileSync(README_PATH, nextReadme);
  console.log("Updated README shortcuts from shortcuts.data.json.");
}

// Only run when invoked directly, so the Vite plugin can import the helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
