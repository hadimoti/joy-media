import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { judgeCaptionProbe, prepareCaptionProbe } from './caption-face-pixels.js';

const FONT = 'noto-sans-arabic-arabic-400-normal.ttf';
const FRAME_BYTES = 320 * 180 * 3;

interface CaptionReference {
  readonly ffmpegVersionLine: string;
  readonly font: string;
  readonly differingPixels: number;
  readonly canonicalFrameSha256: string;
  readonly missingFrameSha256: string;
}

const reference = JSON.parse(
  readFileSync(new URL('./caption-face-pixels.reference.json', import.meta.url), 'utf8'),
) as CaptionReference;

/** A frame whose first `litPixels` pixels are white and the rest black. */
function frame(litPixels: number): Buffer {
  const buffer = Buffer.alloc(FRAME_BYTES);
  for (let pixel = 0; pixel < litPixels; pixel += 1) buffer.fill(255, pixel * 3, pixel * 3 + 3);
  return buffer;
}

function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function ffmpegVersionLine(): string {
  const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return (result.stdout ?? '').split('\n')[0].trim();
}

function bundledFace(): Buffer {
  return readFileSync(
    new URL(
      `../../../../packages/html-scene-runtime/assets/fonts/noto-sans-arabic/libass/fonts/${FONT}`,
      import.meta.url,
    ),
  );
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'caption-face-pixels-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('judgeCaptionProbe', () => {
  function writeFrames(canonicalLit: number, missingLit: number): void {
    writeFileSync(join(directory, 'canonical.rgb'), frame(canonicalLit));
    writeFileSync(join(directory, 'missing.rgb'), frame(missingLit));
  }

  function judge(overrides: Partial<Parameters<typeof judgeCaptionProbe>[0]> = {}) {
    return judgeCaptionProbe({
      directory,
      fontFile: FONT,
      canonical: { status: 0, log: '' },
      missing: { status: 0 },
      ...overrides,
    });
  }

  it('finds the canonical face usable when it draws 64 pixels the missing family does not', () => {
    writeFrames(64, 0);
    expect(judge()).toMatchObject({ usable: true, differingPixels: 64 });
  });

  it('refuses 63 differing pixels, below the minimum for a drawn glyph', () => {
    writeFrames(63, 0);
    expect(judge()).toMatchObject({ usable: false, differingPixels: 63 });
  });

  it('treats identical frames, as a face libass could not load would draw, as unusable', () => {
    writeFrames(500, 500);
    expect(judge()).toMatchObject({ usable: false, differingPixels: 0 });
  });

  it('refuses when either FFmpeg run exits non-zero', () => {
    writeFrames(500, 0);
    expect(judge({ canonical: { status: 1, log: '' } }).usable).toBe(false);
    expect(judge({ missing: { status: 1 } }).usable).toBe(false);
  });

  it('refuses when libass reports that it could not open the canonical font, even with pixels drawn', () => {
    writeFrames(500, 0);
    const log = `[Parsed_ass_0] Error opening font file fonts/${FONT}`;
    expect(judge({ canonical: { status: 0, log } }).usable).toBe(false);
  });

  it('reads a missing frame as zero differing pixels', () => {
    writeFileSync(join(directory, 'missing.rgb'), frame(500));
    expect(judge()).toMatchObject({ usable: false, differingPixels: 0 });
  });

  it('reads a frame of the wrong length as zero differing pixels', () => {
    writeFileSync(join(directory, 'canonical.rgb'), Buffer.alloc(10));
    writeFileSync(join(directory, 'missing.rgb'), frame(0));
    expect(judge()).toMatchObject({ usable: false, differingPixels: 0 });
  });

  it('returns the canonical log unchanged, so the caller can report it', () => {
    writeFrames(500, 0);
    expect(judge({ canonical: { status: 0, log: 'libass line' } }).log).toBe('libass line');
  });
});

describe('prepareCaptionProbe', () => {
  it('writes the face and two caption documents, and names the family in each', () => {
    const face = Buffer.from('face bytes');
    const commands = prepareCaptionProbe(directory, FONT, face);
    expect(readFileSync(join(directory, 'fonts', FONT))).toEqual(face);
    expect(readFileSync(join(directory, 'canonical.ass'), 'utf8')).toContain(
      'Style: Caption,Noto Sans Arabic,28,',
    );
    expect(readFileSync(join(directory, 'missing.ass'), 'utf8')).toContain(
      'Style: Caption,Joy Media Missing Caption Family,28,',
    );
    expect(commands.canonical).toContain('ass=filename=canonical.ass:fontsdir=fonts');
    expect(commands.canonical).toContain('canonical.rgb');
    expect(commands.missing).toContain('ass=filename=missing.ass:fontsdir=fonts');
    expect(commands.missing).toContain('missing.rgb');
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function drawProbe(face: Buffer) {
  const commands = prepareCaptionProbe(directory, FONT, face);
  const canonical = spawnSync('ffmpeg', commands.canonical, { cwd: directory, encoding: 'utf8' });
  const missing = spawnSync('ffmpeg', commands.missing, { cwd: directory, encoding: 'utf8' });
  return judgeCaptionProbe({
    directory,
    fontFile: FONT,
    canonical: { status: canonical.status, log: canonical.stderr },
    missing: { status: missing.status },
  });
}

describe.skipIf(!hasFfmpeg)('caption probe with FFmpeg', () => {
  it('finds the bundled canonical face usable when libass draws it', () => {
    expect(drawProbe(bundledFace())).toMatchObject({ usable: true });
  });

  it('refuses a face that is not a font file, so captions would fail closed', () => {
    expect(drawProbe(Buffer.from('this is not a font file'))).toMatchObject({ usable: false });
  });

  // The exact frames are pinned to one FFmpeg build. Other builds are judged by the usable check above.
  it.skipIf(ffmpegVersionLine() !== reference.ffmpegVersionLine)(
    'matches the pinned reference frames on the pinned FFmpeg build',
    () => {
      const judged = drawProbe(bundledFace());
      expect(judged.differingPixels).toBe(reference.differingPixels);
      expect(digestOf(join(directory, 'canonical.rgb'))).toBe(reference.canonicalFrameSha256);
      expect(digestOf(join(directory, 'missing.rgb'))).toBe(reference.missingFrameSha256);
    },
  );
});
