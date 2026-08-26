import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import {
  createCompositionPlanV2,
  createRenderBundleV2,
} from '../../../packages/render-planner/src/v2.js';
import { deliveryPromiseForManifest } from '@joy-media/export-core';
import { inspectRenderedDelivery } from '@joy-media/production-quality';
import { EditorSession } from '../../editor-web/src/editor-session.js';
import { runWorkflow, resumeWorkflow } from '../../editor-web/src/workflow-runner.js';
import { createEditorSessionFirstPartyLibrary } from '../../editor-web/src/first-party-handlers.js';
import { BrowserProductionRunStore } from '../../editor-web/src/browser-production-run-store.js';
import { INITIAL_EDITOR_PROJECT } from '../../editor-web/src/editor-project.js';
import { executeLeasedExport } from './export-job.js';
import { StaticWorkerMediaResolver } from './worker-media-resolver.js';
import { WorkerRuntime } from './runtime.js';

const owner = {
  principalId: 'p3-local-owner',
  role: 'owner' as const,
  displayName: 'P3 local owner',
};
const TITLE_SOURCE_SHA = createHash('sha256').update('JOY MEDIA\0falsafeh-light').digest('hex');
const memoryStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe('P3 certified editor golden journey (local)', () => {
  it('runs bounded editor workflow + normal transaction, mints both V2 snapshots, exports and inspects retained artifacts', async () => {
    const storage = memoryStorage();
    const session = new EditorSession(storage, goldenTimeline(), goldenVisual());
    const store = new BrowserProductionRunStore(storage, {
      projectId: 'p3-golden',
      authority: owner,
    });
    const options = {
      productionRunStore: store,
      authority: owner,
      firstPartyLibrary: createEditorSessionFirstPartyLibrary(session),
    } as const;
    const parked = await runWorkflow(
      session,
      'joy.first-party.reference-social-cutdown.slice',
      {
        selectedMedia: { assetId: 'clip-a', mimeType: 'video/mp4', fileBacked: true },
        references: [{ referenceId: 'p3' }],
      },
      options,
    );
    expect(parked.status, JSON.stringify(parked)).toBe('waiting_for_input');
    if (parked.status !== 'waiting_for_input') return;
    const resumed = await resumeWorkflow(
      session,
      parked.runId,
      {
        'approve-cutdown': {
          commands: [
            {
              type: 'timeline.trimClipEnd',
              payload: {
                compositionId: 'root',
                trackId: 'track-0',
                clipId: 'intro',
                newEndUs: 300_000,
              },
            },
            {
              type: 'timeline.moveClip',
              payload: {
                compositionId: 'root',
                trackId: 'track-0',
                clipId: 'product',
                newStartUs: 300_000,
              },
            },
            {
              type: 'timeline.moveClip',
              payload: {
                compositionId: 'root',
                trackId: 'track-0',
                clipId: 'outro',
                newStartUs: 600_000,
              },
            },
          ],
        },
      },
      {
        ...options,
        ...(parked.approvalId === undefined ? {} : { approvalId: parked.approvalId }),
        ...(parked.approvalRequestedSeq === undefined
          ? {}
          : { approvalRequestedSeq: parked.approvalRequestedSeq }),
        ...(parked.approvalExpiresAtSeq === undefined
          ? {}
          : { approvalExpiresAtSeq: parked.approvalExpiresAtSeq }),
      },
    );
    expect(resumed.status, JSON.stringify(resumed)).toBe('succeeded');
    session.dispatchTimeline({
      label: 'P3 normal project transaction: add music',
      commands: [
        {
          type: 'timeline.addTrack',
          payload: {
            compositionId: 'root',
            track: {
              id: 'music-track',
              kind: 'audio',
              order: 2,
              enabled: true,
              locked: false,
              clips: [
                {
                  id: 'music',
                  kind: 'audio',
                  startUs: 0,
                  durationUs: 600_000,
                  assetId: 'music',
                  sourceInUs: 0,
                },
              ],
            },
          },
        },
      ],
    });
    expect(session.canUndo).toBe(true);

    const directory = mkdtempSync(join(tmpdir(), 'joy-media-p3-golden-'));
    const a = media(directory, 'a', 'red', 440);
    const b = media(directory, 'b', 'blue', 660);
    const overlay = image(directory);
    // The title is a published V2 static Motion surface: the worker resolves
    // these shaped RGBA pixels and never falls back to host text rendering.
    const titleBitmap = title(directory);
    const music = tone(directory);
    const resolver = new StaticWorkerMediaResolver({
      'asset:clip-a': a,
      'asset:clip-b': b,
      'asset:overlay': overlay,
      'asset:title-bitmap': titleBitmap,
      'asset:music': music,
    });
    const retained = new Map<string, Uint8Array>();
    for (const [name, viewport] of [
      ['landscape', { width: 320, height: 180 }],
      ['vertical', { width: 180, height: 320 }],
    ] as const) {
      const plan = createCompositionPlanV2({
        timelineProject: renderTimeline(session.timelineProject),
        visualProject: session.visualProject,
        viewport,
      });
      const assets = Object.fromEntries(
        Object.entries({
          'clip-a': a,
          'clip-b': b,
          overlay,
          'title-bitmap': titleBitmap,
          music,
        }).map(([id, path]) => {
          const bytes = readFileSync(path);
          return [
            id,
            {
              assetId: id,
              opaqueRef: `asset:${id}`,
              integrity: {
                sha256: createHash('sha256').update(bytes).digest('hex'),
                bytes: bytes.length,
                mime:
                  id === 'overlay' || id === 'title-bitmap'
                    ? 'image/png'
                    : id === 'music'
                      ? 'audio/wav'
                      : 'video/mp4',
              },
              ...(id === 'title-bitmap'
                ? {
                    textBitmap: {
                      sourceSha256: TITLE_SOURCE_SHA,
                      width: 32,
                      height: 14,
                      fontId: 'falsafeh-light',
                    },
                  }
                : {}),
            },
          ];
        }),
      );
      const bundle = createRenderBundleV2({
        plan,
        assets,
        projectRef: `p3-${name}`,
        revision: name === 'landscape' ? 1 : 2,
      });
      expect(bundle.snapshot.planSha256).toBe(plan.planSha256);
      const receipt = await executeLeasedExport(
        { complete: () => undefined },
        `p3-${name}`,
        `p3-${name}`,
        bundle,
        { outputDirectory: directory, mediaResolver: resolver },
      );
      const artifact = readFileSync(join(directory, `p3-${name}.mp4`));
      retained.set(receipt.outputRef, artifact);
      const promise = {
        ...deliveryPromiseForManifest(receipt.manifest),
        captions: {
          mode: 'burned-in' as const,
          required: true,
          burnIn: {
            styleRef: plan.captionBurnIn!.styleRef,
            segments: plan.captionBurnIn!.segments.map(({ startUs, endUs, text, direction }) => ({
              startUs,
              endUs,
              text,
              direction,
            })),
          },
        },
      };
      const report = inspectRenderedDelivery(join(directory, `p3-${name}.mp4`), promise, {
        mode: 'sampled',
        outputRef: receipt.outputRef,
      });
      const runtime = new WorkerRuntime(
        { workerId: `p3-${name}`, createdAt: '2026-08-26T00:00:00.000Z' },
        { ffmpeg: true, ffprobe: true, comfy: false, mlDenoise: false, aiProviders: [] },
        { renderArtifactResolver: async ({ outputRef }) => retained.get(outputRef)! },
      );
      const inspected = await runtime.run(
        {
          id: `inspect-${name}`,
          type: 'render.inspect',
          payload: {
            projectRef: `p3-${name}`,
            compositionId: 'root',
            presetId: 'social-h264-aac',
            reportRef: `report-inspect-${name}`,
            artifactId: `artifact-${name}`,
            outputRef: receipt.outputRef,
            promise,
            mode: 'sampled',
          },
        },
        { cancelled: () => false, progress: async () => undefined },
      );
      expect(inspected.state).toBe('completed');
      if (inspected.state !== 'completed' || inspected.result.kind !== 'render.inspect')
        throw new Error('retained artifact inspection did not complete');
      expect(inspected.result.report?.findings.filter((f) => f.status === 'fail')).toEqual([]);
      expect(report.findings.filter((f) => f.status === 'fail')).toEqual([]);
      expect(report.facts.audio?.rms).toBeGreaterThan(0.001);
      expect(plan.layers.filter((l) => l.kind === 'video').map((l) => l.assetId)).toEqual([
        'clip-a',
        'clip-b',
      ]);
      expect(plan.layers.some((l) => l.kind === 'image')).toBe(true);
      expect(plan.layers.some((l) => l.kind === 'text')).toBe(true);
      const titleLayer = plan.layers.find((l) => l.kind === 'text');
      expect(titleLayer).toMatchObject({
        bitmapAssetId: 'title-bitmap',
        fontId: 'falsafeh-light',
        sourceSha256: TITLE_SOURCE_SHA,
      });
      expect(plan.captionBurnIn?.segments[0]?.text).toBe('Corrected caption');
      expect(plan.transitions?.[0]?.type).toBe('dissolve');
      expect(plan.colorGrade?.saturation).toBeGreaterThan(1);
      expect(report.findings.find((f) => f.code === 'caption-pixels')?.status).toBe('pass');
      expect(retained.get(receipt.outputRef)?.length).toBe(receipt.bytes);

      // Decode the retained artifact itself. Metadata-only layer assertions do
      // not prove that the renderer preserved either visual overlay.
      const artifactBytes = retained.get(receipt.outputRef);
      if (artifactBytes === undefined) throw new Error('retained artifact bytes are missing');
      const frame = decodeRgbFrame(artifactBytes, viewport.width, viewport.height);
      expect(
        countPixels(
          frame,
          viewport.width,
          { x: 48, y: 2, width: 12, height: 12 },
          (r, g, b) => r > 150 && g > 130 && b < 120,
        ),
      ).toBeGreaterThan(20);
      const motionTitlePixels = countPixels(
        frame,
        viewport.width,
        { x: 2, y: 2, width: 32, height: 14 },
        (r, g, b) => r > 170 && g > 170 && b > 170 && Math.max(r, g, b) - Math.min(r, g, b) < 45,
      );
      expect(motionTitlePixels).toBeGreaterThan(3);

      // Analyze isolated windows so each source dialogue tone and the added
      // music tone must survive independently (aggregate RMS is insufficient).
      const audio = decodeMonoF32(artifactBytes);
      expect(goertzelMagnitude(audio, 48_000, 440, 0.1, 0.2)).toBeGreaterThan(0.01);
      expect(goertzelMagnitude(audio, 48_000, 660, 0.4, 0.5)).toBeGreaterThan(0.01);
      expect(goertzelMagnitude(audio, 48_000, 220, 0.1, 0.2)).toBeGreaterThan(0.003);
    }
    const reopened = new EditorSession(storage, goldenTimeline(), goldenVisual());
    expect(reopened.timelineProject.compositions.root?.tracks[0]?.clips).toMatchObject([
      { id: 'intro', startUs: 0, durationUs: 300_000 },
      { id: 'product', startUs: 300_000, durationUs: 300_000 },
      { id: 'outro', startUs: 600_000, durationUs: 300_000 },
    ]);
    expect(reopened.timelineProject.compositions.root?.tracks[1]).toMatchObject({
      id: 'music-track',
      kind: 'audio',
      clips: [{ id: 'music', startUs: 0, durationUs: 600_000, assetId: 'music' }],
    });
    expect(reopened.canUndo).toBe(false);
  });
});

