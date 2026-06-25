import type { ReactElement } from "react";

/**
 * Small pixel-art glyphs shown beside each panel title. They are hand-placed
 * rects (no anti-aliasing) so they read crisply at the chunky pixel-font scale.
 */
export function PanelGlyph({ id }: { id: string }): ReactElement {
  if (id === "ripper") return <RipperGlyph />;
  if (id === "atlas") return <AtlasGlyph />;
  return <ToolsGlyph />;
}

function Svg({ children }: { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      className="panel-glyph"
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Corner brackets — a crop/scan frame, matching the "[ ]" mark in the mock.
function RipperGlyph(): ReactElement {
  return (
    <Svg>
      <rect x="0" y="0" width="6" height="2" />
      <rect x="0" y="0" width="2" height="6" />
      <rect x="10" y="0" width="6" height="2" />
      <rect x="14" y="0" width="2" height="6" />
      <rect x="0" y="14" width="6" height="2" />
      <rect x="0" y="10" width="2" height="6" />
      <rect x="10" y="14" width="6" height="2" />
      <rect x="14" y="10" width="2" height="6" />
    </Svg>
  );
}

// Two stacked tiles — a filled square in front of an outlined one.
function AtlasGlyph(): ReactElement {
  return (
    <Svg>
      <rect x="6" y="6" width="10" height="2" />
      <rect x="6" y="14" width="10" height="2" />
      <rect x="6" y="6" width="2" height="10" />
      <rect x="14" y="6" width="2" height="10" />
      <rect x="0" y="0" width="9" height="9" />
    </Svg>
  );
}

// Simple filled block fallback for the tools panel (its heading is hidden).
function ToolsGlyph(): ReactElement {
  return (
    <Svg>
      <rect x="1" y="1" width="14" height="14" />
    </Svg>
  );
}
