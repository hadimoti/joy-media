import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFERENCE_PROJECT } from '@joy-media/test-fixtures';
import {
  browserRemuxArgs,
  EXPORT_FINAL_ENCODE,
  ffmpegArgs,
  freezeManifest,
  dimensionsForPreset,
  remuxBrowserMp4,
  remuxBrowserMp4Async,
  probeBrowserVideoColor,
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
  it('freezes a manifest and uses argument arrays', () => {
    expect(freezeManifest(manifest)).toEqual(manifest);
    expect(ffmpegArgs(manifest, 'out.mp4')).toContain('libx264');
  });

  it('uses the shared final encode settings on both browser remux paths', () => {
    const args = browserRemuxArgs('staged.mp4', 'output.mp4', 30, 30, false);
    expect(args).toContain('libx264');
    expect(args).toContain('-pix_fmt');
    expect(args).toContain('yuv420p');
    expect(args).toContain('-crf');
    expect(args).toContain(String(EXPORT_FINAL_ENCODE.crf));
    expect(args).toContain('-preset');
    expect(args).toContain(EXPORT_FINAL_ENCODE.preset);
    expect(args).toContain('-b:a');
    expect(args).toContain(EXPORT_FINAL_ENCODE.audioBitrate);
    expect(args.slice(args.indexOf('-vf'), args.indexOf('-af'))).toEqual([
      '-vf',
      'setpts=N/(30*TB),tpad=stop_mode=clone:stop=-1',
    ]);
  });

  it('adds BT.709 limited-range tags only for tagged staged inputs', () => {
    const untaggedArgs = browserRemuxArgs('staged.mp4', 'output.mp4', 30, undefined, false);
    const taggedArgs = browserRemuxArgs('staged.mp4', 'output.mp4', 30, undefined, true);
    expect(untaggedArgs).not.toContain('-color_primaries');
    expect(taggedArgs).toEqual(
      expect.arrayContaining([
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-colorspace',
        'bt709',
        '-color_range',
        'tv',
      ]),
    );
  });

  it('accepts a normal canvas export size', () => {
    expect(freezeManifest({ ...manifest, width: 1920, height: 1080 })).toMatchObject({
      width: 1920,
      height: 1080,
    });
  });

  it('rejects odd H.264 canvas dimensions instead of changing the output size', () => {
    expect(() => freezeManifest({ ...manifest, width: 65, height: 36 })).toThrow(/even/i);
  });

  it('rejects a canvas above the documented H.264 export limit', () => {
    expect(() => freezeManifest({ ...manifest, width: 3840, height: 2162 })).toThrow(
      /export limit|maximum|supports up to/i,
    );
  });

  it.each(['reels-1080', 'shorts-1080', 'youtube-1080', 'high-bitrate'] as const)(
    'keeps canvas dimensions for the %s export preset',
    (preset) => {
      expect(dimensionsForPreset(preset, { width: 1234, height: 987 })).toEqual({
        width: 1234,
        height: 987,
      });
    },
  );
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
    expect(probeBrowserVideoColor(fixturePath)).toBe(false);
    const probe = remuxBrowserMp4(fixturePath, outputPath);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.videoStreamCount).toBe(1);
    expect(probe.audioStreamCount).toBe(1);
    expect(probe.frameRate).toBe(30);
    expect(readdirSync(directory).some((name) => name.includes('.partial.'))).toBe(false);
  });

  it('detects BT.709 limited-range tags on the staged input', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-color-probe-'));
    const fixturePath = join(directory, 'browser.mp4');
    const taggedPath = join(directory, 'tagged.mp4');
    const outputPath = join(directory, 'remuxed.mp4');
    renderFixture(manifest, fixturePath);
    const tagged = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-i',
        fixturePath,
        '-c',
        'copy',
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-colorspace',
        'bt709',
        '-color_range',
        'tv',
        taggedPath,
      ],
      { encoding: 'utf8', shell: false },
    );
    expect(tagged.status).toBe(0);
    expect(probeBrowserVideoColor(taggedPath)).toBe(true);
    remuxBrowserMp4(taggedPath, outputPath);
    expect(probeBrowserVideoColor(outputPath)).toBe(true);
  });
  it('runs async remux with a fake ffmpeg, reports failures, and aborts cleanly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-async-remux-'));
    const fixturePath = join(directory, 'browser.mp4');
    const outputPath = join(directory, 'remuxed.mp4');
    const scriptPath = join(directory, 'fake-ffmpeg.mjs');
    renderFixture(manifest, fixturePath);
    const runFakeFfmpeg = (script: string, signal?: AbortSignal) => {
      writeFileSync(scriptPath, script);
      return remuxBrowserMp4Async(fixturePath, outputPath, 30, undefined, {
        ffmpegPath: process.execPath,
        ffmpegArgsPrefix: [scriptPath],
        ...(signal === undefined ? {} : { signal }),
      });
    };
    try {
      const successScript = [
        "import { copyFileSync } from 'node:fs';",
        'const args = process.argv.slice(2);',
        "copyFileSync(args[args.indexOf('-i') + 1], args.at(-1));",
      ].join('\n');
      const probe = await runFakeFfmpeg(successScript);
      expect(probe).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
      rmSync(outputPath, { force: true });

      await expect(
        runFakeFfmpeg("process.stderr.write('fake remux failure'); process.exit(7);"),
      ).rejects.toThrow('ffmpeg remux failed: fake remux failure');
      const controller = new AbortController();
      const aborted = runFakeFfmpeg('setInterval(() => undefined, 1000);', controller.signal);
      setTimeout(() => controller.abort(), 35);
      await expect(aborted).rejects.toThrow('canceled');
      expect(readdirSync(directory).some((name) => name.includes('.partial.'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
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
