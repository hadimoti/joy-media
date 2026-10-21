import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFERENCE_PROJECT } from '@joy-media/test-fixtures';
import {
  dimensionsForPreset,
  ffmpegArgs,
  freezeManifest,
  remuxBrowserMp4,
  renderFixture,
  renderRgbaFrames,
  verifyExport,
  verifyExportAgainstManifest,
} from './index.js';
describe('deterministic export contract', () => {
  const manifest = {
    projectId: 'p',
    revision: 4,
    width: 64,
    height: 36,
    frameRate: 30,
    durationUs: 100_000,
    preset: 'social-h264-aac',
  } as const;
  it.each([
    [
      { width: 1080, height: 1920 },
      { width: 1080, height: 1920 },
    ],
    [
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
    ],
    [
      { width: 320, height: 180 },
      { width: 1920, height: 1080 },
    ],
    [
      { width: 180, height: 320 },
      { width: 1080, height: 1920 },
    ],
    [
      { width: 1000, height: 1000 },
      { width: 1920, height: 1920 },
    ],
  ])('keeps high-bitrate output proportional for %o', (composition, expected) => {
    expect(dimensionsForPreset('high-bitrate', composition)).toEqual(expected);
  });
  it('freezes a manifest and uses argument arrays', () => {
    expect(freezeManifest(manifest)).toEqual(manifest);
    expect(ffmpegArgs(manifest, 'out.mp4')).toContain('libx264');
  });
  it('produces a verified H.264/AAC fixture through ffmpeg', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-export-'));
    const output = join(directory, 'fixture.mp4');
    renderFixture(manifest, output);
    expect(existsSync(output)).toBe(true);
    expect(readdirSync(directory).some((name) => name.includes('.partial.'))).toBe(false);
    expect(verifyExport(output)).toMatchObject({
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 64,
      height: 36,
      durationUs: 100_000,
      frameRate: 30,
      videoStreamCount: 1,
      audioStreamCount: 1,
    });
    expect(verifyExportAgainstManifest(output, manifest)).toMatchObject({
      width: 64,
      height: 36,
    });
  });
  it('encodes evaluated RGBA pixels through the verified export path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-rgba-export-'));
    const output = join(directory, 'scene-reel.mp4');
    const red = new Uint8Array(manifest.width * manifest.height * 4);
    for (let offset = 0; offset < red.length; offset += 4) {
      red[offset] = 220;
      red[offset + 3] = 255;
    }
    renderRgbaFrames(manifest, [red, red], output);
    expect(verifyExport(output)).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
  });
  it('keeps pure colours exact when a BT.709-tagged RGBA export is decoded', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-rgba-colour-'));
    const output = join(directory, 'blue.mp4');
    const blue = new Uint8Array(manifest.width * manifest.height * 4);
    for (let offset = 0; offset < blue.length; offset += 4) {
      blue[offset + 2] = 255;
      blue[offset + 3] = 255;
    }
    renderRgbaFrames(manifest, [blue, blue], output);
    const probe = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=color_space',
        '-of',
        'csv=p=0',
        output,
      ],
      { encoding: 'utf8' },
    );
    expect(probe.stdout.trim()).toBe('bt709');
    // Decode with the BT.709 matrix that players apply to this tag. A BT.601
    // conversion at encode time shows up here as green spill, (0,14,255).
    const decoded = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        output,
        '-frames:v',
        '1',
        '-vf',
        'scale=in_color_matrix=bt709:in_range=tv:out_range=pc',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      { maxBuffer: 1 << 20 },
    );
    const centre = (18 * manifest.width + 32) * 3;
    const pixel = [...decoded.stdout.subarray(centre, centre + 3)];
    expect(pixel[0]).toBeLessThanOrEqual(4);
    expect(pixel[1]).toBeLessThanOrEqual(4);
    expect(pixel[2]).toBeGreaterThanOrEqual(250);
  });
  // This intentionally runs two full-size 100 ms FFmpeg encodes. Under the
  // parallel repository suite, CPU contention can exceed Vitest's
  // five-second default even though the export remains healthy.
  it('exports both golden social formats from a frozen revision', () => {
    for (const format of REFERENCE_PROJECT.formats) {
      const output = join(
        mkdtempSync(join(tmpdir(), 'joy-media-reference-')),
        `${format.width}x${format.height}.mp4`,
      );
      renderFixture(
        {
          ...manifest,
          projectId: REFERENCE_PROJECT.id,
          revision: REFERENCE_PROJECT.revision,
          width: format.width,
          height: format.height,
        },
        output,
      );
      expect(verifyExport(output)).toMatchObject(format);
    }
  }, 60_000);
  it('remuxes browser MP4 to h264/aac with exactly one video and audio stream at 30 fps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-'));
    const fixturePath = join(directory, 'browser.mp4');
    const outputPath = join(directory, 'remuxed.mp4');
    renderFixture(manifest, fixturePath);
    const probe = remuxBrowserMp4(fixturePath, outputPath);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.videoStreamCount).toBe(1);
    expect(probe.audioStreamCount).toBe(1);
    expect(probe.frameRate).toBe(30);
    expect(readdirSync(directory).some((name) => name.includes('.partial.'))).toBe(false);
  });
  it('keeps pure blue exact after a browser capture is remuxed to a BT.709 export', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-colour-'));
    const capture = join(directory, 'capture.mp4');
    const outputPath = join(directory, 'remuxed.mp4');
    // Untagged H.264 made from pure blue. FFmpeg's default RGB-to-YUV conversion is
    // BT.601, which is the matrix Chromium's capture uses for its content.
    const made = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x0000FF:s=64x36:r=30:d=0.1',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo',
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        capture,
      ],
      { encoding: 'utf8' },
    );
    expect(made.status).toBe(0);
    remuxBrowserMp4(capture, outputPath, 30, 3);
    const probe = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=color_space',
        '-of',
        'csv=p=0',
        outputPath,
      ],
      { encoding: 'utf8' },
    );
    expect(probe.stdout.trim()).toBe('bt709');
    // Decode with the BT.709 matrix that players apply to this tag.
    const decoded = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        outputPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=in_color_matrix=bt709:in_range=tv:out_range=pc',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      { maxBuffer: 1 << 20 },
    );
    const centre = (18 * 64 + 32) * 3;
    const pixel = [...decoded.stdout.subarray(centre, centre + 3)];
    expect(pixel[0]).toBeLessThanOrEqual(4);
    expect(pixel[1]).toBeLessThanOrEqual(4);
    expect(pixel[2]).toBeGreaterThanOrEqual(250);
  });
  it('normalizes slow browser-capture timestamps to the authored frame count', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-timeline-'));
    const fixturePath = join(directory, 'slow-browser.mp4');
    const outputPath = join(directory, 'normalized.mp4');
    renderFixture(
      {
        ...manifest,
        frameRate: 1,
        durationUs: 2_000_000,
      },
      fixturePath,
    );

    const probe = remuxBrowserMp4(fixturePath, outputPath, 30, 2);
    expect(probe.frameRate).toBe(30);
    expect(probe.durationUs).toBeGreaterThanOrEqual(60_000);
    expect(probe.durationUs).toBeLessThanOrEqual(100_000);
  });

  it('pads a short browser capture to the authored frame count', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-short-capture-'));
    const fixturePath = join(directory, 'short-browser.mp4');
    const outputPath = join(directory, 'normalized.mp4');
    const frames = Array.from({ length: 29 }, (_, index) => {
      const frame = new Uint8Array(manifest.width * manifest.height * 4);
      for (let offset = 0; offset < frame.length; offset += 4) {
        frame[offset] = index * 8;
        frame[offset + 1] = 220;
        frame[offset + 3] = 255;
      }
      return frame;
    });
    renderRgbaFrames({ ...manifest, durationUs: 1_000_000 }, frames, fixturePath);

    const probe = remuxBrowserMp4(fixturePath, outputPath, manifest.frameRate, 30);
    const countResult = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=nb_read_frames',
        '-of',
        'default=nw=1:nk=1',
        outputPath,
      ],
      { encoding: 'utf8', shell: false },
    );
    expect(countResult.status).toBe(0);
    expect(Number(countResult.stdout.trim())).toBe(30);
    expect(probe.durationUs).toBeGreaterThanOrEqual(950_000);
    expect(probe.durationUs).toBeLessThanOrEqual(1_050_000);
  });
});
