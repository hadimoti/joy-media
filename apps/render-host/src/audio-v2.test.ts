import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createRenderBundleV2,
  planDigestV2,
  type CompositionPlanV2,
} from '@joy-media/render-planner';
import { renderBundleToFile, type RenderHostMediaResolver } from './index.js';

function ffmpeg(args: readonly string[]): void {
  const result = spawnSync('ffmpeg', args, { shell: false, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function digest(path: string): { readonly sha256: string; readonly bytes: number } {
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

describe('V2 audio parity delivery', () => {
  it('preserves black/silent leading, middle, and trailing gaps and aligns native audio', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-audio-gaps-v2-'));
    const firstPath = join(directory, 'first.mp4');
    const secondPath = join(directory, 'second.mp4');
    const outputPath = join(directory, 'output.mp4');
    try {
      for (const [path, color, frequency] of [
        [firstPath, 'red', '440'],
        [secondPath, 'blue', '880'],
      ] as const)
        ffmpeg([
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=c=${color}:s=16x16:d=0.25:r=30`,
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${frequency}:duration=0.25:sample_rate=48000`,
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          path,
        ]);
      const first = digest(firstPath);
      const second = digest(secondPath);
      const unsigned: Omit<CompositionPlanV2, 'planSha256'> = {
        version: 2,
        composition: { id: 'root', width: 16, height: 16 },
        viewport: { width: 16, height: 16 },
        frameRate: { num: 30, den: 1 },
        durationUs: 1_000_000,
        background: '#000',
        layers: [
          {
            id: 'first',
            kind: 'video',
            assetId: 'first',
            startUs: 250_000,
            durationUs: 250_000,
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
            id: 'second',
            kind: 'video',
            assetId: 'second',
            startUs: 625_000,
            durationUs: 250_000,
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
        audio: [
          {
            id: 'audio:first',
            sourceKind: 'video-native',
            assetId: 'first',
            startUs: 250_000,
            durationUs: 250_000,
            sourceInUs: 0,
            gain: 1,
            pan: 0,
            mute: false,
          },
          {
            id: 'audio:second',
            sourceKind: 'video-native',
            assetId: 'second',
            startUs: 625_000,
            durationUs: 250_000,
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
        projectRef: 'gapped-audio',
        assets: {
          first: {
            assetId: 'first',
            opaqueRef: 'asset:first',
            integrity: { ...first, mime: 'video/mp4' },
          },
          second: {
            assetId: 'second',
            opaqueRef: 'asset:second',
            integrity: { ...second, mime: 'video/mp4' },
          },
        },
      });
      const resolver: RenderHostMediaResolver = {
        require: (ref) => ({ kind: 'file', path: ref === 'asset:first' ? firstPath : secondPath }),
        describe: (opaqueRef) => ({ opaqueRef }),
      };
      await renderBundleToFile({ protocolVersion: 1, bundle, outputPath, mediaResolver: resolver });
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outputPath],
        { shell: false, encoding: 'utf8' },
      );
      expect(Number(probe.stdout.trim())).toBeCloseTo(1, 1);
      const video = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          outputPath,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-s',
          '16x16',
          '-r',
          '30',
          'pipe:1',
        ],
        { shell: false },
      ).stdout as Buffer;
      const pixel = (frame: number) => [
        ...video.subarray(frame * 16 * 16 * 3, frame * 16 * 16 * 3 + 3),
      ];
      expect(pixel(3)[0]).toBeLessThan(8); // leading black
      expect(pixel(16)[0]).toBeLessThan(8); // middle black
      expect(pixel(27)[0]).toBeLessThan(8); // trailing black
      const pcm = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-i', outputPath, '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'],
        { shell: false },
      ).stdout as Buffer;
      const rms = (start: number, end: number) => {
        let sum = 0;
        for (let i = start; i < end; i++) {
          const value = pcm.readFloatLE(i * 4);
          sum += value * value;
        }
        return Math.sqrt(sum / (end - start));
      };
      const frequencyEnergy = (start: number, end: number, frequency: number) => {
        let real = 0;
        let imaginary = 0;
        for (let index = start; index < end; index++) {
          const sample = pcm.readFloatLE(index * 4);
          const angle = (2 * Math.PI * frequency * index) / 48_000;
          real += sample * Math.cos(angle);
          imaginary += sample * Math.sin(angle);
        }
        return Math.hypot(real, imaginary);
      };
      expect(rms(48_000 * 0.05, 48_000 * 0.15)).toBeLessThan(0.01);
      expect(rms(48_000 * 0.3, 48_000 * 0.4)).toBeGreaterThan(0.01);
      expect(rms(48_000 * 0.5, 48_000 * 0.6)).toBeLessThan(0.01);
      expect(rms(48_000 * 0.7, 48_000 * 0.8)).toBeGreaterThan(0.01);
      expect(rms(48_000 * 0.9, 48_000 * 0.95)).toBeLessThan(0.01);
      const first440 = frequencyEnergy(48_000 * 0.3, 48_000 * 0.4, 440);
      const first880 = frequencyEnergy(48_000 * 0.3, 48_000 * 0.4, 880);
      const second440 = frequencyEnergy(48_000 * 0.7, 48_000 * 0.8, 440);
      const second880 = frequencyEnergy(48_000 * 0.7, 48_000 * 0.8, 880);
      expect(first440).toBeGreaterThan(1);
      expect(first880).toBeLessThan(first440 * 0.2);
      expect(second880).toBeGreaterThan(1);
      expect(second440).toBeLessThan(second880 * 0.2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('mixes native dialogue with a file-backed music layer and applies a fade', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-audio-v2-'));
    const videoPath = join(directory, 'dialogue.mp4');
    const musicPath = join(directory, 'music.wav');
    const outputPath = join(directory, 'output.mp4');
    const mutedPath = join(directory, 'muted.mp4');
    try {
      ffmpeg([
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=64x36:d=1:r=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1:sample_rate=48000',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        videoPath,
      ]);
      ffmpeg([
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:duration=1:sample_rate=48000',
        '-c:a',
        'pcm_s16le',
        musicPath,
      ]);
      const video = digest(videoPath);
      const music = digest(musicPath);
      const unsigned: Omit<CompositionPlanV2, 'planSha256'> = {
        version: 2,
        composition: { id: 'root', width: 64, height: 36 },
        viewport: { width: 64, height: 36 },
        frameRate: { num: 30, den: 1 },
        durationUs: 1_000_000,
        background: '#000000',
        layers: [
          {
            id: 'dialogue',
            kind: 'video',
            assetId: 'video',
            startUs: 0,
            durationUs: 1_000_000,
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
        audio: [
          {
            id: 'audio:dialogue',
            sourceKind: 'video-native',
            assetId: 'video',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
            gain: 0.5,
            pan: -1,
            mute: false,
            fadeOutUs: 500_000,
          },
          {
            id: 'music',
            sourceKind: 'audio-asset',
            assetId: 'music',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
            gain: 0.25,
            pan: 0,
            mute: false,
            fadeInUs: 250_000,
            role: 'music',
          },
        ],
        outputPreset: 'preview',
      };
      const plan = { ...unsigned, planSha256: planDigestV2(unsigned) };
      const bundle = createRenderBundleV2({
        plan,
        projectRef: 'audio-project',
        assets: {
          video: {
            assetId: 'video',
            opaqueRef: 'asset:video',
            integrity: { ...video, mime: 'video/mp4' },
          },
          music: {
            assetId: 'music',
            opaqueRef: 'asset:music',
            integrity: { ...music, mime: 'audio/wav' },
          },
        },
      });
      const resolver: RenderHostMediaResolver = {
        require: (ref) => ({ kind: 'file', path: ref === 'asset:video' ? videoPath : musicPath }),
        describe: (opaqueRef) => ({ opaqueRef }),
      };
      await renderBundleToFile({ protocolVersion: 1, bundle, outputPath, mediaResolver: resolver });
      const mutedUnsigned = {
        ...unsigned,
        audio: unsigned.audio.map((layer) =>
          layer.id === 'audio:dialogue' ? { ...layer, mute: true } : layer,
        ),
      };
      const mutedBundle = createRenderBundleV2({
        plan: { ...mutedUnsigned, planSha256: planDigestV2(mutedUnsigned) },
        projectRef: 'audio-project',
        assets: bundle.assets,
      });
      await renderBundleToFile({
        protocolVersion: 1,
        bundle: mutedBundle,
        outputPath: mutedPath,
        mediaResolver: resolver,
      });
      const pcm = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-i', outputPath, '-f', 'f32le', '-ac', '2', '-ar', '48000', 'pipe:1'],
        { shell: false },
      );
      expect(pcm.status).toBe(0);
      const samples = pcm.stdout as Buffer;
      const rms = (start: number, end: number, channel: number) => {
        let sum = 0;
        for (let i = start; i < end; i++) {
          const value = samples.readFloatLE((i * 2 + channel) * 4);
          sum += value * value;
        }
        return Math.sqrt(sum / Math.max(1, end - start));
      };
      const mutedPcm = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-i', mutedPath, '-f', 'f32le', '-ac', '2', '-ar', '48000', 'pipe:1'],
        { shell: false },
      ).stdout as Buffer;
      const mutedRms = (start: number, end: number, channel: number) => {
        let sum = 0;
        for (let i = start; i < end; i++) {
          const value = mutedPcm.readFloatLE((i * 2 + channel) * 4);
          sum += value * value;
        }
        return Math.sqrt(sum / Math.max(1, end - start));
      };
      // Native dialogue is mapped left, while centered music remains in both channels.
      expect(rms(48_000 * 0.2, 48_000 * 0.25, 0)).toBeGreaterThan(
        rms(48_000 * 0.2, 48_000 * 0.25, 1) * 1.2,
      );
      // The native layer's fade-out changes the tail, and mute removes it entirely.
      expect(rms(48_000 * 0.2, 48_000 * 0.25, 0)).toBeGreaterThan(
        mutedRms(48_000 * 0.2, 48_000 * 0.25, 0) * 1.2,
      );
      expect(rms(48_000 * 0.9, 48_000 * 0.95, 0)).toBeLessThan(rms(48_000 * 0.2, 48_000 * 0.25, 0));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renders the signed master/music bus stage with gain, pan, mute, and exact duration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-audio-bus-v2-'));
    const videoPath = join(directory, 'voice.mp4');
    const musicPath = join(directory, 'music.wav');
    const outputPath = join(directory, 'output.mp4');
    try {
      ffmpeg([
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=16x16:d=0.5:r=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=0.5:sample_rate=48000',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        videoPath,
      ]);
      ffmpeg([
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:duration=0.5:sample_rate=48000',
        '-c:a',
        'pcm_s16le',
        musicPath,
      ]);
      const voice = digest(videoPath);
      const music = digest(musicPath);
      const unsigned: Omit<CompositionPlanV2, 'planSha256'> = {
        version: 2,
        composition: { id: 'root', width: 16, height: 16 },
        viewport: { width: 16, height: 16 },
        frameRate: { num: 30, den: 1 },
        durationUs: 500_000,
        background: '#000',
        layers: [
          {
            id: 'voice',
            kind: 'video',
            assetId: 'voice',
            startUs: 0,
            durationUs: 500_000,
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
        audio: [
          {
            id: 'audio:voice',
            sourceKind: 'video-native',
            assetId: 'voice',
            startUs: 0,
            durationUs: 500_000,
            sourceInUs: 0,
            gain: 1,
            pan: 0,
            mute: false,
            busId: 'master',
          },
          {
            id: 'music',
            sourceKind: 'audio-asset',
            assetId: 'music',
            startUs: 0,
            durationUs: 500_000,
            sourceInUs: 0,
            gain: 1,
            pan: 0,
            mute: false,
            busId: 'music',
          },
        ],
        audioBuses: [
          { id: 'master', name: 'Master', gain: 1, pan: 0, mute: false },
          { id: 'music', name: 'Music', gain: 0.25, pan: 1, mute: false },
        ],
        outputPreset: 'preview',
      };
      const plan = { ...unsigned, planSha256: planDigestV2(unsigned) };
      const bundle = createRenderBundleV2({
        plan,
        projectRef: 'bus-test',
        assets: {
          voice: {
            assetId: 'voice',
            opaqueRef: 'asset:voice',
            integrity: { ...voice, mime: 'video/mp4' },
          },
          music: {
            assetId: 'music',
            opaqueRef: 'asset:music',
            integrity: { ...music, mime: 'audio/wav' },
          },
        },
      });
      await renderBundleToFile({
        protocolVersion: 1,
        bundle,
        outputPath,
        mediaResolver: {
          require: (ref) => ({ kind: 'file', path: ref.endsWith('voice') ? videoPath : musicPath }),
          describe: (opaqueRef) => ({ opaqueRef }),
        },
      });
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outputPath],
        { shell: false, encoding: 'utf8' },
      );
      expect(Number(probe.stdout.trim())).toBeCloseTo(0.5, 1);
      const pcm = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-i', outputPath, '-f', 'f32le', '-ac', '2', '-ar', '48000', 'pipe:1'],
        { shell: false },
      ).stdout as Buffer;
      const rms = (channel: number) => {
        let sum = 0;
        for (let i = 12_000; i < 18_000; i++) {
          const value = pcm.readFloatLE((i * 2 + channel) * 4);
          sum += value * value;
        }
        return Math.sqrt(sum / 6_000);
      };
      expect(Math.max(rms(0), rms(1))).toBeGreaterThan(0.005);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([0.5, 2] as const)(
    'time-stretches standalone music at %sx with pitch and timeline alignment',
    async (playbackRate) => {
      const directory = mkdtempSync(join(tmpdir(), `joy-media-audio-rate-${playbackRate}-`));
      const videoPath = join(directory, 'video.mp4');
      const musicPath = join(directory, 'music.wav');
      const outputPath = join(directory, 'output.mp4');
      try {
        ffmpeg([
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=16x16:d=1:r=30',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-an',
          videoPath,
        ]);
        ffmpeg([
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=880:duration=2:sample_rate=48000',
          '-c:a',
          'pcm_s16le',
          musicPath,
        ]);
        const video = digest(videoPath);
        const music = digest(musicPath);
        const unsigned: Omit<CompositionPlanV2, 'planSha256'> = {
          version: 2,
          composition: { id: 'root', width: 16, height: 16 },
          viewport: { width: 16, height: 16 },
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          background: '#000',
          layers: [
            {
              id: 'video',
              kind: 'video',
              assetId: 'video',
              startUs: 0,
              durationUs: 1_000_000,
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
          audio: [
            {
              id: 'music',
              sourceKind: 'audio-asset',
              assetId: 'music',
              startUs: 0,
              durationUs: 1_000_000,
              sourceInUs: 0,
              playbackRate,
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
          projectRef: 'audio-rate',
          assets: {
            video: {
              assetId: 'video',
              opaqueRef: 'asset:video',
              integrity: { ...video, mime: 'video/mp4' },
            },
            music: {
              assetId: 'music',
              opaqueRef: 'asset:music',
              integrity: { ...music, mime: 'audio/wav' },
            },
          },
        });
        await renderBundleToFile({
          protocolVersion: 1,
          bundle,
          outputPath,
          mediaResolver: {
            require: (ref) => ({
              kind: 'file',
              path: ref.endsWith('video') ? videoPath : musicPath,
            }),
            describe: (opaqueRef) => ({ opaqueRef }),
          },
        });
        const duration = Number(
          spawnSync(
            'ffprobe',
            [
              '-v',
              'error',
              '-show_entries',
              'format=duration',
              '-of',
              'default=nw=1:nk=1',
              outputPath,
            ],
            { shell: false, encoding: 'utf8' },
          ).stdout.trim(),
        );
        expect(duration).toBeCloseTo(1, 1);
        const pcm = spawnSync(
          'ffmpeg',
          ['-v', 'error', '-i', outputPath, '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'],
          { shell: false },
        ).stdout as Buffer;
        let real = 0;
        let imaginary = 0;
        for (let index = 9_600; index < 14_400; index++) {
          const sample = pcm.readFloatLE(index * 4);
          const angle = (2 * Math.PI * 880 * index) / 48_000;
          real += sample * Math.cos(angle);
          imaginary += sample * Math.sin(angle);
        }
        expect(Math.hypot(real, imaginary)).toBeGreaterThan(20);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('applies the V2 master limiter after the complete mix and proves the PCM ceiling', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-audio-limiter-v2-'));
    const sourcePath = join(directory, 'overdrive.mp4');
    const unlimitedPath = join(directory, 'unlimited.mp4');
    const limitedPath = join(directory, 'limited.mp4');
    try {
      // The source is intentionally hot; the two 4x layers must be mixed before limiting.
      ffmpeg([
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=16x16:d=0.5:r=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=0.5,volume=0.6',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        sourcePath,
      ]);
      const source = digest(sourcePath);
      const resolver: RenderHostMediaResolver = {
        require: () => ({ kind: 'file', path: sourcePath }),
        describe: (opaqueRef) => ({ opaqueRef }),
      };
      const makeBundle = (masterLimiter?: CompositionPlanV2['masterLimiter']) => {
        const unsigned: Omit<CompositionPlanV2, 'planSha256'> = {
          version: 2,
          composition: { id: 'root', width: 16, height: 16 },
          viewport: { width: 16, height: 16 },
          frameRate: { num: 30, den: 1 },
          durationUs: 500_000,
          background: '#000',
          layers: [
            {
              id: 'overdrive',
              kind: 'video',
              assetId: 'source',
              startUs: 0,
              durationUs: 500_000,
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
          audio: [
            {
              id: 'hot-a',
              sourceKind: 'video-native',
              assetId: 'source',
              startUs: 0,
              durationUs: 500_000,
              sourceInUs: 0,
              gain: 4,
              pan: 0,
              mute: false,
            },
            {
              id: 'hot-b',
              sourceKind: 'video-native',
              assetId: 'source',
              startUs: 0,
              durationUs: 500_000,
              sourceInUs: 0,
              gain: 4,
              pan: 0,
              mute: false,
            },
          ],
          audioBuses: [{ id: 'master', name: 'Master', gain: 8, pan: 0, mute: false }],
          ...(masterLimiter === undefined ? {} : { masterLimiter }),
          outputPreset: 'preview',
        };
        const plan = { ...unsigned, planSha256: planDigestV2(unsigned) };
        return createRenderBundleV2({
          plan,
          projectRef: 'limiter-proof',
          assets: {
            source: {
              assetId: 'source',
              opaqueRef: 'asset:source',
              integrity: { ...source, mime: 'video/mp4' },
            },
          },
        });
      };
      await renderBundleToFile({
        protocolVersion: 1,
        bundle: makeBundle(),
        outputPath: unlimitedPath,
        mediaResolver: resolver,
      });
      await renderBundleToFile({
        protocolVersion: 1,
        bundle: makeBundle({ ceilingDb: -12, releaseUs: 50_000 }),
        outputPath: limitedPath,
        mediaResolver: resolver,
      });
      const decode = (path: string): Float32Array => {
        const result = spawnSync(
          'ffmpeg',
          ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', '48000', 'pipe:1'],
          { shell: false },
        );
        expect(result.status).toBe(0);
        return new Float32Array(
          (result.stdout as Buffer).buffer,
          (result.stdout as Buffer).byteOffset,
          Math.floor((result.stdout as Buffer).byteLength / 4),
        );
      };
      const unlimited = decode(unlimitedPath);
      const limited = decode(limitedPath);
      const peak = (samples: Float32Array) =>
        samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
      const limitedPeak = peak(limited);
      expect(peak(unlimited)).toBeGreaterThan(0.98);
      // AAC reconstruction can move the peak slightly; this is a deliberately
      // small tolerance around the configured -12 dB ceiling, not a loose
      // clipping-reduction threshold.
      const configuredCeiling = Math.pow(10, -12 / 20);
      expect(limitedPeak).toBeGreaterThanOrEqual(configuredCeiling - 0.08);
      expect(limitedPeak).toBeLessThanOrEqual(configuredCeiling + 0.08);
      expect(limited.length).toBe(unlimited.length);
      expect(limited.length).toBeGreaterThan(48_000 * 2 * 0.45);
      // The source is mono and the existing routing maps it to the left channel;
      // the limiter must not alter that routing decision.
      expect(peak(limited.filter((_, index) => index % 2 === 0))).toBeGreaterThan(0.1);
      expect(peak(limited.filter((_, index) => index % 2 === 1))).toBeLessThan(0.01);
      const duration = (path: string) =>
        Number(
          spawnSync(
            'ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
            { shell: false, encoding: 'utf8' },
          ).stdout.trim(),
        );
      expect(duration(unlimitedPath)).toBeCloseTo(0.5, 1);
      expect(duration(limitedPath)).toBeCloseTo(0.5, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
