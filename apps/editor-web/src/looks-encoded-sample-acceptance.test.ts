import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalBindingKey,
  type JoyProjectV1,
  type PropertyAnimationV2,
} from '@joy-media/project-schema';
import { BUILT_IN_LOOK_PACKS, compileLook, type LookDefinition } from '@joy-media/motion-core';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import { buildRenderFrameIRFromProject } from '@joy-media/visual-object-renderer';
import type { RenderFrameIR } from '@joy-media/render-ir';
import { bakeLookFromAudio, type DecodedCompositionAudio } from './living-look-audio.js';

/**
 * R2 GAP 4 / GAP 2 — encoded sample media acceptance.
 *
 * `looks-render-acceptance.test.ts` proves the compiled Look renders identically
 * through the preview and export adapters (both are deterministic reference
 * renderers over the same IR). This test goes one step further along the pipeline
 * that the owner review asked for: it takes the compiled Look, evaluates every
 * frame through the single project->frame boundary the Monitor and export share
 * (`buildRenderFrameIRFromProject`), rasterizes it with the deterministic
 * headless adapter, and **encodes an actual H.264 MP4 with ffmpeg** — with a
 * muxed AAC track for the audio-reactive pack. It then **decodes the encoded
 * bytes back** with ffprobe/ffmpeg and checks the container, dimensions,
 * duration, constant-frame-rate progression, frame-to-frame change, audio
 * presence, and audio/video synchronisation against the deterministic beat
 * fixture — all with explicit tolerances.
 *
 * What this does NOT establish: final glyph shaping, real fonts, template
 * styling or art-direction quality. The headless/preview adapters are schematic
 * reference renderers (a 4x5 bitmap alphabet, flat colour rects). Final-quality
 * pixels come only from the browser export pipeline; the per-pack taste read
 * stays owner-gated. See `joy-live-director-r2-look-sample-gallery-2026-09-09.md`.
 */

const FPS = 15;
const DURATION_S = 2;
const FRAME_COUNT = FPS * DURATION_S; // 30 CFR frames
const DURATION_US = DURATION_S * 1_000_000;
const FRAME_PERIOD_US = Math.round(DURATION_US / FRAME_COUNT);

const PORTRAIT = { width: 540, height: 960 } as const; // half of a 1080x1920 reels master
const LANDSCAPE = { width: 960, height: 540 } as const; // half of a 1920x1080 master

/** Deterministic beat grid for the audio-reactive pack (seconds). */
const BEATS_S = [0.3, 0.7, 1.1, 1.5, 1.9] as const;
const SAMPLE_RATE = 48_000;

const OUT_ROOT = join(process.cwd(), 'test-output', 'r2-look-encoded');
const WORK_DIR = join(tmpdir(), `joy-look-encoded-${process.pid}`);

interface DecodeReport {
  readonly pack: string;
  readonly format: 'portrait' | 'landscape';
  readonly file: string;
  readonly bytes: number;
  readonly container: string;
  readonly videoCodec: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly videoFrameCount: number;
  readonly distinctFrameHashes: number;
  readonly firstEqualsLast: boolean;
  readonly maxCfrJitterUs: number;
  readonly hasAudio: boolean;
  readonly audioCodec: string | null;
  readonly audioSampleRate: number | null;
  readonly audioStartSeconds: number | null;
  readonly audioMeanVolumeDb: number | null;
  readonly primaryMotionRange: number;
  readonly motionArgmaxSeconds: number | null;
  readonly nearestBeatDeltaSeconds: number | null;
  readonly betweenBeatDip: number | null;
  readonly minContentPixels: number;
  readonly maxContentPixels: number;
  readonly anchorsInsideViewport: boolean;
}

const reports: DecodeReport[] = [];

