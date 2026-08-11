import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { remuxBrowserMp4, verifyExportAgainstManifest } from './index.js';

const manifest = {
  projectId: 'wp29-step03-proof',
  revision: 1,
  width: 320,
  height: 180,
  frameRate: 30,
  durationUs: 3_000_000,
  preset: 'social-h264-aac',
} as const;

interface VolumeMeasurement {
  readonly meanDb: number;
  readonly maxDb: number;
}

function runFfmpeg(args: readonly string[], label: string): string {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr}`);
  }
  return result.stderr;
}

function renderBrowserRecorderFixture(outputPath: string, gain: number): void {
  runFfmpeg(
    [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=#202020:s=${manifest.width}x${manifest.height}:r=${manifest.frameRate}:d=3`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=997:sample_rate=48000:duration=3',
      '-filter:a',
      `volume=${gain}`,
      '-t',
      '3',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-f',
      'mp4',
      outputPath,
    ],
    'browser-recorder fixture encode',
  );
}

function parseDb(output: string, field: 'mean_volume' | 'max_volume'): number {
  const match = output.match(new RegExp(`${field}:\\s*(-?inf|[+-]?\\d+(?:\\.\\d+)?)\\s+dB`, 'i'));
  if (match === null) throw new Error(`FFmpeg volumedetect did not report ${field}`);
  return match[1]!.toLowerCase() === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

function measureVolume(path: string): VolumeMeasurement {
  const output = runFfmpeg(
    [
      '-hide_banner',
      '-nostats',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ],
    'FFmpeg volumedetect',
  );
  return {
    meanDb: parseDb(output, 'mean_volume'),
    maxDb: parseDb(output, 'max_volume'),
  };
}

describe('WP-29 STEP-03 retained export duration and audio proof', () => {
  it('verifies one-frame duration tolerance plus audible, muted, and gain-direction output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-wp29-step03-'));
    try {
      const cases = [
        { id: 'audible', gain: 1 },
        { id: 'gain-minus-12db', gain: 0.25 },
        { id: 'muted', gain: 0 },
      ] as const;

      const measurements = cases.map(({ id, gain }) => {
        const browserPath = join(directory, `${id}-browser.mp4`);
        const exportPath = join(directory, `${id}-export.mp4`);
        renderBrowserRecorderFixture(browserPath, gain);
        remuxBrowserMp4(browserPath, exportPath, manifest.frameRate);
        const probe = verifyExportAgainstManifest(exportPath, manifest);
        return {
          id,
          durationUs: probe.durationUs,
          durationDeltaUs: Math.abs(probe.durationUs - manifest.durationUs),
          ...measureVolume(exportPath),
        };
      });

      const audible = measurements.find((measurement) => measurement.id === 'audible')!;
      const quieter = measurements.find((measurement) => measurement.id === 'gain-minus-12db')!;
      const muted = measurements.find((measurement) => measurement.id === 'muted')!;
      const oneFrameUs = Math.ceil(1_000_000 / manifest.frameRate);
      const expectedGainDeltaDb = 20 * Math.log10(1 / 0.25);
      const measuredGainDeltaDb = audible.meanDb - quieter.meanDb;

      expect(measurements.every(({ durationDeltaUs }) => durationDeltaUs <= oneFrameUs)).toBe(true);
      expect(audible.meanDb).toBeGreaterThan(-40);
      expect(audible.maxDb).toBeGreaterThan(-30);
      expect(muted.meanDb).toBeLessThanOrEqual(-70);
      expect(muted.maxDb).toBeLessThanOrEqual(-70);
      expect(quieter.meanDb).toBeLessThan(audible.meanDb);
      expect(measuredGainDeltaDb).toBeCloseTo(expectedGainDeltaDb, 0);

      process.stdout.write(
        `WP29_STEP03_PROOF ${JSON.stringify({
          expectedDurationUs: manifest.durationUs,
          oneFrameToleranceUs: oneFrameUs,
          expectedGainDeltaDb,
          measuredGainDeltaDb,
          measurements,
        })}\n`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
