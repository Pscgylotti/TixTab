import type { ImagePolygon } from './pdfNightGeometry';
import { transformNightPixels } from './pdfNightColors';
import { bitmapDimmingCurve, fullyCoveredByBitmap } from './nightGpuPolicy';
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};
function pictureMask(width: number, height: number, polygons: ImagePolygon[]) {
  const canvas = new OffscreenCanvas(width, height),
    ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = 'white';
  for (const p of polygons) {
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.closePath();
    ctx.fill();
  }
  return { canvas, ctx };
}
// Fully covered opaque bitmap pages use the exact CPU per-channel curve.
// No weighted color arithmetic, neighbouring samples or inverse-alpha rounding.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D page;
uniform sampler2D curve;
uniform int rows;
out vec4 color;
void main() {
  ivec2 at = ivec2(int(gl_FragCoord.x), rows - 1 - int(gl_FragCoord.y));
  ivec3 c = ivec3(round(texelFetch(page, at, 0).rgb * 255.0));
  color = vec4(texelFetch(curve, ivec2(c.r, 0), 0).r,
               texelFetch(curve, ivec2(c.g, 0), 0).r,
               texelFetch(curve, ivec2(c.b, 0), 0).r, 1.0);
}`;
const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;
interface Gpu {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  limit: number;
  page: WebGLTexture;
  curve: WebGLTexture;
  rows: WebGLUniformLocation;
}
let gpu: Gpu | null | undefined;
function createGpu(): Gpu | null {
  try {
    const canvas = new OffscreenCanvas(1, 1),
      gl = canvas.getContext('webgl2', {
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'low-power',
      });
    if (!gl) return null;
    gl.disable(gl.DITHER);
    const program = gl.createProgram()!;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    gl.useProgram(program);
    const texture = (unit: number, name: string) => {
      const value = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, value);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
      return value;
    };
    const page = texture(0, 'page'),
      curve = texture(1, 'curve');
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bitmapDimmingCurve(),
    );
    return {
      canvas,
      gl,
      program,
      limit: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      page,
      curve,
      rows: gl.getUniformLocation(program, 'rows')!,
    };
  } catch {
    return null;
  }
}
function convertOnGpu(
  bitmap: ImageBitmap,
  polygons: ImagePolygon[],
  opaque: boolean,
): ImageBitmap | null {
  if (!opaque || !fullyCoveredByBitmap(bitmap.width, bitmap.height, polygons)) return null;
  if (gpu === undefined) gpu = createGpu();
  if (!gpu) return null;
  const { canvas, gl } = gpu,
    { width, height } = bitmap;
  if (width > gpu.limit || height > gpu.limit) return null;
  try {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.uniform1i(gpu.rows, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) throw new Error('night-gpu');
    return canvas.transferToImageBitmap();
  } catch {
    gl.deleteTexture(gpu.page);
    gl.deleteTexture(gpu.curve);
    gl.deleteProgram(gpu.program);
    gpu = undefined;
    return null;
  }
}
function convertOnCpu(
  bitmap: ImageBitmap,
  polygons: ImagePolygon[],
  maskFrame?: { width: number; height: number; x: number; y: number },
) {
  const { width, height } = bitmap,
    canvas = new OffscreenCanvas(width, height),
    ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height);
  const mask = polygons.length
    ? pictureMask(
        maskFrame?.width ?? width,
        maskFrame?.height ?? height,
        polygons,
      ).ctx.getImageData(maskFrame?.x ?? 0, maskFrame?.y ?? 0, width, height).data
    : undefined;
  transformNightPixels(pixels.data, mask);
  ctx.putImageData(pixels, 0, 0);
  return canvas.transferToImageBitmap();
}
scope.onmessage = ({
  data,
}: MessageEvent<{
  id: number;
  bitmap: ImageBitmap;
  polygons: ImagePolygon[];
  opaque?: boolean;
  maskFrame?: { width: number; height: number; x: number; y: number };
}>) => {
  const { id, bitmap, polygons, opaque = false, maskFrame } = data;
  try {
    const gpuOutput = maskFrame ? null : convertOnGpu(bitmap, polygons, opaque);
    const output = gpuOutput ?? convertOnCpu(bitmap, polygons, maskFrame);
    bitmap.close();
    scope.postMessage({ id, bitmap: output, backend: gpuOutput ? 'gpu' : 'cpu' }, [output]);
  } catch (error) {
    bitmap.close();
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