function goldenTimeline(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'p3-golden',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'P3',
        width: 64,
        height: 36,
        frameRate: { num: 30, den: 1 },
        durationUs: 600_000,
        tracks: [
          {
            id: 'track-0',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                id: 'intro',
                kind: 'video',
                startUs: 0,
                durationUs: 400_000,
                assetId: 'clip-a',
                sourceInUs: 0,
              },
              {
                id: 'product',
                kind: 'video',
                startUs: 400_000,
                durationUs: 300_000,
                assetId: 'clip-b',
                sourceInUs: 0,
              },
              {
                id: 'outro',
                kind: 'video',
                startUs: 700_000,
                durationUs: 300_000,
                assetId: 'clip-a',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
  };
}
function renderTimeline(project: SpikeProject): SpikeProject {
  const root = project.compositions.root!;
  const video = root.tracks.find((t) => t.kind === 'video')!;
  return {
    ...project,
    compositions: {
      ...project.compositions,
      root: {
        ...root,
        durationUs: 600_000,
        tracks: [
          { ...video, clips: video.clips.filter((clip) => clip.id !== 'outro') },
          ...root.tracks
            .filter((t) => t.kind !== 'video')
            .map((t) => ({
              ...t,
              clips: t.clips.map((c) => ({ ...c, durationUs: Math.min(c.durationUs, 600_000) })),
            })),
        ],
      },
    },
  };
}
function goldenVisual(): JoyProjectV1 {
  const base = INITIAL_EDITOR_PROJECT;
  return {
    ...base,
    id: 'p3-golden-visual',
    title: 'P3 certified editor golden',
    compositions: {
      root: {
        ...base.compositions.root!,
        width: 64,
        height: 36,
        durationUs: 600_000,
        tracks: [
          {
            id: 'caption-track',
            kind: 'caption',
            name: 'Captions',
            order: 5,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'caption',
                kind: 'caption',
                startUs: 0,
                durationUs: 600_000,
                captionDocumentId: 'caption-doc',
              },
            ],
          },
        ],
      },
    },
    assets: {
      'clip-a': { id: 'clip-a', kind: 'video', displayName: 'Source A' },
      'clip-b': { id: 'clip-b', kind: 'video', displayName: 'Source B' },
      overlay: { id: 'overlay', kind: 'image', displayName: 'B-roll overlay' },
      music: { id: 'music', kind: 'audio', displayName: 'Music' },
    },
    visualObjects: {
      overlay: {
        id: 'overlay',
        kind: 'image',
        assetId: 'overlay',
        transform: {
          x: 48,
          y: 2,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
      title: {
        id: 'title',
        kind: 'text',
        text: 'JOY MEDIA',
        bitmapAssetId: 'title-bitmap',
        fontId: 'falsafeh-light',
        sourceSha256: TITLE_SOURCE_SHA,
        transform: {
          x: 2,
          y: 2,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    },
    captionDocuments: {
      'caption-doc': {
        id: 'caption-doc',
        language: 'en',
        direction: 'ltr',
        speakers: [],
        words: { word: { id: 'word', text: 'Corrected caption', startUs: 0, endUs: 600_000 } },
        segments: [{ id: 'segment', startUs: 0, endUs: 600_000, wordIds: ['word'] }],
        styleRef: 'joy-clean',
      },
    },
    pluginData: { 'joy.captions.burnIn': true },
    colorGrade: { lift: 0.05, gamma: 1, gain: 1, saturation: 1.2 },
    transitions: [
      {
        id: 'dissolve',
        trackId: 'track-0',
        leftClipId: 'intro',
        rightClipId: 'product',
        type: 'dissolve',
        durationUs: 100_000,
      },
    ],
    audio: {
      clips: {
        intro: { gain: 0.8, pan: 0, mute: false, solo: false },
        product: { gain: 0.8, pan: 0, mute: false, solo: false },
        outro: { gain: 0.8, pan: 0, mute: false, solo: false },
        music: { gain: 0.35, pan: 0, mute: false, solo: false },
      },
      buses: [
        { id: 'master', name: 'Master', gain: 1, pan: 0, mute: false, solo: false, inputs: [] },
      ],
      effects: [],
    },
  };
}
function media(d: string, n: string, c: string, f: number) {
  const p = join(d, `${n}.mp4`);
  must([
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${c}:s=64x36:r=30`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${f}:sample_rate=48000`,
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    p,
  ]);
  return p;
}
function image(d: string) {
  const p = join(d, 'overlay.png');
  must(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=yellow:s=12x12', '-frames:v', '1', p]);
  return p;
}
function title(d: string) {
  const p = join(d, 'title-bitmap.png');
  // Deterministic test fixture for the accepted V2 contract.  This is an
  // actual decoded bitmap binding (not a text-layer fallback); the pinned
  // font identity and source digest are carried separately in textBitmap.
  const width = 32;
  const height = 14;
  const rows = Array.from({ length: height }, () => new Uint8Array(width * 4));
  const glyphs: Record<string, readonly string[]> = {
    J: ['11111', '00100', '00100', '00100', '10100', '10100', '01100'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  };
  let x = 0;
  for (const character of 'JOY MEDIA') {
    if (character === ' ') {
      x += 3;
      continue;
    }
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyphs[character]![gy]![gx] !== '1') continue;
        const pixel = rows[2 + gy]!;
        const offset = (x + gx) * 4;
        pixel[offset] = 255;
        pixel[offset + 1] = 255;
        pixel[offset + 2] = 255;
        pixel[offset + 3] = 255;
      }
    }
    x += 6;
  }
  const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), Buffer.from(row)])));
  writeFileSync(p, png(width, height, raw));
  return p;
}

