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

// Decodes one MP4 in passthrough order and returns the red value of the pixel the export spec samples.
function decodeRedProbe(file: string, width: number, height: number): number[] {
  const decoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { maxBuffer: 1 << 26 },
  );
  if (decoded.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${decoded.stderr}`);
  const frameBytes = width * height * 3;
  const offset = (18 * width + 32) * 3;
  const values: number[] = [];
  for (let start = 0; start + frameBytes <= decoded.stdout.length; start += frameBytes)
    values.push(decoded.stdout[start + offset]!);
  return values;
}

// Indices whose red value differs from the reference by more than two code values. Correct output
// differs by 0, and a one-frame shift of the 5-per-frame code moves the value by 5.
function misalignedFrames(reference: number[], actual: number[]): number[] {
  return actual.flatMap((value, index) => (Math.abs(value - reference[index]!) > 2 ? [index] : []));
}

// Writes a clip whose red channel encodes its frame index (5 * index mod 256) at the given rate.
function writeIndexedClip(file: string, frames: number, frameRate: number): void {
  const made = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=64x36:r=${frameRate},format=rgb24,geq=r=mod(5*N\\,256):g=0:b=0`,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-frames:v',
      String(frames),
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file,
    ],
    { encoding: 'utf8' },
  );
  if (made.status !== 0) throw new Error(`ffmpeg could not write ${file}: ${made.stderr}`);
}

// Re-stamps a clip with vsync-quantised capture timestamps: steps of 50 ms and 17 ms alternate.
function retimeLikeRecorder(input: string, output: string): void {
  const retimed = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-i',
      input,
      '-vf',
      "setpts='(67*floor(N/2)+50*mod(N,2))/1000/TB'",
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'copy',
      output,
    ],
    { encoding: 'utf8' },
  );
  if (retimed.status !== 0) throw new Error(`ffmpeg could not retime ${input}: ${retimed.stderr}`);
}

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

  it('keeps every browser-capture frame at its authored index when capture timestamps jitter', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-jitter-'));
    const constant = join(directory, 'constant.mp4');
    const jittered = join(directory, 'jittered.mp4');
    const constantOutput = join(directory, 'constant-remuxed.mp4');
    const jitteredOutput = join(directory, 'jittered-remuxed.mp4');
    writeIndexedClip(constant, 180, 30);
    retimeLikeRecorder(constant, jittered);
    remuxBrowserMp4(constant, constantOutput, 30, 180);
    const probe = remuxBrowserMp4(jittered, jitteredOutput, 30, 180);
    expect(probe.frameRate).toBe(30);
    expect(probe.durationUs).toBeGreaterThanOrEqual(5_990_000);
    expect(probe.durationUs).toBeLessThanOrEqual(6_010_000);
    const reference = decodeRedProbe(constantOutput, 64, 36);
    const actual = decodeRedProbe(jitteredOutput, 64, 36);
    expect(reference).toHaveLength(180);
    expect(actual).toHaveLength(180);
    expect(misalignedFrames(reference, actual)).toEqual([]);
  });

  it('pads a jittered short capture by repeating its last frame', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-short-jitter-'));
    const short = join(directory, 'short.mp4');
    const jittered = join(directory, 'short-jittered.mp4');
    const constantOutput = join(directory, 'short-remuxed.mp4');
    const jitteredOutput = join(directory, 'short-jittered-remuxed.mp4');
    writeIndexedClip(short, 150, 30);
    retimeLikeRecorder(short, jittered);
    remuxBrowserMp4(short, constantOutput, 30, 180);
    remuxBrowserMp4(jittered, jitteredOutput, 30, 180);
    const reference = decodeRedProbe(constantOutput, 64, 36);
    const actual = decodeRedProbe(jitteredOutput, 64, 36);
    expect(actual).toHaveLength(180);
    expect(misalignedFrames(reference, actual)).toEqual([]);
  });

  it('keeps the recorder timestamps when no frame count is given', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-rate-'));
    const fast = join(directory, 'fast.mp4');
    const outputPath = join(directory, 'remuxed.mp4');
    writeIndexedClip(fast, 360, 60);
    const probe = remuxBrowserMp4(fast, outputPath, 30);
    expect(probe.frameRate).toBe(30);
    // Six seconds of 60 fps must stay about six seconds. Indexing the 360 frames at 30 fps would give twelve.
    expect(probe.durationUs).toBeGreaterThanOrEqual(5_900_000);
    expect(probe.durationUs).toBeLessThanOrEqual(6_200_000);
  });

  it('keeps the authored frame count at a fractional frame rate', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-ntsc-'));
    const capture = join(directory, 'capture.mp4');
    const outputPath = join(directory, 'remuxed.mp4');
    const frames = Array.from({ length: 180 }, (_, index) => {
      const frame = new Uint8Array(manifest.width * manifest.height * 4);
      for (let offset = 0; offset < frame.length; offset += 4) {
        frame[offset] = (5 * index) % 256;
        frame[offset + 3] = 255;
      }
      return frame;
    });
    renderRgbaFrames({ ...manifest, durationUs: 6_000_000 }, frames, capture);
    const probe = remuxBrowserMp4(capture, outputPath, 29.97, 180);
    expect(probe.frameRate).toBeCloseTo(29.97, 2);
    expect(probe.durationUs).toBeGreaterThanOrEqual(5_990_000);
    expect(probe.durationUs).toBeLessThanOrEqual(6_020_000);
    expect(decodeRedProbe(outputPath, 64, 36)).toHaveLength(180);
  });
});
