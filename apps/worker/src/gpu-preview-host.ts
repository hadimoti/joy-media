import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  WORKER_PROTOCOL_VERSION,
  type GpuPreviewFrameRequest,
  type GpuPreviewFrameResponse,
} from '@joy-media/job-protocol';

const SOFTWARE_RENDERER = /swiftshader|software|llvmpipe|softpipe|mesa offscreen/i;

export interface HardwareGpuIdentity {
  readonly renderer: string;
  readonly vendor: string;
  readonly backend: string;
}

export class GpuPreviewHost {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    readonly identity: HardwareGpuIdentity,
  ) {}

  static async create(
    executablePath = resolveChromiumExecutable(process.env.JOY_MEDIA_GPU_BROWSER_PATH),
  ): Promise<GpuPreviewHost> {
    if (executablePath === undefined)
      throw new Error('Chrome or Edge is required for hardware GPU preview');
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        '--use-angle=d3d11',
        '--enable-gpu',
        '--disable-software-rasterizer',
        '--disable-background-timer-throttling',
      ],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
      const identity = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2', {
          alpha: true,
          antialias: true,
          preserveDrawingBuffer: true,
        });
        if (gl === null) throw new Error('WebGL2 is unavailable');
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer =
          info === null
            ? String(gl.getParameter(gl.RENDERER))
            : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
        const vendor =
          info === null
            ? String(gl.getParameter(gl.VENDOR))
            : String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL));
        return { renderer, vendor, backend: String(gl.getParameter(gl.VERSION)) };
      });
      if (
        identity.renderer.length === 0 ||
        SOFTWARE_RENDERER.test(identity.renderer) ||
        SOFTWARE_RENDERER.test(identity.backend)
      )
        throw new Error(`software GPU renderer rejected: ${identity.renderer}`);
      return new GpuPreviewHost(browser, page, identity);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  async render(request: GpuPreviewFrameRequest): Promise<GpuPreviewFrameResponse> {
    const result = await this.page.evaluate(renderGpuFrame, {
      frame: request.frame,
      quality: request.quality,
      bitmaps: request.bitmaps ?? [],
    });
    return {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      sessionId: request.sessionId,
      requestId: request.requestId,
      renderer: 'hardware-gpu',
      quality: request.quality,
      width: result.width,
      height: result.height,
      bytes: new Uint8Array(Buffer.from(result.pngBase64, 'base64')),
    };
  }

  async destroy(): Promise<void> {
    await this.browser.close();
  }
}

