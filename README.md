<div align="center">

# 🦖 DinoRip

**A texture ripper & seamless-tile workshop for game artists.**

![DinoRip screenshot](assets/screenshot.png)

</div>

DinoRip lets you rip textures out of reference photos and turn them into clean,
tiling texture atlases. Place a perspective ripper over the geometry in an image,
extract the surface into the atlas workspace, adjust it, and export a single
texture file, all in a fast, pixel-styled desktop UI.

It is a clean-room Electron + TypeScript rebuild of a classic texture
ripper / seamless-maker workflow.

## Features

- **Image ripper**: load PNG/JPG/JPEG reference images and place a four-point
  perspective ripper over the object's surface; drag vertices or the whole ripper.
- **Perspective extraction**: sample the ripped quad into a flat texture in the
  atlas workspace.
- **Texture atlas**: move, scale (mouse wheel), and edge-snap extracted textures,
  then export them as a single atlas file.
- **Texture options**: brightness, contrast, saturation, hue shift, grayscale,
  invert, and sharpen, applied across one or all textures.
- **Seamless tiling**: Smoothed Collage and Scattered Edges seam generation with
  a tiled live preview.
- **Export**: export the selected texture, export all textures, or export the
  full atlas as PNG.

## Project structure

| Path | Description |
| --- | --- |
| `packages/core` | Pure TypeScript: image models, bilinear sampling, perspective extraction, seamless processing, flip/resize, atlas rasterization. |
| `packages/ipc-contracts` | Typed IPC channels and shared constants. |
| `apps/desktop` | Electron main/preload, React + Vite renderer, Canvas workspaces, worker processing, and electron-builder config. |

## Getting started

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts Vite and Electron together.

### Other scripts

```sh
pnpm typecheck   # type-check every package
pnpm test        # run unit tests
pnpm lint        # lint all packages
pnpm build       # build all packages
```

## Packaging

The desktop app packages with [electron-builder](https://www.electron.build/)
for macOS, Windows, and Linux:

```sh
pnpm --filter @dinorip/desktop dist
```

> [!NOTE]
> `sharp` ships platform-specific native binaries, so each OS target must be
> packaged on (or cross-installed for) that platform. Code signing and
> notarization are not configured.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 11+

## License

MIT
