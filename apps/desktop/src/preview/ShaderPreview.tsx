import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

// Animated "wavy chevron" shader used as the Seam Options preview. The pattern
// continuously travels toward the top-right corner in a seamless loop.
const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  // Keep the cells square regardless of the canvas aspect ratio.
  uv.x *= u_resolution.x / u_resolution.y;

  // Scroll the whole field toward the top-right in a seamless loop.
  float t = u_time * 0.12;
  vec2 p = (uv + vec2(t, t)) * 9.0;

  // Triangle wave along x offsets each row -> chevron, plus a soft wobble so the
  // chevrons read as organic "waves" rather than hard zigzags.
  float tri = abs(fract(p.x * 0.5) - 0.5) * 2.0;
  float wob = 0.18 * sin(p.x * 1.3 + u_time * 0.9) + 0.10 * sin(p.y * 0.7);
  float rows = p.y + tri * 1.6 + wob;

  float d = abs(fract(rows) - 0.5);
  // Hard step (no smoothstep) keeps the chevron edges aliased/jagged.
  float line = step(d, 0.24);

  vec3 base = vec3(0.235);
  vec3 dark = vec3(0.155);
  vec3 col = mix(base, dark, line);
  col *= 0.92 + 0.08 * sin(p.x * 0.5);

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function ShaderPreview(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, depth: false });
    if (!gl) return;

    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    const timeLocation = gl.getUniformLocation(program, "u_time");

    let frame = 0;
    let start = 0;

    // Render into a small fixed buffer so the CSS upscale (image-rendering:
    // pixelated) produces chunky pixels instead of a smooth gradient.
    const PIXEL_RESOLUTION = 64;

    const resize = () => {
      if (canvas.width !== PIXEL_RESOLUTION || canvas.height !== PIXEL_RESOLUTION) {
        canvas.width = PIXEL_RESOLUTION;
        canvas.height = PIXEL_RESOLUTION;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const render = (now: number) => {
      if (start === 0) start = now;
      resize();
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(timeLocation, (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frame = window.requestAnimationFrame(render);
    };
    frame = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(frame);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteBuffer(buffer);
    };
  }, []);

  return <canvas ref={canvasRef} className="seam-shader" aria-hidden="true" />;
}
