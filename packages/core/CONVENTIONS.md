# Core Conventions

- `PixelImage` data is RGBA byte data in Canvas/ImageData order: row-major, row 0 at the visual top.
- Workspace geometry uses y-up, center-pivot coordinates. Placed image positions are their centers.
- `sampleBilinear(image, u, v)` accepts y-up UVs: `v = 0` samples the bottom edge and `v = 1` samples the top edge.
- Perspective extraction and atlas rasterization convert from y-up workspace coordinates into top-left row-major image buffers at the sampling boundary.