function png(width: number, height: number, raw: Buffer): Buffer {
  const chunk = (type: string, payload: Buffer) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBytes, payload]);
    const crc = crc32(body);
    const out = Buffer.alloc(12 + payload.length);
    out.writeUInt32BE(payload.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc, 8 + payload.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function tone(d: string) {
  const p = join(d, 'music.wav');
  must([
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=48000:duration=1',
    '-c:a',
    'pcm_s16le',
    p,
  ]);
  return p;
}
function must(args: string[]) {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

function decodeRgbFrame(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const decoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${width}x${height}`,
      'pipe:1',
    ],
    { input: Buffer.from(bytes) },
  );
  if (decoded.status !== 0 || decoded.stdout.length !== width * height * 3)
    throw new Error('retained artifact frame could not be decoded');
  return new Uint8Array(decoded.stdout);
}
function countPixels(
  frame: Uint8Array,
  width: number,
  region: { x: number; y: number; width: number; height: number },
  predicate: (r: number, g: number, b: number) => boolean,
): number {
  let count = 0;
  for (let y = region.y; y < region.y + region.height; y++)
    for (let x = region.x; x < region.x + region.width; x++) {
      const i = (y * width + x) * 3;
      if (predicate(frame[i]!, frame[i + 1]!, frame[i + 2]!)) count++;
    }
  return count;
}
function decodeMonoF32(bytes: Uint8Array): Float32Array {
  const decoded = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { input: Buffer.from(bytes) },
  );
  if (decoded.status !== 0 || decoded.stdout.length < 48_000)
    throw new Error('retained artifact audio could not be decoded');
  return new Float32Array(
    decoded.stdout.buffer,
    decoded.stdout.byteOffset,
    Math.floor(decoded.stdout.length / 4),
  );
}
function goertzelMagnitude(
  samples: Float32Array,
  sampleRate: number,
  frequency: number,
  startSeconds: number,
  endSeconds: number,
): number {
  const start = Math.floor(startSeconds * sampleRate),
    end = Math.min(samples.length, Math.floor(endSeconds * sampleRate));
  const n = end - start,
    k = Math.round((n * frequency) / sampleRate),
    omega = (2 * Math.PI * k) / n,
    coeff = 2 * Math.cos(omega);
  let q1 = 0,
    q2 = 0;
  for (let i = start; i < end; i++) {
    const q0 = coeff * q1 - q2 + samples[i]!;
    q2 = q1;
    q1 = q0;
  }
  return Math.sqrt(q1 * q1 + q2 * q2 - coeff * q1 * q2) / n;
}
