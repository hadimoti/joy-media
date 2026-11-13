import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createAssetLibraryFileCheck } from './assets-cmd.js';
import {
  formatRenderTimecode,
  missingRenderClips,
  missingRenderLines,
  runHeadlessRender,
} from './render-cmd.js';
import { createDefaultProject } from '../utils/project-loader.js';

class StringWritable extends Writable {
  public chunks: Buffer[] = [];
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function redirectStdout(target: StringWritable): () => void {
  const original = process.stdout.write.bind(process.stdout);
  const replacement = ((chunk: string | Buffer, ...rest: unknown[]): boolean => {
    target.write(chunk);
    return original(chunk as string, ...(rest as []));
  }) as typeof process.stdout.write;
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = replacement;
  return () => {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
  };
}

/** A root timeline with one clip on an enabled track that uses asset `x` (intro.mp4). */
function projectUsingAssetX(id: string, assetKind: string = 'video') {
  const project = createDefaultProject('Missing', { id });
  const root = project.compositions['root'] as unknown as {
    tracks: Array<{ id: string; clips: unknown[]; enabled?: boolean }>;
  };
  root.tracks[0]!.clips.push({
    id: 'clip-x',
    kind: 'video',
    assetId: 'x',
    startUs: 2_000_000,
    durationUs: 3_000_000,
    sourceInUs: 0,
  });
  (project as unknown as { assets: Record<string, unknown> }).assets = {
    x: { id: 'x', kind: assetKind, displayName: 'intro.mp4', bytes: 4 },
  };
  return project;
}

describe('formatRenderTimecode', () => {
  it('formats hh:mm:ss:ff at the given rate', () => {
    expect(formatRenderTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatRenderTimecode(3_500_000, 30)).toBe('00:00:03:15');
    expect(formatRenderTimecode(3_600_000_000, 25)).toBe('01:00:00:00');
  });
});

describe('missingRenderClips (T-R04 CLI list)', () => {
  it('lists a clip whose declared file asset is not in the library', () => {
    const missing = missingRenderClips(projectUsingAssetX('p1'), () => false);

    expect(missing).toEqual([
      {
        trackId: expect.any(String),
        clipId: 'clip-x',
        assetId: 'x',
        name: 'intro.mp4',
        startUs: 2_000_000,
        endUs: 5_000_000,
      },
    ]);
    expect(missingRenderLines(missing, 30)).toEqual([
      'intro.mp4 at 00:00:02:00 - 00:00:05:00 (clip clip-x on track ' + missing[0]!.trackId + ')',
    ]);
  });

  it('does not list a clip whose file is present', () => {
    expect(missingRenderClips(projectUsingAssetX('p2'), () => true)).toEqual([]);
  });

  it('does not check a clip with no declared asset, a LUT or an "other" asset', () => {
    const undeclared = createDefaultProject('Undeclared', { id: 'p3' });
    const undeclaredRoot = undeclared.compositions['root'] as unknown as {
      tracks: Array<{ clips: unknown[] }>;
    };
    undeclaredRoot.tracks[0]!.clips.push({ id: 'c', assetId: 'nope', startUs: 0, durationUs: 1 });

    expect(missingRenderClips(undeclared, () => false)).toEqual([]);
    expect(missingRenderClips(projectUsingAssetX('p4', 'lut'), () => false)).toEqual([]);
    expect(missingRenderClips(projectUsingAssetX('p5', 'other'), () => false)).toEqual([]);
  });

  it('skips clips on a disabled track', () => {
    const project = projectUsingAssetX('p6');
    const root = project.compositions['root'] as unknown as {
      tracks: Array<{ enabled?: boolean }>;
    };
    root.tracks[0]!.enabled = false;

    expect(missingRenderClips(project, () => false)).toEqual([]);
  });

  it('never throws on a document that is not a project', () => {
    expect(missingRenderClips(null, () => false)).toEqual([]);
    expect(missingRenderClips({ compositions: 'nope' }, () => false)).toEqual([]);
  });
});

describe('createAssetLibraryFileCheck', () => {
  it('is true only when the catalog lists the asset and its file is on disk', () => {
    const library = mkdtempSync(join(tmpdir(), 'joy-render-library-'));
    try {
      mkdirSync(join(library, 'media'));
      writeFileSync(join(library, 'media', 'x.mp4'), 'four');
      writeFileSync(
        join(library, 'catalog.json'),
        JSON.stringify({
          assets: [
            { id: 'x', kind: 'video', bytes: 4, displayName: 'x.mp4', relativePath: 'media/x.mp4' },
            { id: 'gone', kind: 'video', bytes: 4, displayName: 'g.mp4', relativePath: 'g.mp4' },
          ],
        }),
      );
      const hasFile = createAssetLibraryFileCheck(library);

      expect(hasFile('x')).toBe(true);
      expect(hasFile('gone')).toBe(false);
      expect(hasFile('unknown')).toBe(false);
    } finally {
      rmSync(library, { recursive: true, force: true });
    }
  });

  it('treats a library with no catalog as holding no files', () => {
    const library = mkdtempSync(join(tmpdir(), 'joy-render-empty-library-'));
    try {
      expect(createAssetLibraryFileCheck(library)('x')).toBe(false);
    } finally {
      rmSync(library, { recursive: true, force: true });
    }
  });

  it('reads the catalog lazily: creating the check is safe, the first check reads it', () => {
    const library = mkdtempSync(join(tmpdir(), 'joy-render-corrupt-library-'));
    try {
      writeFileSync(join(library, 'catalog.json'), '{ not json');
      const hasFile = createAssetLibraryFileCheck(library);

      expect(() => hasFile('x')).toThrow('Asset catalog is not valid JSON.');
    } finally {
      rmSync(library, { recursive: true, force: true });
    }
  });
});

describe('runHeadlessRender with a missing clip file', () => {
  it('stops with exit 1, names the clip with its time code, and writes no manifest', async () => {
    const library = mkdtempSync(join(tmpdir(), 'joy-render-no-files-'));
    const outDir = join(library, 'renders');
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runHeadlessRender({
        project: projectUsingAssetX('missing-stop'),
        preset: 'mp4',
        outDir,
        concurrency: 2,
        json: true,
        libraryDirectory: library,
      });

      expect(result.exitCode).toBe(1);
      expect(result.manifestWritten).toBe(false);
      const events = capture
        .text()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      expect(events[events.length - 1]).toMatchObject({
        type: 'error',
        code: 'missing-media',
      });
      expect(events[events.length - 1].message).toContain('intro.mp4 at 00:00:02:00 - 00:00:05:00');
      expect(events[events.length - 1].message).toContain('--allow-missing');
    } finally {
      restore();
      rmSync(library, { recursive: true, force: true });
    }
  });

  it('with allowMissing renders and records the clip as a warning', async () => {
    const library = mkdtempSync(join(tmpdir(), 'joy-render-allow-'));
    const outDir = join(library, 'renders');
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runHeadlessRender({
        project: projectUsingAssetX('missing-allowed'),
        preset: 'mp4',
        outDir,
        concurrency: 2,
        json: true,
        allowMissing: true,
        libraryDirectory: library,
      });

      expect(result.exitCode).toBe(0);
      expect(result.manifestWritten).toBe(true);
      expect(readdirSync(outDir)).toEqual(['missing-allowed.mp4.manifest.json']);
      expect(result.warnings.join('\n')).toContain('intro.mp4 at 00:00:02:00 - 00:00:05:00');
    } finally {
      restore();
      rmSync(library, { recursive: true, force: true });
    }
  });

  it('a corrupt catalog does not stop a project that uses no file assets', async () => {
    const library = mkdtempSync(join(tmpdir(), 'joy-render-corrupt-nofiles-'));
    const outDir = join(library, 'renders');
    writeFileSync(join(library, 'catalog.json'), '{ not json');
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runHeadlessRender({
        project: createDefaultProject('No files', { id: 'no-files' }),
        preset: 'mp4',
        outDir,
        concurrency: 2,
        json: true,
        libraryDirectory: library,
      });

      expect(result.exitCode).toBe(0);
      expect(capture.text()).not.toContain('Asset catalog is not valid JSON');
    } finally {
      restore();
      rmSync(library, { recursive: true, force: true });
    }
  });
});