afterAll(() => {
  mkdirSync(OUT_ROOT, { recursive: true });
  writeFileSync(
    join(OUT_ROOT, 'report.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), fps: FPS, durationS: DURATION_S, reports }, null, 2)}\n`,
  );
  rmSync(WORK_DIR, { recursive: true, force: true });
});

function textObject(id: string, text: string, x: number, y: number) {
  return {
    id,
    kind: 'text' as const,
    text,
    transform: {
      x,
      y,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  };
}

function baseProject(width: number, height: number): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'look-encoded-sample',
    title: 'Look encoded sample',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Main',
        width,
        height,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: FPS, den: 1 },
        durationUs: DURATION_US,
        background: '#05060cff',
        tracks: [],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {
      // A large static backdrop so the encoded sample shows a real surface and a
      // blank render is unmistakable; the Look never binds it.
      bg: {
        id: 'bg',
        kind: 'shape' as const,
        shape: 'rectangle' as const,
        transform: {
          x: Math.round(width * 0.1),
          y: Math.round(height * 0.16),
          scaleX: (width * 0.8) / 100,
          scaleY: (height * 0.68) / 100,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
      // A 100x100 card bound to slot 0. Its natural scale is 1.0, so the packs
      // that drive scaleX to an absolute ~1.0-1.12 (music-pulse) or 0.55-1.0
      // (kinetic-type) move it visibly, as do the opacity/position packs.
      card: {
        id: 'card',
        kind: 'shape' as const,
        shape: 'ellipse' as const,
        transform: {
          x: Math.round(width / 2 - 50),
          y: Math.round(height * 0.4),
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
      headline: textObject(
        'headline',
        'JOY LIVE',
        Math.round(width / 2),
        Math.round(height * 0.42),
      ),
      deck: textObject('deck', 'the sequel', Math.round(width / 2), Math.round(height * 0.42) + 90),
    },
    captionDocuments: {},
    pluginData: {},
  } as JoyProjectV1;
}

/** A mono 48 kHz Float32 track with a decaying 90 Hz tone on each beat. */
function synthesizeBeatAudio(): DecodedCompositionAudio {
  const total = SAMPLE_RATE * DURATION_S;
  const channel = new Float32Array(total);
  const decay = Math.round(0.4 * SAMPLE_RATE);
  for (const beat of BEATS_S) {
    const start = Math.round(beat * SAMPLE_RATE);
    for (let i = 0; i < decay; i += 1) {
      const index = start + i;
      if (index >= total) break;
      const env = Math.exp((-4 * i) / decay);
      channel[index] =
        (channel[index] ?? 0) + Math.sin((2 * Math.PI * 90 * i) / SAMPLE_RATE) * env * 0.9;
    }
  }
  return { sampleRate: SAMPLE_RATE, channels: [channel], sourceOffsetUs: 0 };
}

function writeWav(audio: DecodedCompositionAudio, path: string): void {
  const pcm = audio.channels[0]!;
  const bytes = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]!));
    bytes.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(audio.sampleRate, 24);
  header.writeUInt32LE(audio.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes.length, 40);
  writeFileSync(path, Buffer.concat([header, bytes]));
}

interface CompiledLook {
  readonly project: JoyProjectV1;
  readonly animations: Record<string, PropertyAnimationV2>;
}

