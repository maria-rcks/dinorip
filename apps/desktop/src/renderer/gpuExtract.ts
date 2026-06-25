/**
 * GPU-accelerated perspective extraction (the ripper "projection").
 *
 * This mirrors the CPU `extractPerspective` from @dinorip/core, but runs the
 * per-pixel quad-warp + bilinear sample on the GPU via a WebGL2 fragment
 * shader. The CPU path samples every output pixel in a nested loop (~8M scalar
 * ops for a 512x512 result); the GPU rasterizes the same warp in one draw call,
 * which is fast enough to run live on every pointer move instead of behind a
 * debounce.
 *
 * The math is kept pixel-equivalent to the CPU version:
 *   - The output coordinate (u, v) is bilinearly interpolated across the four
 *     ripper corners exactly like `lerpVec2(lerpVec2(...))` does. We feed the
 *     CPU `v` (1 at the top row, 0 at the bottom) straight through as a varying
 *     so triangle interpolation cannot drift from the CPU result.
 *   - Source sampling applies the same half-texel mapping that the CPU
 *     `sampleBilinear` uses (x = u * (w - 1)), so GPU LINEAR filtering lands on
 *     the same texels.
 *   - Textures are uploaded with straight (non-premultiplied) alpha so edge
 *     blending matches the CPU's independent per-channel lerp.
 */
import { findOwnerImageIndex, inferExtractionSize } from "@dinorip/core";
import type { ExtractionResult, PixelImage, PlacedImage, PolygonRipper } from "@dinorip/core";

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
in vec2 aUV;
out vec2 vUV;
uniform float uFlipY;       // +1 upright (canvas preview), -1 flipped (FBO readback)
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos.x, aPos.y * uFlipY, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUV;                 // vUV.x = u in [0,1], vUV.y = v in [0,1] (1 = top)
out vec4 fragColor;
uniform sampler2D uSource;
uniform vec2 uTopLeft;
uniform vec2 uTopRight;
uniform vec2 uBottomRight;
uniform vec2 uBottomLeft;
uniform vec2 uOwnerPos;
uniform vec2 uScale;
uniform vec2 uImgSize;
void main() {
  vec2 top = mix(uTopLeft, uTopRight, vUV.x);
  vec2 bottom = mix(uBottomLeft, uBottomRight, vUV.x);
  vec2 p = mix(bottom, top, vUV.y);
  float localX = (p.x - uOwnerPos.x) / uScale.x;
  float localY = (p.y - uOwnerPos.y) / uScale.y;
  float su = clamp(localX / uImgSize.x + 0.5, 0.0, 1.0);
  float sv = clamp(localY / uImgSize.y + 0.5, 0.0, 1.0);
  // Match the CPU sampleBilinear mapping (x = u*(w-1)) under GPU LINEAR filtering.
  float tx = (su * (uImgSize.x - 1.0) + 0.5) / uImgSize.x;
  float ty = ((1.0 - sv) * (uImgSize.y - 1.0) + 0.5) / uImgSize.y;
  fragColor = texture(uSource, vec2(tx, ty));
}`;

// Two triangles covering the output framebuffer. Each vertex carries the CPU
// (u, v) directly: u=0 left / u=1 right, v=1 top / v=0 bottom.
const QUAD = new Float32Array([
  // aPos.x, aPos.y, aUV.x(u), aUV.y(v)
  -1, 1, 0, 1, // top-left
  1, 1, 1, 1, // top-right
  1, -1, 1, 0, // bottom-right
  -1, 1, 0, 1, // top-left
  1, -1, 1, 0, // bottom-right
  -1, -1, 0, 0 // bottom-left
]);

interface GpuContext {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  outputTexture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  outputWidth: number;
  outputHeight: number;
  sourceTextures: WeakMap<PixelImage, WebGLTexture>;
}

let context: GpuContext | null = null;
let initFailed = false;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log ?? "unknown error"}`);
  }
  return shader;
}

