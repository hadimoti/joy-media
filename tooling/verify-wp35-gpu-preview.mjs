import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GpuPreviewHost } from '../apps/worker/dist/gpu-preview-host.js';

const bitmapWidth = 64;
const bitmapHeight = 64;
const bitmapRgba = Buffer.alloc(bitmapWidth * bitmapHeight * 4);
for (let y = 0; y < bitmapHeight; y++) {
  for (let x = 0; x < bitmapWidth; x++) {
    const offset = (y * bitmapWidth + x) * 4;
    bitmapRgba[offset] = 20 + Math.round((x / (bitmapWidth - 1)) * 45);
    bitmapRgba[offset + 1] = 70 + Math.round((y / (bitmapHeight - 1)) * 80);
    bitmapRgba[offset + 2] = 185;
    bitmapRgba[offset + 3] = 255;
  }
}

const host = await GpuPreviewHost.create();
const startedAt = performance.now();
try {
  const response = await host.render({
    protocolVersion: 1,
    capability: 'render.preview.gpu',
    sessionId: 'wp35-hardware-fixture',
    sessionToken: 'fixture-only',
    requestId: 1,
    projectId: 'wp35-fixture',
    projectRevisionId: 'fixture-revision',
    compositionId: 'root',
    timeUs: 2_000_000,
    quality: 'quarter',
    deadlineMs: 2_000,
    noStore: true,
    bitmaps: [
      {
        nodeId: 'video-main',
        width: bitmapWidth,
        height: bitmapHeight,
        rgbaBase64: bitmapRgba.toString('base64'),
      },
    ],
    frame: {
      version: 1,
      compositionId: 'root',
      timeUs: 2_000_000,
      viewport: { width: 640, height: 360, dpr: 1 },
      background: { r: 14, g: 18, b: 26, a: 255 },
      nodes: [
        {
          id: 'video-main',
          kind: 'video-frame',
          width: 360,
          height: 230,
          sourceTimeUs: 2_000_000,
          color: { r: 30, g: 94, b: 170, a: 255 },
          zIndex: 1,
          opacity: 1,
          transform: { translateX: 20, translateY: 28, scaleX: 1, scaleY: 1 },
        },
        {
          id: 'image-overlay',
          kind: 'sprite',
          width: 210,
          height: 145,
          color: { r: 235, g: 164, b: 42, a: 230 },
          zIndex: 2,
          opacity: 0.95,
          transform: { translateX: 280, translateY: 66, scaleX: 1, scaleY: 1 },
        },
        {
          id: 'title',
          kind: 'text',
          text: 'JOY GPU WORKER',
          color: { r: 255, g: 255, b: 255, a: 255 },
          fontSizePx: 38,
          fontWeight: 700,
          zIndex: 3,
          opacity: 1,
          transform: { translateX: 320, translateY: 18, scaleX: 1, scaleY: 1 },
          align: 'center',
        },
        {
          id: 'caption',
          kind: 'text',
          text: 'Universal rows · mixed elements · Quarter',
          color: { r: 255, g: 255, b: 255, a: 255 },
          background: { r: 0, g: 0, b: 0, a: 210 },
          fontSizePx: 24,
          fontWeight: 600,
          zIndex: 4,
          opacity: 1,
          transform: { translateX: 320, translateY: 305, scaleX: 1, scaleY: 1 },
          align: 'center',
        },
      ],
    },
  });
  const evidenceDirectory = join(process.cwd(), 'docs', 'qa', 'wp35');
  mkdirSync(evidenceDirectory, { recursive: true });
  const pngPath = join(evidenceDirectory, 'gpu-worker-mixed-frame.png');
  const jsonPath = join(evidenceDirectory, 'gpu-worker-mixed-frame.json');
  writeFileSync(pngPath, response.bytes);
  const evidence = {
    renderer: response.renderer,
    hardware: host.identity,
    quality: response.quality,
    width: response.width,
    height: response.height,
    bytes: response.bytes.byteLength,
    sha256: createHash('sha256').update(response.bytes).digest('hex'),
    latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
    png: 'docs/qa/wp35/gpu-worker-mixed-frame.png',
  };
  writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally {
  await host.destroy();
}