function applyLook(
  project: JoyProjectV1,
  definition: LookDefinition,
  format: 'portrait' | 'landscape',
): CompiledLook {
  const visualSlots = definition.slots.filter((slot) => slot.ownerKind === 'visual-object');
  // Slot 0 drives the large backdrop card so the motion is unmistakable in the
  // schematic reference raster and in the encoded frames; later slots drive the
  // (deliberately tiny bitmap) text objects.
  const targets = ['card', 'headline', 'deck'];
  const entityBindings = Object.fromEntries(
    visualSlots.map((slot, index) => [slot.id, targets[index] ?? 'deck']),
  );
  const controlValues = Object.fromEntries(
    definition.controls.map((control) => [control.id, control.default]),
  );

  let audioBakes: ReturnType<typeof bakeLookFromAudio>['audioBakes'] = [];
  if (definition.id === 'music-pulse') {
    const baked = bakeLookFromAudio({
      definition,
      controlValues,
      audio: synthesizeBeatAudio(),
      clip: {
        compositionStartUs: 0,
        compositionDurationUs: DURATION_US,
        sourceAnchorUs: 0,
        sourcePerComposition: { numerator: 1, denominator: 1 },
      },
      channel: 'peak',
    });
    expect(baked.silent, 'music-pulse beat fixture is not silent').toBe(false);
    expect(baked.confidence, 'music-pulse beat grid is confident').toBeGreaterThan(0.3);
    audioBakes = baked.audioBakes;
  }

  const compiled = compileLook({
    definition,
    definitionVersion: definition.version,
    compositionId: 'root',
    compositionDurationUs: DURATION_US,
    format,
    entityBindings,
    controlValues,
    overriddenBindingIds: [],
    resolvedFonts: Object.fromEntries(definition.requiredFonts.map((font) => [font, font])),
    ...(audioBakes.length > 0 ? { audioBakes } : {}),
  });
  expect(compiled.ok, `${definition.id} (${format}) compiles`).toBe(true);

  type Keyframe = { timeUs: number; value: number; interpolation: 'hold' | 'linear' | 'eased' };
  const grouped = new Map<
    string,
    { binding: PropertyAnimationV2['binding']; kind: 'scalar' | 'angle'; keyframes: Keyframe[] }
  >();
  for (const op of compiled.operations) {
    if (op.kind !== 'motion.setKeyframe') continue;
    const binding = {
      ownerKind: op.ownerKind,
      ownerId: op.ownerId,
      propertyId: op.propertyId,
      timeDomain: op.timeDomain,
    } as const;
    const key = canonicalBindingKey(binding);
    const entry = grouped.get(key) ?? {
      binding,
      kind: op.propertyId === 'rotationDeg' ? ('angle' as const) : ('scalar' as const),
      keyframes: [] as Keyframe[],
    };
    entry.keyframes.push({ timeUs: op.timeUs, value: op.value, interpolation: op.interpolation });
    grouped.set(key, entry);
  }

  const animations: Record<string, PropertyAnimationV2> = {};
  for (const [key, entry] of grouped) {
    animations[key] = {
      binding: entry.binding,
      value: {
        kind: entry.kind,
        curve: { keyframes: [...entry.keyframes].sort((a, b) => a.timeUs - b.timeUs) },
      },
    } as PropertyAnimationV2;
  }
  return { project: { ...project, propertyAnimations: animations }, animations };
}

/** Count non-background pixels (deliberately schematic: the reference render). */
function contentPixels(frame: RenderFrameIR, pixels: Uint8Array): number {
  const bg = frame.background;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (
      Math.abs(pixels[i]! - bg.r) > 6 ||
      Math.abs(pixels[i + 1]! - bg.g) > 6 ||
      Math.abs(pixels[i + 2]! - bg.b) > 6
    ) {
      count += 1;
    }
  }
  return count;
}

function distinctQuantisedColours(pixels: Uint8Array): number {
  const seen = new Set<number>();
  for (let i = 0; i < pixels.length; i += 4) {
    seen.add(((pixels[i]! >> 4) << 8) | ((pixels[i + 1]! >> 4) << 4) | (pixels[i + 2]! >> 4));
    if (seen.size > 8) break;
  }
  return seen.size;
}

function ffprobeJson(path: string): {
  streams: readonly Record<string, unknown>[];
  format: Record<string, unknown>;
} {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], {
      encoding: 'utf8',
    }),
  ) as { streams: readonly Record<string, unknown>[]; format: Record<string, unknown> };
}

function frameMd5(path: string): { readonly ptsUs: number[]; readonly hashes: string[] } {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-map', '0:v:0', '-an', '-f', 'framemd5', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 24 },
  );
  const ptsUs: number[] = [];
  const hashes: string[] = [];
  let tbNum = 1;
  let tbDen = FPS;
  for (const line of raw.split(/\r?\n/)) {
    const tb = /^#tb 0:\s*(\d+)\/(\d+)/.exec(line.trim());
    if (tb !== null) {
      tbNum = Number(tb[1]);
      tbDen = Number(tb[2]);
      continue;
    }
    const match = /^0,\s*(\d+),\s*-?\d+,\s*\d+,\s*\d+,\s*([0-9a-f]{32})/.exec(line.trim());
    if (match === null) continue;
    ptsUs.push(Math.round((Number(match[1]) * tbNum * 1_000_000) / tbDen));
    hashes.push(match[2]!);
  }
  return { ptsUs, hashes };
}