function resolveChromiumExecutable(configured: string | undefined): string | undefined {
  const candidates = [
    configured?.trim(),
    process.platform === 'win32'
      ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      : undefined,
    process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : undefined,
    process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined,
    process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
    process.platform === 'linux' ? '/usr/bin/chromium' : undefined,
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  return candidates.find((candidate) => existsSync(candidate));
}

async function renderGpuFrame(input: {
  frame: GpuPreviewFrameRequest['frame'];
  quality: GpuPreviewFrameRequest['quality'];
  bitmaps: NonNullable<GpuPreviewFrameRequest['bitmaps']>;
}): Promise<{ width: number; height: number; pngBase64: string }> {
  const scale = input.quality === 'quarter' ? 0.25 : input.quality === 'half' ? 0.5 : 1;
  const width = Math.max(1, Math.round(input.frame.viewport.width * scale));
  const height = Math.max(1, Math.round(input.frame.viewport.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (gl === null) throw new Error('WebGL2 context was lost');

  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (vertex === null || fragment === null || program === null)
    throw new Error('WebGL program allocation failed');
  gl.shaderSource(
    vertex,
    `#version 300 es
    in vec2 a_position;
    uniform vec2 u_resolution;
    uniform vec4 u_rect;
    void main() {
      vec2 pixel = u_rect.xy + a_position * u_rect.zw;
      vec2 clip = (pixel / u_resolution) * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    }`,
  );
  gl.shaderSource(
    fragment,
    `#version 300 es
    precision highp float;
    uniform vec4 u_color;
    out vec4 outColor;
    void main() { outColor = u_color; }`,
  );
  gl.compileShader(vertex);
  gl.compileShader(fragment);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(`WebGL link failed: ${String(gl.getProgramInfoLog(program))}`);
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, 'a_position');
  const resolution = gl.getUniformLocation(program, 'u_resolution');
  const rect = gl.getUniformLocation(program, 'u_rect');
  const color = gl.getUniformLocation(program, 'u_color');
  const buffer = gl.createBuffer();
  if (position < 0 || resolution === null || rect === null || color === null || buffer === null)
    throw new Error('WebGL uniforms are unavailable');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.uniform2f(resolution, width, height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const bg = input.frame.background;
  gl.clearColor(bg.r / 255, bg.g / 255, bg.b / 255, bg.a / 255);
  gl.clear(gl.COLOR_BUFFER_BIT);

  type FlatNode = Exclude<(typeof input.frame.nodes)[number], { kind: 'group' }> & {
    transform: { translateX: number; translateY: number; scaleX: number; scaleY: number };
    opacity: number;
  };
  const flat: FlatNode[] = [];
  const flatten = (
    nodes: typeof input.frame.nodes,
    parent = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, opacity: 1 },
  ): void => {
    for (const node of nodes) {
      const state = {
        translateX: parent.translateX + node.transform.translateX * parent.scaleX,
        translateY: parent.translateY + node.transform.translateY * parent.scaleY,
        scaleX: parent.scaleX * node.transform.scaleX,
        scaleY: parent.scaleY * node.transform.scaleY,
        opacity: parent.opacity * node.opacity,
      };
      if (node.kind === 'group') flatten(node.children, state);
      else flat.push({ ...node, transform: state, opacity: state.opacity } as FlatNode);
    }
  };
  flatten(input.frame.nodes);
  flat.sort((left, right) => left.zIndex - right.zIndex);
  gl.finish();

  // CanvasText-style glyph rasterization mirrors Pixi: WebGL owns the scene
  // surfaces while the browser glyph engine supplies transient text textures.
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const context = output.getContext('2d');
  if (context === null) throw new Error('2D compositor is unavailable');
  context.imageSmoothingEnabled = true;
  context.drawImage(canvas, 0, 0);
  const bitmaps = new Map(input.bitmaps.map((bitmap) => [bitmap.nodeId, bitmap]));
  for (const node of flat) {
    const bitmap = bitmaps.get(node.id);
    if (bitmap !== undefined && node.kind === 'video-frame') {
      const binary = atob(bitmap.rgbaBase64);
      const rgba = new Uint8ClampedArray(binary.length);
      for (let index = 0; index < binary.length; index++) rgba[index] = binary.charCodeAt(index);
      const source = document.createElement('canvas');
      source.width = bitmap.width;
      source.height = bitmap.height;
      source.getContext('2d')?.putImageData(new ImageData(rgba, bitmap.width, bitmap.height), 0, 0);
      context.save();
      context.globalAlpha = node.opacity;
      context.drawImage(
        source,
        node.transform.translateX * scale,
        node.transform.translateY * scale,
        node.width * node.transform.scaleX * scale,
        node.height * node.transform.scaleY * scale,
      );
      context.restore();
      continue;
    }
    if (node.kind === 'text') {
      const fontSize = Math.max(1, (node.fontSizePx ?? 16) * scale);
      const family = node.fontFamily ?? 'Arial, sans-serif';
      context.save();
      context.globalAlpha = node.opacity;
      context.direction = node.direction ?? 'ltr';
      context.textAlign = node.align ?? 'left';
      context.textBaseline = 'top';
      context.font = `${node.italic ? 'italic ' : ''}${node.fontWeight ?? 400} ${fontSize}px ${family}`;
      const x = node.transform.translateX * scale;
      const y = node.transform.translateY * scale;
      const metrics = context.measureText(node.text);
      if (node.background !== undefined) {
        const padding = Math.max(2, fontSize * 0.12);
        const plateX =
          node.align === 'center'
            ? x - metrics.width / 2
            : node.align === 'right'
              ? x - metrics.width
              : x;
        context.fillStyle = `rgba(${node.background.r},${node.background.g},${node.background.b},${node.background.a / 255})`;
        context.fillRect(
          plateX - padding,
          y - padding,
          metrics.width + padding * 2,
          fontSize * 1.25 + padding * 2,
        );
      }
      const textColor = node.fill?.kind === 'solid' ? node.fill.color : node.color;
      context.fillStyle = `rgba(${textColor.r},${textColor.g},${textColor.b},${textColor.a / 255})`;
      if (node.shadow !== undefined) {
        context.shadowColor = `rgba(${node.shadow.color.r},${node.shadow.color.g},${node.shadow.color.b},${node.shadow.color.a / 255})`;
        context.shadowBlur = node.shadow.blurPx * scale;
        context.shadowOffsetX = node.shadow.offsetX * scale;
        context.shadowOffsetY = node.shadow.offsetY * scale;
      }
      if (node.stroke !== undefined) {
        context.lineWidth = node.stroke.widthPx * scale;
        context.strokeStyle = `rgba(${node.stroke.color.r},${node.stroke.color.g},${node.stroke.color.b},${node.stroke.color.a / 255})`;
        context.strokeText(
          node.text,
          x,
          y,
          node.maxWidth === undefined ? undefined : node.maxWidth * scale,
        );
      }
      context.fillText(
        node.text,
        x,
        y,
        node.maxWidth === undefined ? undefined : node.maxWidth * scale,
      );
      context.restore();
      continue;
    }

    const nodeColor = node.color;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4f(
      rect,
      node.transform.translateX * scale,
      node.transform.translateY * scale,
      node.width * node.transform.scaleX * scale,
      node.height * node.transform.scaleY * scale,
    );
    gl.uniform4f(
      color,
      nodeColor.r / 255,
      nodeColor.g / 255,
      nodeColor.b / 255,
      (nodeColor.a / 255) * node.opacity,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.finish();
    context.drawImage(canvas, 0, 0);
  }
  const pngBase64 = output.toDataURL('image/png').slice('data:image/png;base64,'.length);
  gl.deleteBuffer(buffer);
  gl.deleteProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return { width, height, pngBase64 };
}

export { resolveChromiumExecutable };