function init(): GpuContext | null {
  if (context) return context;
  if (initFailed) return null;

  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      // The live-preview path renders straight to this canvas and then reads it
      // back via drawImage() onto the atlas 2D canvas, so the drawing buffer
      // must survive past the implicit per-frame clear.
      preserveDrawingBuffer: true,
      antialias: false
    });
    if (!gl) throw new Error("WebGL2 is unavailable.");

    const program = gl.createProgram();
    if (!program) throw new Error("Unable to create program.");
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, "aPos");
    gl.bindAttribLocation(program, 1, "aUV");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program) ?? "unknown error"}`);
    }
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    const outputTexture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!outputTexture || !framebuffer) throw new Error("Unable to create framebuffer target.");

    gl.useProgram(program);
    const uniforms: GpuContext["uniforms"] = {};
    for (const name of [
      "uSource",
      "uTopLeft",
      "uTopRight",
      "uBottomRight",
      "uBottomLeft",
      "uOwnerPos",
      "uScale",
      "uImgSize",
      "uFlipY"
    ]) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.uniform1i(uniforms.uSource ?? null, 0);

    context = {
      gl,
      program,
      uniforms,
      outputTexture,
      framebuffer,
      outputWidth: 0,
      outputHeight: 0,
      sourceTextures: new WeakMap()
    };
    return context;
  } catch (error) {
    initFailed = true;
    context = null;
    if (typeof console !== "undefined") console.warn("GPU extraction unavailable, falling back to CPU.", error);
    return null;
  }
}

export function isGpuExtractAvailable(): boolean {
  return init() !== null;
}

function uploadSource(ctx: GpuContext, image: PixelImage): WebGLTexture {
  const cached = ctx.sourceTextures.get(image);
  if (cached) return cached;

  const { gl } = ctx;
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to create source texture.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    image.width,
    image.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  ctx.sourceTextures.set(image, texture);
  return texture;
}

function resizeOutput(ctx: GpuContext, width: number, height: number): void {
  if (ctx.outputWidth === width && ctx.outputHeight === height) return;
  const { gl } = ctx;
  gl.bindTexture(gl.TEXTURE_2D, ctx.outputTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ctx.outputTexture, 0);
  ctx.outputWidth = width;
  ctx.outputHeight = height;
}

// Binds the source texture + uniforms for `ripper`/`owner` and draws the warp
// into the currently bound framebuffer at the given viewport size. The caller
// binds the target framebuffer first. `flipY` is +1 for the upright canvas
// preview and -1 for an FBO that will be read back (so readPixels' bottom-up
// rows arrive already in PixelImage top-down order, no CPU flip needed).
function drawWarp(
  ctx: GpuContext,
  ripper: PolygonRipper,
  owner: PlacedImage,
  width: number,
  height: number,
  flipY: number
): void {
  const { gl } = ctx;
  const [topLeft, topRight, bottomRight, bottomLeft] = ripper.points;
  const scaleX = owner.scale.x === 0 ? 1 : owner.scale.x;
  const scaleY = owner.scale.y === 0 ? 1 : owner.scale.y;
  const sourceTexture = uploadSource(ctx, owner.image);

  gl.useProgram(ctx.program);
  gl.viewport(0, 0, width, height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sourceTexture);

  const u = ctx.uniforms;
  gl.uniform2f(u.uTopLeft ?? null, topLeft.x, topLeft.y);
  gl.uniform2f(u.uTopRight ?? null, topRight.x, topRight.y);
  gl.uniform2f(u.uBottomRight ?? null, bottomRight.x, bottomRight.y);
  gl.uniform2f(u.uBottomLeft ?? null, bottomLeft.x, bottomLeft.y);
  gl.uniform2f(u.uOwnerPos ?? null, owner.position.x, owner.position.y);
  gl.uniform2f(u.uScale ?? null, scaleX, scaleY);
  gl.uniform2f(u.uImgSize ?? null, owner.image.width, owner.image.height);
  gl.uniform1f(u.uFlipY ?? null, flipY);

  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/**
 * GPU equivalent of `extractPerspective`. Returns null when no source image
 * owns the ripper (same contract as the CPU version), or when the GPU context
 * is unavailable/failed mid-draw — callers should fall back to the CPU/worker
 * path on null only after checking `isGpuExtractAvailable()`.
 *
 * This blocks on readPixels; prefer `gpuExtractPerspectiveAsync` on the hot
 * release path to avoid stalling the main thread.
 */
export function gpuExtractPerspective(
  ripper: PolygonRipper,
  sourceImages: PlacedImage[]
): ExtractionResult | null {
  const ctx = init();
  if (!ctx) return null;

  const ownerIndex = findOwnerImageIndex(ripper, sourceImages);
  if (ownerIndex < 0) return null;
  const owner = sourceImages[ownerIndex];
  if (!owner) return null;

  try {
    const { gl } = ctx;
    const { width, height } = inferExtractionSize(ripper);

    resizeOutput(ctx, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.framebuffer);
    drawWarp(ctx, ripper, owner, width, height, -1);

    // Flipped in-shader, so readPixels' bottom-up rows are already top-down.
    const out = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(out.buffer));

    return { image: { width, height, data: out }, ownerIndex };
  } catch (error) {
    initFailed = true;
    context = null;
    if (typeof console !== "undefined") console.warn("GPU extraction failed, falling back to CPU.", error);
    return null;
  }
}

/**
 * Non-blocking version of `gpuExtractPerspective`. Kicks off the readback into a
 * Pixel Buffer Object and polls a fence across animation frames, so the main
 * thread never stalls waiting for the GPU. Used to commit the final texture on
 * pointer-up without the release hitch. Resolves null when no source owns the
 * ripper or the GPU is unavailable.
 */
export function gpuExtractPerspectiveAsync(
  ripper: PolygonRipper,
  sourceImages: PlacedImage[]
): Promise<ExtractionResult | null> {
  const ctx = init();
  if (!ctx) return Promise.resolve(null);

  const ownerIndex = findOwnerImageIndex(ripper, sourceImages);
  if (ownerIndex < 0) return Promise.resolve(null);
  const owner = sourceImages[ownerIndex];
  if (!owner) return Promise.resolve(null);

  try {
    const { gl } = ctx;
    const { width, height } = inferExtractionSize(ripper);
    const byteLength = width * height * 4;

    resizeOutput(ctx, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.framebuffer);
    drawWarp(ctx, ripper, owner, width, height, -1);

    // Each in-flight commit gets its own PBO; readPixels(…, 0) packs into it
    // asynchronously on the GPU and returns immediately.
    const pbo = gl.createBuffer();
    if (!pbo) throw new Error("Unable to create pixel pack buffer.");
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLength, gl.STREAM_READ);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();

    return new Promise<ExtractionResult | null>((resolve) => {
      const finish = (result: ExtractionResult | null) => {
        if (sync) gl.deleteSync(sync);
        gl.deleteBuffer(pbo);
        resolve(result);
      };
      const poll = () => {
        if (!sync) return finish(null);
        const status = gl.clientWaitSync(sync, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) {
          requestAnimationFrame(poll);
          return;
        }
        if (status === gl.WAIT_FAILED) return finish(null);
        const out = new Uint8ClampedArray(byteLength);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, new Uint8Array(out.buffer), 0, byteLength);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        finish({ image: { width, height, data: out }, ownerIndex });
      };
      requestAnimationFrame(poll);
    });
  } catch (error) {
    initFailed = true;
    context = null;
    if (typeof console !== "undefined") console.warn("GPU async extraction failed.", error);
    return Promise.resolve(null);
  }
}

export interface LivePreviewRender {
  /** The shared WebGL canvas holding the latest projection (upright). */
  canvas: HTMLCanvasElement;
  /** Full natural output dimensions, for sizing the on-screen rect. */
  width: number;
  height: number;
}

/**
 * Renders the projection straight to the WebGL canvas with NO pixel readback,
 * so it stays entirely on the GPU. Callers blit the returned canvas to screen
 * with drawImage(); this is what makes live dragging instant and independent of
 * ripper size. The internal render resolution is capped (the canvas is stretched
 * to the full display rect), since fragment fill is cheap but huge drawing
 * buffers are not. Returns null when no source owns the ripper or the GPU is
 * unavailable.
 */
export function gpuRenderLivePreview(
  ripper: PolygonRipper,
  sourceImages: PlacedImage[],
  maxRenderSize = 2048
): LivePreviewRender | null {
  const ctx = init();
  if (!ctx) return null;

  const ownerIndex = findOwnerImageIndex(ripper, sourceImages);
  if (ownerIndex < 0) return null;
  const owner = sourceImages[ownerIndex];
  if (!owner) return null;

  try {
    const { gl } = ctx;
    const full = inferExtractionSize(ripper);
    const renderScale = Math.min(1, maxRenderSize / Math.max(full.width, full.height));
    const renderWidth = Math.max(1, Math.round(full.width * renderScale));
    const renderHeight = Math.max(1, Math.round(full.height * renderScale));

    const canvas = gl.canvas as HTMLCanvasElement;
    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      canvas.width = renderWidth;
      canvas.height = renderHeight;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    drawWarp(ctx, ripper, owner, renderWidth, renderHeight, 1);
    gl.flush();

    return { canvas, width: full.width, height: full.height };
  } catch (error) {
    initFailed = true;
    context = null;
    if (typeof console !== "undefined") console.warn("GPU live preview failed.", error);
    return null;
  }
}