function meanVolumeDb(path: string): number | null {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'info', '-i', path, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 22 },
  );
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(text);
  return match === null ? null : Number(match[1]);
}

describe('R2 Look packs — encoded sample media, decoded and verified (GAP 4 / GAP 2)', () => {
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(OUT_ROOT, { recursive: true });

  for (const definition of BUILT_IN_LOOK_PACKS) {
    for (const [format, dims] of [
      ['portrait', PORTRAIT],
      ['landscape', LANDSCAPE],
    ] as const) {
      it(`${definition.id} (${format}): encodes an MP4 whose decoded bytes carry the Look`, () => {
        const { project, animations } = applyLook(
          baseProject(dims.width, dims.height),
          definition,
          format,
        );
        expect(
          Object.keys(animations).length,
          'the Look drives at least one binding',
        ).toBeGreaterThan(0);

        // ---- render every CFR frame through the shared project->frame boundary
        const frames: RenderFrameIR[] = [];
        const rasters: Uint8Array[] = [];
        for (let n = 0; n < FRAME_COUNT; n += 1) {
          const timeUs = Math.min(DURATION_US - 1, n * FRAME_PERIOD_US);
          const frame = buildRenderFrameIRFromProject(
            project,
            'root',
            timeUs,
            dims.width,
            dims.height,
          );
          const raster = renderHeadlessFrame(frame).pixels;
          expect(raster.length).toBe(dims.width * dims.height * 4);
          frames.push(frame);
          rasters.push(raster);
        }

        // ---- independent pixel expectations (absolute, not path-equality)
        const contentByFrame = frames.map((frame, i) => contentPixels(frame, rasters[i]!));
        const minContentPixels = Math.min(...contentByFrame);
        const maxContentPixels = Math.max(...contentByFrame);
        // Some frame must not be blank: real content pixels + more than one colour band.
        const richestFrame = contentByFrame.indexOf(maxContentPixels);
        // The backdrop card alone is ~30% of the frame; a blank render is zero.
        expect(maxContentPixels, `${definition.id} (${format}) is never blank`).toBeGreaterThan(
          dims.width * dims.height * 0.1,
        );
        expect(
          distinctQuantisedColours(rasters[richestFrame]!),
          `${definition.id} (${format}) richest frame has >1 colour band`,
        ).toBeGreaterThan(1);
        // Motion: the frame content is not static across the composition.
        const firstRaster = rasters[0]!;
        const anyFrameDiffers = rasters.some(
          (raster) =>
            raster.length !== firstRaster.length || !raster.every((v, i) => v === firstRaster[i]),
        );
        expect(anyFrameDiffers, `${definition.id} (${format}) frames change over time`).toBe(true);

        // Clipping check: the backdrop card's transformed AABB keeps most of its
        // area inside the viewport on every frame, and every text anchor stays
        // on-screen. A Look that flung a bound object off-frame fails here.
        let anchorsInsideViewport = true;
        for (const frame of frames) {
          for (const node of frame.nodes) {
            if (node.id === 'card') {
              const x0 = node.transform.translateX;
              const y0 = node.transform.translateY;
              const x1 = x0 + 100 * node.transform.scaleX;
              const y1 = y0 + 100 * node.transform.scaleY;
              const overlap =
                Math.max(0, Math.min(x1, dims.width) - Math.max(x0, 0)) *
                Math.max(0, Math.min(y1, dims.height) - Math.max(y0, 0));
              const area = Math.max(1, (x1 - x0) * (y1 - y0));
              if (overlap / area < 0.6) anchorsInsideViewport = false;
            } else if (
              node.transform.translateX < -2 ||
              node.transform.translateX > dims.width + 2 ||
              node.transform.translateY < -2 ||
              node.transform.translateY > dims.height + 2
            ) {
              anchorsInsideViewport = false;
            }
          }
        }
        expect(
          anchorsInsideViewport,
          `${definition.id} (${format}) keeps bound objects within the frame`,
        ).toBe(true);

        // Primary animated motion at selected timestamps: the slot-0 object
        // (the card) must actually move — opacity, scale or position.
        const cardSamples = frames.map((frame) => {
          const node = frame.nodes.find((candidate) => candidate.id === 'card');
          return {
            opacity: node?.opacity ?? 0,
            scaleX: node?.transform.scaleX ?? 0,
            translateY: node?.transform.translateY ?? 0,
          };
        });
        const rangeOf = (values: readonly number[]): number =>
          Math.max(...values) - Math.min(...values);
        const opacityRange = rangeOf(cardSamples.map((s) => s.opacity));
        const scaleRange = rangeOf(cardSamples.map((s) => s.scaleX));
        const translateRange = rangeOf(cardSamples.map((s) => s.translateY));
        const primaryMotionRange = Math.max(opacityRange, scaleRange, translateRange / dims.height);
        expect(
          primaryMotionRange,
          `${definition.id} (${format}) shows real slot-0 motion`,
          // The real audio baker smooths the measured envelope; retain a
          // meaningful non-zero motion floor below the 1.12x source ceiling.
        ).toBeGreaterThan(0.015);

        // ---- encode an actual MP4 from the rasters (+ AAC for music-pulse)
        const stem = `${definition.id}-${format}`;
        const rawPath = join(WORK_DIR, `${stem}.rgba`);
        writeFileSync(rawPath, Buffer.concat(rasters.map((raster) => Buffer.from(raster))));
        const isAudio = definition.id === 'music-pulse';
        const wavPath = join(WORK_DIR, `${stem}.wav`);
        if (isAudio) writeWav(synthesizeBeatAudio(), wavPath);
        const mp4Path = join(OUT_ROOT, `${stem}.mp4`);
        execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-fflags',
            '+bitexact',
            '-f',
            'rawvideo',
            '-pixel_format',
            'rgba',
            '-video_size',
            `${dims.width}x${dims.height}`,
            '-framerate',
            String(FPS),
            '-i',
            rawPath,
            ...(isAudio ? ['-i', wavPath] : []),
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-pix_fmt',
            'yuv420p',
            '-bf',
            '0',
            '-g',
            String(FPS),
            '-r',
            String(FPS),
            '-fps_mode',
            'cfr',
            '-flags:v',
            '+bitexact',
            ...(isAudio
              ? ['-c:a', 'aac', '-b:a', '128k', '-ar', String(SAMPLE_RATE), '-shortest']
              : []),
            '-movflags',
            '+faststart',
            mp4Path,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );

        // ---- decode the encoded bytes back and verify
        const probe = ffprobeJson(mp4Path);
        const video = probe.streams.find((stream) => stream.codec_type === 'video');
        const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
        if (video === undefined) throw new Error('encoded MP4 has no video stream');

        expect(String(probe.format.format_name)).toContain('mp4');
        expect(video.codec_name, 'H.264 video').toBe('h264');
        expect(Number(video.width), 'decoded width matches the encode').toBe(dims.width);
        expect(Number(video.height), 'decoded height matches the encode').toBe(dims.height);

        const durationSeconds = Number(probe.format.duration);
        expect(
          Math.abs(durationSeconds - DURATION_S),
          `${stem} duration within one frame of ${DURATION_S}s`,
        ).toBeLessThanOrEqual(1 / FPS + 0.02);

        const { ptsUs, hashes } = frameMd5(mp4Path);
        expect(hashes.length, `${stem} decodes ${FRAME_COUNT} video frames`).toBe(FRAME_COUNT);
        // Strictly increasing, near-constant cadence.
        let maxCfrJitterUs = 0;
        for (let i = 1; i < ptsUs.length; i += 1) {
          const delta = ptsUs[i]! - ptsUs[i - 1]!;
          expect(delta, `${stem} PTS strictly increases at frame ${i}`).toBeGreaterThan(0);
          maxCfrJitterUs = Math.max(maxCfrJitterUs, Math.abs(delta - FRAME_PERIOD_US));
        }
        expect(maxCfrJitterUs, `${stem} holds a constant frame rate`).toBeLessThanOrEqual(2_000);
        const distinctFrameHashes = new Set(hashes).size;
        expect(
          distinctFrameHashes,
          `${stem} frame progression shows change (not a freeze-frame)`,
        ).toBeGreaterThanOrEqual(4);
        const firstEqualsLast = hashes[0] === hashes[hashes.length - 1];

        // ---- audio presence + A/V synchronisation (music-pulse only)
        let audioStartSeconds: number | null = null;
        let audioMeanVolumeDb: number | null = null;
        let motionArgmaxSeconds: number | null = null;
        let nearestBeatDeltaSeconds: number | null = null;
        let betweenBeatDip: number | null = null;

        if (isAudio) {
          if (audio === undefined) throw new Error('music-pulse export has no audio stream');
          expect(audio.codec_name, 'AAC audio').toBe('aac');
          expect(Number(audio.sample_rate), 'audio sample rate preserved').toBe(SAMPLE_RATE);
          audioStartSeconds = Number(audio.start_time ?? probe.format.start_time ?? 0);
          expect(Math.abs(audioStartSeconds), 'audio starts at the head of the clip').toBeLessThan(
            0.05,
          );
          const audioDuration = Number(audio.duration ?? probe.format.duration);
          expect(
            Math.abs(audioDuration - durationSeconds),
            'audio and video run the same length',
          ).toBeLessThan(0.12);
          audioMeanVolumeDb = meanVolumeDb(mp4Path);
          expect(audioMeanVolumeDb, 'audio track carries real signal').not.toBeNull();
          expect(audioMeanVolumeDb!, 'audio is not digital silence').toBeGreaterThan(-55);

          // The subject scale is baked from the beat envelope. Its peak frame
          // must land near a beat, and a between-beats frame must sit lower.
          const scaleByFrame = frames.map(
            (frame) => frame.nodes.find((node) => node.id === 'card')?.transform.scaleX ?? 1,
          );
          const argmax = scaleByFrame.indexOf(Math.max(...scaleByFrame));
          motionArgmaxSeconds = argmax / FPS;
          nearestBeatDeltaSeconds = Math.min(
            ...BEATS_S.map((beat) => Math.abs(beat - motionArgmaxSeconds!)),
          );
          const beatInterval = BEATS_S[1]! - BEATS_S[0]!;
          expect(
            nearestBeatDeltaSeconds,
            'the scale peak is synchronised to a beat',
          ).toBeLessThanOrEqual(beatInterval / 2 + 1 / FPS);
          // A frame half-way between the first two beats.
          const betweenIndex = Math.round(((BEATS_S[0]! + BEATS_S[1]!) / 2) * FPS);
          betweenBeatDip = Math.max(...scaleByFrame) - scaleByFrame[betweenIndex]!;
          expect(betweenBeatDip, 'the pulse relaxes between beats').toBeGreaterThan(0.004);
          expect(
            Math.max(...scaleByFrame),
            'the pulse stays under the 1.12x ceiling',
          ).toBeLessThanOrEqual(1.12 + 1e-6);
        } else {
          expect(audio, `${stem} is a video-only sample`).toBeUndefined();
        }

        // ---- gallery frames (first / mid / settle) for the sample doc
        execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            mp4Path,
            '-vf',
            `select='eq(n,0)+eq(n,${Math.floor(FRAME_COUNT / 2)})+eq(n,${FRAME_COUNT - 1})'`,
            '-fps_mode',
            'passthrough',
            join(OUT_ROOT, `${stem}-%02d.png`),
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );

        reports.push({
          pack: definition.id,
          format,
          file: `${stem}.mp4`,
          bytes: readFileSync(mp4Path).byteLength,
          container: String(probe.format.format_name),
          videoCodec: String(video.codec_name),
          width: Number(video.width),
          height: Number(video.height),
          durationSeconds,
          videoFrameCount: hashes.length,
          distinctFrameHashes,
          firstEqualsLast,
          maxCfrJitterUs,
          hasAudio: isAudio,
          audioCodec: audio === undefined ? null : String(audio.codec_name),
          audioSampleRate: audio === undefined ? null : Number(audio.sample_rate),
          audioStartSeconds,
          audioMeanVolumeDb,
          primaryMotionRange,
          motionArgmaxSeconds,
          nearestBeatDeltaSeconds,
          betweenBeatDip,
          minContentPixels,
          maxContentPixels,
          anchorsInsideViewport,
        });
      }, 60_000);
    }
  }
});
