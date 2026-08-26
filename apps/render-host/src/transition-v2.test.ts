import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRenderBundleV2,
  planDigestV2,
  transitionDigestV2,
  type CompositionPlanV2,
} from '@joy-media/render-planner';
import { renderBundleToFile, type RenderHostMediaResolver } from './index.js';

const SECOND = 1_000_000;

function runFfmpeg(args: readonly string[]): void {
  const result = spawnSync('ffmpeg', args, { shell: false, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function fileDigest(path: string): { readonly sha256: string; readonly bytes: number } {
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

describe('V2 dissolve transition delivery', () => {
  it.each([0.5, 2])(
    'renders source-backed V2 at %sx with exact output duration and audio',
    async (rate) => {
      const directory = mkdtempSync(join(tmpdir(), `joy-media-rate-${rate}-`));
      const sourcePath = join(directory, 'source.mp4');
      const outputPath = join(directory, 'output.mp4');
      runFfmpeg([
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=green:s=64x36:r=30:d=4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=4',
        '-t',
        '4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        sourcePath,
      ]);
      const digest = fileDigest(sourcePath);
      const unsigned: Omit<CompositionPlanV2, 'planSha256'> = {
        version: 2,
        composition: { id: 'root', width: 64, height: 36 },
        viewport: { width: 64, height: 36 },
        frameRate: { num: 30, den: 1 },
        durationUs: 2 * SECOND,
        background: '#000',
        layers: [
          {
            id: 'clip',
            kind: 'video',
            assetId: 'source',
            startUs: 0,
            durationUs: 2 * SECOND,
            sourceInUs: 0,
            playbackRate: rate,
            zIndex: 0,
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
          },
        ],
        audio: [
          {
            id: 'audio:clip',
            sourceKind: 'video-native',
            assetId: 'source',
            startUs: 0,
            durationUs: 2 * SECOND,
            sourceInUs: 0,
            gain: 1,
            pan: 0,
            mute: false,
          },
        ],
        outputPreset: 'preview',
      };
      const plan = { ...unsigned, planSha256: planDigestV2(unsigned) };
      const bundle = createRenderBundleV2({
        plan,
        projectRef: 'rate-fixture',
        assets: {
          source: {
            assetId: 'source',
            opaqueRef: 'asset:source',
            integrity: { ...digest, mime: 'video/mp4' },
          },
        },
      });
      const resolver: RenderHostMediaResolver = {
        require: () => ({ kind: 'file', path: sourcePath }),
        describe: (opaqueRef) => ({ opaqueRef }),
      };
      await renderBundleToFile({ protocolVersion: 1, bundle, outputPath, mediaResolver: resolver });
      const probe = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_type,nb_read_frames',
          '-count_frames',
          '-of',
          'json',
          outputPath,
        ],
        { shell: false, encoding: 'utf8' },
      );
      expect(probe.status).toBe(0);
      const parsed = JSON.parse(probe.stdout) as {
        format: { duration: string };
        streams: Array<{ codec_type: string; nb_read_frames?: string }>;
      };
      expect(Number(parsed.format.duration)).toBeCloseTo(2, 1);
      expect(
        Number(parsed.streams.find((stream) => stream.codec_type === 'video')?.nb_read_frames),
      ).toBe(60);
      expect(parsed.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
    },
  );

  it('renders a bounded two-clip xfade and native audio crossover', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-dissolve-v2-'));
    const leftPath = join(directory, 'left.mp4');
    const rightPath = join(directory, 'right.mp4');
    const outputPath = join(directory, 'output.mp4');
    try {
      for (const [path, color, frequency, duration] of [
        [leftPath, 'red', '440', '1'],
        [rightPath, 'blue', '880', '1.4'],
      ] as const) {
        runFfmpeg([
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=c=${color}:s=64x36:r=30:d=${duration}`,
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`,
          '-t',
          duration,
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          path,
        ]);
      }
      const left = fileDigest(leftPath);
      const right = fileDigest(rightPath);
      const unsigned: Omit<CompositionPlanV2, 'planSha256'> = {
        version: 2,
        composition: { id: 'root', width: 64, height: 36 },
        viewport: { width: 64, height: 36 },
        frameRate: { num: 30, den: 1 },
        durationUs: 2 * SECOND,
        background: '#000000',
        layers: [
          {
            id: 'left-clip',
            kind: 'video',
            trackId: 'V1',
            assetId: 'left',
            startUs: 0,
            durationUs: SECOND,
            sourceInUs: 0,
            playbackRate: 1,
            zIndex: 0,
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
          },
          {
            id: 'right-clip',
            kind: 'video',
            trackId: 'V1',
            assetId: 'right',
            startUs: SECOND,
            durationUs: SECOND,
            sourceInUs: 0,
            playbackRate: 1,
            zIndex: 0,
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
          },
        ],
        transitions: [],
        audio: [
          {
            id: 'audio:left-clip',
            sourceKind: 'video-native',
            assetId: 'left',
            startUs: 0,
            durationUs: SECOND,
            sourceInUs: 0,
            gain: 1,
            pan: 0,
            mute: false,
          },
          {
            id: 'audio:right-clip',
            sourceKind: 'video-native',
            assetId: 'right',
            startUs: SECOND,
            durationUs: SECOND,
            sourceInUs: 0,
            gain: 1,
            pan: 0,
            mute: false,
          },
        ],
        outputPreset: 'preview',
      };
      const transitionBase = {
        id: 'fade-1',
        trackId: 'V1',
        leftClipId: 'left-clip',
        rightClipId: 'right-clip',
        type: 'dissolve' as const,
        durationUs: 400_000,
        startUs: 600_000,
        endUs: SECOND,
      };
      const transition = {
        ...transitionBase,
        transitionSha256: transitionDigestV2(transitionBase),
      };
      const plan = {
        ...unsigned,
        transitions: [transition],
        planSha256: planDigestV2({ ...unsigned, transitions: [transition] }),
      };
      const bundle = createRenderBundleV2({
        plan,
        projectRef: 'dissolve-fixture',
        assets: {
          left: {
            assetId: 'left',
            opaqueRef: 'asset:left',
            integrity: { ...left, mime: 'video/mp4' },
          },
          right: {
            assetId: 'right',
            opaqueRef: 'asset:right',
            integrity: { ...right, mime: 'video/mp4' },
          },
        },
      });
      const resolver: RenderHostMediaResolver = {
        require(ref) {
          return { kind: 'file', path: ref === 'asset:left' ? leftPath : rightPath };
        },
        describe(opaqueRef) {
          return { opaqueRef };
        },
      };
      await renderBundleToFile({ protocolVersion: 1, bundle, outputPath, mediaResolver: resolver });
      const probe = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=nb_read_frames',
          '-count_frames',
          '-of',
          'json',
          outputPath,
        ],
        { shell: false, encoding: 'utf8' },
      );
      expect(probe.status).toBe(0);
      const probeJson = JSON.parse(probe.stdout) as {
        readonly format?: { readonly duration?: string };
        readonly streams?: readonly { readonly nb_read_frames?: string }[];
      };
      expect(Number(probeJson.format?.duration)).toBeCloseTo(2, 2);
      expect(Number(probeJson.streams?.[0]?.nb_read_frames)).toBe(60);

      const frames = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          outputPath,
          '-vf',
          'select=eq(n\\,18)+eq(n\\,24)+eq(n\\,30)+eq(n\\,59)',
          '-vsync',
          '0',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          'pipe:1',
        ],
        { shell: false },
      );
      expect(frames.status, frames.error?.message ?? String(frames.stderr)).toBe(0);
      const frameBytes = frames.stdout as Buffer;
      const frameSize = 64 * 36 * 3;
      expect(frameBytes.length).toBe(frameSize * 4);
      const average = (offset: number, channel: number) => {
        let sum = 0;
        for (let index = offset + channel; index < offset + frameSize; index += 3)
          sum += frameBytes[index]!;
        return sum / (64 * 36);
      };
      const beforeRed = average(0, 0);
      const beforeBlue = average(0, 2);
      const middleRed = average(frameSize, 0);
      const middleBlue = average(frameSize, 2);
      const afterRed = average(frameSize * 2, 0);
      const afterBlue = average(frameSize * 2, 2);
      const tailRed = average(frameSize * 3, 0);
      const tailBlue = average(frameSize * 3, 2);
      expect(beforeRed).toBeGreaterThan(beforeBlue * 2);
      expect(afterBlue).toBeGreaterThan(afterRed * 2);
      expect(middleRed).toBeGreaterThan(afterRed);
      expect(middleBlue).toBeGreaterThan(beforeBlue);
      expect(tailBlue).toBeGreaterThan(tailRed * 2);

      const pcm = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-i', outputPath, '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'],
        { shell: false },
      );
      expect(pcm.status).toBe(0);
      const audio = pcm.stdout as Buffer;
      const frequencyEnergy = (start: number, end: number, frequency: number) => {
        let real = 0;
        let imaginary = 0;
        for (let index = start; index < end; index++) {
          const sample = audio.readFloatLE(index * 4);
          const angle = (2 * Math.PI * frequency * index) / 48_000;
          real += sample * Math.cos(angle);
          imaginary += sample * Math.sin(angle);
        }
        return Math.hypot(real, imaginary);
      };
      expect(frequencyEnergy(48_000 * 0.7, 48_000 * 0.8, 440)).toBeGreaterThan(1);
      expect(frequencyEnergy(48_000 * 1.2, 48_000 * 1.3, 880)).toBeGreaterThan(1);
      expect(frequencyEnergy(48_000 * 0.9, 48_000 * 1.1, 440)).toBeGreaterThan(1);
      expect(frequencyEnergy(48_000 * 0.9, 48_000 * 1.1, 880)).toBeGreaterThan(1);
      expect(frequencyEnergy(48_000 * 1.8, 48_000 * 1.9, 880)).toBeGreaterThan(1);

      const shortRightPath = join(directory, 'right-without-handle.mp4');
      runFfmpeg([
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=64x36:r=30:d=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:sample_rate=48000:duration=1',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        shortRightPath,
      ]);
      const shortRight = fileDigest(shortRightPath);
      const shortBundle = createRenderBundleV2({
        plan,
        projectRef: 'dissolve-fixture',
        assets: {
          left: {
            assetId: 'left',
            opaqueRef: 'asset:left',
            integrity: { ...left, mime: 'video/mp4' },
          },
          right: {
            assetId: 'right',
            opaqueRef: 'asset:right',
            integrity: { ...shortRight, mime: 'video/mp4' },
          },
        },
      });
      await expect(
        renderBundleToFile({
          protocolVersion: 1,
          bundle: shortBundle,
          outputPath: join(directory, 'short-output.mp4'),
          mediaResolver: {
            require(ref) {
              return { kind: 'file', path: ref === 'asset:left' ? leftPath : shortRightPath };
            },
            describe(opaqueRef) {
              return { opaqueRef };
            },
          },
        }),
      ).rejects.toMatchObject({
        name: 'RenderHostTransitionError',
        code: 'INVALID_DISSOLVE_JUNCTION',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
