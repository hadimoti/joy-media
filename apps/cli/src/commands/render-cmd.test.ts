import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { runCli } from '../cli.js';
import { cliSchemaErrors } from '../humanized/schema-validation.js';
import {
  handleRenderCommand,
  collectTitleSources,
  isRenderPresetId,
  MANIFEST_ONLY_MESSAGE,
  MAX_CLIP_DURATION_US,
  planRender,
  RENDER_PRESETS,
  runHeadlessRender,
  publishPreviewAtomically,
  removeArtifactStagingFiles,
  safeFileStem,
} from './render-cmd.js';
import { CommandFailure, createDefaultProject, saveProject } from '../utils/project-loader.js';
import { encodeRgbaPng } from '../services/title-frames.js';
import {
  buildFfmpegArgs,
  setAssFileWriterForTests,
  setEncodeSpawnForTests,
  startEncode,
} from './render-media.js';
import { renderInputsDigest } from '../services/render-preparation.js';
import { normalizeUniversalTimeline } from '@joy-media/project-schema';
import { probeMediaAsync, setMediaProbeSpawnForTests } from '../utils/media-probe.js';

function timelineOrderProject(trackIds: readonly string[], disabledTrack?: string) {
  const tracks = trackIds.map((id) => ({
    id,
    kind: 'video',
    order: id === 'low' ? 0 : 1,
    enabled: true,
    clips: [
      {
        kind: 'video',
        id: `clip-${id}`,
        assetId: 'asset-test',
        startUs: 0,
        durationUs: 1_000_000,
      },
    ],
  }));
  return {
    schemaVersion: 1,
    rootCompositionId: 'root',
    compositions: { root: { id: 'root', tracks } },
    assets: { 'asset-test': { id: 'asset-test', kind: 'video', displayName: 'test' } },
    timelineTrackDeck: {
      rows: ['low', 'high'].map((trackId, order) => ({
        compositionId: 'root',
        trackId,
        order,
        enabled: trackId !== disabledTrack,
        locked: false,
      })),
    },
    pluginData: {
      'joy.contentTemplates': {
        instances: Object.fromEntries(
          ['low', 'high'].map((id) => [
            `title-${id}`,
            { clipId: `clip-${id}`, objectId: `object-${id}` },
          ]),
        ),
      },
    },
  } as never;
}

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

const tempDir = mkdtempSync(join(tmpdir(), 'joy-render-cmd-test-'));
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const testDbPath = join(tempDir, 'render-test.sqlite3');
const outDir = join(tempDir, 'renders');

beforeAll(() => {
  // These direct runCli calls must never secure or read the developer's real
  // ~/.joy-media directory. The subprocess harness already provides a fake
  // HOME for its CLI integration tests; mirror that isolation here.
  vi.stubEnv('HOME', tempDir);
  vi.stubEnv('USERPROFILE', tempDir);
  vi.stubEnv('APPDATA', join(tempDir, 'AppData', 'Roaming'));
  vi.stubEnv('JOY_MEDIA_SQLITE_PATH', join(tempDir, 'joy-media.sqlite3'));
});

afterAll(() => {
  vi.unstubAllEnvs();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore transient Windows SQLite locks after the test suite finishes.
  }
});

describe('joy render (headless batch render command)', () => {
  it('spawns the exact FFmpeg path whose hash was validated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-pinned-ffmpeg-'));
    const executablePath = join(dir, 'ffmpeg');
    const bytes = Buffer.from('validated executable');
    writeFileSync(executablePath, bytes);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      kill: vi.fn(),
    });
    const spawn = vi.fn(() => child as never);
    setEncodeSpawnForTests(spawn as never);
    try {
      const handle = startEncode([], 1_000_000, () => {}, [], undefined, {
        path: executablePath,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      });
      expect(spawn).toHaveBeenCalledWith(executablePath, [], expect.any(Object));
      child.emit('close', 0, null);
      await expect(handle.done).resolves.toEqual({ ok: true });
    } finally {
      setEncodeSpawnForTests(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves FFmpeg environment drift through runHeadlessRender', async () => {
    const directory = mkdtempSync(join(tempDir, 'render-ffmpeg-drift-map-'));
    const mediaPath = join(directory, 'input.mp4');
    writeFileSync(mediaPath, 'placeholder source');
    const project = createDefaultProject('FFmpeg drift', { id: 'ffmpeg-drift-map' });
    const root = project.compositions['root'] as unknown as { tracks: Array<{ clips: unknown[] }> };
    root.tracks[0]!.clips.push({
      id: 'drift-video',
      kind: 'video',
      assetId: mediaPath,
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    });
    (project.assets as Record<string, unknown>)[mediaPath] = { id: mediaPath, kind: 'video' };
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    setMediaProbeSpawnForTests(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        kill: vi.fn(() => true),
      });
      setTimeout(() => {
        child.stdout.end(
          JSON.stringify({
            streams: [{ codec_type: 'video', width: 320, height: 240, pix_fmt: 'yuv420p' }],
            format: { format_name: 'mp4', duration: '1.0' },
          }),
        );
        child.exitCode = 0;
        child.emit('close', 0, null);
      }, 0);
      return child as never;
    });
    setEncodeSpawnForTests((() => {
      throw new CommandFailure('RENDER_ENVIRONMENT_DRIFT', 'pinned FFmpeg changed');
    }) as never);
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: directory,
        concurrency: 1,
        json: true,
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(capture.text().trim().split('\n').filter(Boolean).at(-1)!)).toMatchObject({
        type: 'error',
        code: 'RENDER_ENVIRONMENT_DRIFT',
        message: 'pinned FFmpeg changed',
      });
    } finally {
      restore();
      setMediaProbeSpawnForTests(undefined);
      setEncodeSpawnForTests(undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not spawn FFmpeg when the pinned executable hash has drifted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-ffmpeg-pin-'));
    const executablePath = join(dir, 'ffmpeg');
    writeFileSync(executablePath, 'validated executable');
    const pinnedSha256 = `sha256:${createHash('sha256').update('validated executable').digest('hex')}`;
    const spawn = vi.fn();
    setEncodeSpawnForTests(spawn as never);
    writeFileSync(executablePath, 'changed executable');
    try {
      expect(() =>
        startEncode([], 1_000_000, () => {}, [], undefined, {
          path: executablePath,
          sha256: pinnedSha256,
        }),
      ).toThrowError(expect.objectContaining({ code: 'RENDER_ENVIRONMENT_DRIFT' }));
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      setEncodeSpawnForTests(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'waits for the cancellation helper deadline before settling the encoder timeout',
    async () => {
      const encoder = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 48123,
        exitCode: null as number | null,
        kill: vi.fn(),
      });
      const helper = Object.assign(new EventEmitter(), { kill: vi.fn() });
      setEncodeSpawnForTests(
        ((command: string) => (command === 'taskkill' ? helper : encoder) as never) as never,
      );
      const handle = startEncode([], 1_000_000, () => {});
      const startedAt = performance.now();
      const cancellation = handle.cancel();
      setTimeout(() => {
        encoder.exitCode = 1;
        encoder.emit('close', 1, 'SIGKILL');
      }, 10);
      try {
        await expect(
          Promise.race([
            handle.done,
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
          ]),
        ).resolves.toBe('pending');
        await expect(handle.done).resolves.toMatchObject({ code: 'RENDER_CANCEL_TIMEOUT' });
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(4_900);
        await cancellation;
      } finally {
        setEncodeSpawnForTests(undefined);
      }
    },
    7_000,
  );

  it('returns within 100 ms when cancelled during an in-flight media probe', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      kill: vi.fn(function (this: {
        exitCode: number | null;
        emit: (event: string, ...args: unknown[]) => boolean;
      }) {
        return true;
      }),
    });
    setMediaProbeSpawnForTests(() => child as never);
    const controller = new AbortController();
    const started = performance.now();
    const result = probeMediaAsync('long-running.mp4', { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(child.kill).toHaveBeenCalledOnce();
      let settled = false;
      void result.then(
        () => (settled = true),
        () => (settled = true),
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      child.exitCode = 1;
      child.emit('close', null, 'SIGKILL');
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(performance.now() - started).toBeLessThan(100);
    } finally {
      setMediaProbeSpawnForTests(undefined);
    }
  });

  it('keeps a prior preview and removes staging output when cancelled', () => {
    const directory = mkdtempSync(join(tempDir, 'atomic-preview-'));
    const artifactPath = join(directory, 'preview-0.png');
    const stagingPath = join(directory, '.preview-0-staging.png');
    const previous = encodeRgbaPng(1, 1, Uint8Array.from([1, 2, 3, 255]));
    try {
      writeFileSync(artifactPath, previous);
      writeFileSync(stagingPath, Buffer.from('partial png'));
      const controller = new AbortController();
      controller.abort();
      expect(publishPreviewAtomically(stagingPath, artifactPath, controller.signal, 1, 1)).toBe(
        false,
      );
      expect(readFileSync(artifactPath)).toEqual(previous);
      expect(existsSync(stagingPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a live owner of a manifest target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-live-owner-'));
    const target = join(dir, 'live-owner.mp4.manifest.json');
    writeFileSync(
      `${target}.owner`,
      JSON.stringify({ pid: process.pid, token: 'live-owner', createdAt: Date.now() }),
    );
    const project = createDefaultProject('Live owner', { id: 'live-owner' });
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: dir,
        concurrency: 1,
        json: true,
        manifestOnly: true,
      });
      expect(result.exitCode).toBe(1);
      const event = JSON.parse(capture.text().trim()) as { code: string; message: string };
      expect(event.code).toBe('RENDER_OUTPUT_BUSY');
      expect(event.message).toContain(target);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a dead output lock whose journal phase is not recognised, without discarding its backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-invalid-lock-journal-'));
    const manifestPath = join(dir, 'invalid-journal.mp4.manifest.json');
    const mediaPath = join(dir, 'input.mp4');
    const lockPath = join(dir, '.invalid-journal.mp4.render.lock');
    const mediaBackup = join(dir, '.invalid-journal.mp4.interrupted.backup');
    writeFileSync(mediaPath, 'probe fixture');
    writeFileSync(mediaBackup, 'backup that must survive');
    const project = createDefaultProject('Invalid journal', { id: 'invalid-journal' });
    const root = project.compositions['root'] as unknown as { tracks: Array<{ clips: unknown[] }> };
    root.tracks[0]!.clips.push({
      id: 'invalid-journal-clip',
      kind: 'video',
      assetId: mediaPath,
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    });
    (project.assets as Record<string, unknown>)[mediaPath] = { id: mediaPath, kind: 'video' };
    const lockRecord = {
      pid: 2_147_000_000,
      token: 'dead-invalid-journal',
      startedAt: new Date(1).toISOString(),
      activePartialPath: null,
      transaction: {
        // Not a phase the CLI writes, so only the record-shape check can refuse this journal.
        phase: 'half-committed',
        mediaPath: join(dir, 'invalid-journal.mp4'),
        stagedMediaPath: join(dir, '.invalid-journal.mp4.interrupted.partial'),
        mediaBackup,
        hadMedia: true,
        manifestPath,
        stagedManifestPath: join(dir, '.invalid-journal.mp4.manifest.json.interrupted.tmp'),
        manifestBackup: join(dir, '.invalid-journal.mp4.manifest.json.interrupted.backup'),
        hadManifest: true,
      },
    };
    writeFileSync(lockPath, JSON.stringify(lockRecord));
    const originalLock = readFileSync(lockPath);
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    setMediaProbeSpawnForTests(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        kill: vi.fn(() => true),
      });
      setTimeout(() => {
        child.stdout.end(
          JSON.stringify({
            streams: [{ codec_type: 'video', width: 320, height: 240, pix_fmt: 'yuv420p' }],
            format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.0' },
          }),
        );
        child.exitCode = 0;
        child.emit('close', 0, null);
      }, 0);
      return child as never;
    });
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: dir,
        concurrency: 1,
        json: true,
      });
      expect(result.exitCode).toBe(1);
      const event = JSON.parse(capture.text().trim().split('\n').at(-1)!) as {
        code: string;
        message: string;
      };
      expect(event.code).toBe('output');
      expect(event.message).toContain('could not be recovered');
      expect(event.message).toContain('invalid journal');
      expect(readFileSync(lockPath)).toEqual(originalLock);
      expect(readFileSync(mediaBackup, 'utf8')).toBe('backup that must survive');
    } finally {
      restore();
      setMediaProbeSpawnForTests(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a dead output lock whose journal points outside the output directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-outside-journal-'));
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    const manifestPath = join(dir, 'outside-journal.mp4.manifest.json');
    const mediaPath = join(dir, 'input.mp4');
    const lockPath = join(dir, '.outside-journal.mp4.render.lock');
    const mediaBackup = join(dir, '.outside-journal.mp4.interrupted.backup');
    writeFileSync(mediaPath, 'probe fixture');
    writeFileSync(mediaBackup, 'backup that must stay in the output directory');
    const project = createDefaultProject('Outside journal', { id: 'outside-journal' });
    const root = project.compositions['root'] as unknown as { tracks: Array<{ clips: unknown[] }> };
    root.tracks[0]!.clips.push({
      id: 'outside-journal-clip',
      kind: 'video',
      assetId: mediaPath,
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    });
    (project.assets as Record<string, unknown>)[mediaPath] = { id: mediaPath, kind: 'video' };
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 2_147_000_000,
        token: 'dead-outside-journal',
        startedAt: new Date(1).toISOString(),
        activePartialPath: null,
        transaction: {
          // A well-formed journal whose media path lies in a subfolder, outside the output directory.
          phase: 'committing',
          mediaPath: join(elsewhere, 'outside-journal.mp4'),
          stagedMediaPath: join(dir, '.outside-journal.mp4.interrupted.partial'),
          mediaBackup,
          hadMedia: true,
          manifestPath,
          stagedManifestPath: join(dir, '.outside-journal.mp4.manifest.json.interrupted.tmp'),
          manifestBackup: join(dir, '.outside-journal.mp4.manifest.json.interrupted.backup'),
          hadManifest: false,
        },
      }),
    );
    const originalLock = readFileSync(lockPath);
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    setMediaProbeSpawnForTests(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        kill: vi.fn(() => true),
      });
      setTimeout(() => {
        child.stdout.end(
          JSON.stringify({
            streams: [{ codec_type: 'video', width: 320, height: 240, pix_fmt: 'yuv420p' }],
            format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.0' },
          }),
        );
        child.exitCode = 0;
        child.emit('close', 0, null);
      }, 0);
      return child as never;
    });
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: dir,
        concurrency: 1,
        json: true,
      });
      expect(result.exitCode).toBe(1);
      const event = JSON.parse(capture.text().trim().split('\n').at(-1)!) as {
        code: string;
        message: string;
      };
      expect(event.code).toBe('output');
      expect(event.message).toContain('outside its output directory');
      expect(readFileSync(lockPath)).toEqual(originalLock);
      expect(readFileSync(mediaBackup, 'utf8')).toBe(
        'backup that must stay in the output directory',
      );
      expect(existsSync(join(elsewhere, 'outside-journal.mp4'))).toBe(false);
    } finally {
      restore();
      setMediaProbeSpawnForTests(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes the generated staging files for a target whose name contains .partial, and keeps its backups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-staging-names-'));
    try {
      const target = join(dir, 'clip.partial.mp4');
      const backup = join(dir, '.clip.partial.mp4.1234.abcdef12.backup');
      const partial = join(dir, '.clip.partial.mp4.1234.abcdef12.partial');
      const preview = join(dir, '.clip.partial.mp4.1234.0123456789abcdef.staging.png');
      writeFileSync(backup, 'backup that must survive');
      writeFileSync(partial, 'partial');
      writeFileSync(preview, 'preview');
      removeArtifactStagingFiles(target);
      expect(readFileSync(backup, 'utf8')).toBe('backup that must survive');
      expect(existsSync(partial)).toBe(false);
      expect(existsSync(preview)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes a manifest temp file only for its manifest target, never for the media target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-manifest-temp-'));
    try {
      const manifestTemp = join(dir, '.clip.mp4.manifest.json.1234.abcdef12.tmp');
      writeFileSync(manifestTemp, 'manifest temp that a live manifest-only render may own');
      removeArtifactStagingFiles(join(dir, 'clip.mp4'));
      expect(existsSync(manifestTemp)).toBe(true);
      removeArtifactStagingFiles(join(dir, 'clip.mp4.manifest.json'));
      expect(existsSync(manifestTemp)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps files that only share the target prefix: a backup, another target, a short name, and user files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-staging-prefix-'));
    try {
      const target = join(dir, 'clip.mp4');
      const ownPartial = join(dir, '.clip.mp4.1234.abcdef12.partial');
      const kept = [
        join(dir, '.clip.mp4.1234.abcdef12.backup'),
        join(dir, '.clip.mp4.other.mp4.1234.abcdef12.partial'),
        join(dir, '.clip.mp4.1234.a.partial'),
        join(dir, '.clip.mp4.interrupted.partial'),
        join(dir, '.clip.mp4.notes.tmp'),
      ];
      writeFileSync(ownPartial, 'own partial');
      for (const file of kept) writeFileSync(file, file);
      removeArtifactStagingFiles(target);
      expect(existsSync(ownPartial)).toBe(false);
      for (const file of kept) expect(readFileSync(file, 'utf8')).toBe(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['the same path', (path: string): string => path, '.interrupted.partial', false],
    [
      'another spelling of the same file',
      (path: string): string => path.replace(/([\\/])([^\\/]+)$/u, '$1.$1$2'),
      '.interrupted.partial',
      false,
    ],
    [
      'a generated partial name whose dead owner is replaced',
      (path: string): string => path,
      '.1234.abcdef12.partial',
      true,
    ],
  ])(
    'refuses a dead output lock whose partial path is a journal path (%s), leaving every file',
    async (_label, spell, stagedSuffix, staleOwner) => {
      const dir = mkdtempSync(join(tmpdir(), 'joy-render-alias-journal-'));
      const mediaName = 'alias.mp4';
      const mediaPath = join(dir, mediaName);
      const manifestPath = join(dir, `${mediaName}.manifest.json`);
      const lockPath = join(dir, `.${mediaName}.render.lock`);
      const stagedMediaPath = join(dir, `.${mediaName}${stagedSuffix}`);
      const mediaBackup = join(dir, `.${mediaName}.interrupted.backup`);
      const inputPath = join(dir, 'input.mp4');
      writeFileSync(inputPath, 'probe fixture');
      writeFileSync(stagedMediaPath, 'staged partial that must survive');
      writeFileSync(mediaBackup, 'backup that must survive');
      if (staleOwner) {
        // A dead owner makes the claim replace its record, which used to clean staging early.
        writeFileSync(
          `${mediaPath}.owner`,
          JSON.stringify({ pid: 2_147_000_000, token: 'dead-owner-alias', createdAt: 1 }),
        );
      }
      // The output file and its lock are named after the project id, so the id must be "alias".
      const project = createDefaultProject('Alias journal', { id: 'alias' });
      const root = project.compositions['root'] as unknown as {
        tracks: Array<{ clips: unknown[] }>;
      };
      root.tracks[0]!.clips.push({
        id: 'alias-clip',
        kind: 'video',
        assetId: inputPath,
        startUs: 0,
        durationUs: 1_000_000,
        sourceInUs: 0,
      });
      (project.assets as Record<string, unknown>)[inputPath] = { id: inputPath, kind: 'video' };
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: 2_147_000_000,
          token: 'dead-alias-journal',
          startedAt: new Date(1).toISOString(),
          activePartialPath: spell(stagedMediaPath),
          transaction: {
            phase: 'committing',
            mediaPath,
            stagedMediaPath,
            mediaBackup,
            hadMedia: true,
            manifestPath,
            stagedManifestPath: join(dir, `.${mediaName}.manifest.json.interrupted.tmp`),
            manifestBackup: join(dir, `.${mediaName}.manifest.json.interrupted.backup`),
            hadManifest: false,
          },
        }),
      );
      const originalLock = readFileSync(lockPath);
      const capture = new StringWritable();
      const restore = redirectStdout(capture);
      setMediaProbeSpawnForTests(() => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exitCode: null as number | null,
          kill: vi.fn(() => true),
        });
        setTimeout(() => {
          child.stdout.end(
            JSON.stringify({
              streams: [{ codec_type: 'video', width: 320, height: 240, pix_fmt: 'yuv420p' }],
              format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.0' },
            }),
          );
          child.exitCode = 0;
          child.emit('close', 0, null);
        }, 0);
        return child as never;
      });
      try {
        const result = await runHeadlessRender({
          project,
          preset: 'mp4',
          outDir: dir,
          concurrency: 1,
          json: true,
        });
        expect(result.exitCode).toBe(1);
        const event = JSON.parse(capture.text().trim().split('\n').at(-1)!) as {
          code: string;
          message: string;
        };
        expect(event.code).toBe('output');
        expect(event.message).toContain('also a journal path');
        expect(readFileSync(stagedMediaPath, 'utf8')).toBe('staged partial that must survive');
        expect(readFileSync(mediaBackup, 'utf8')).toBe('backup that must survive');
        expect(readFileSync(lockPath)).toEqual(originalLock);
      } finally {
        restore();
        setMediaProbeSpawnForTests(undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('recovers a dead artifact owner, removes its staging files, and renders', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-dead-owner-'));
    const target = join(dir, 'dead-owner.mp4.manifest.json');
    const staging = join(dir, '.dead-owner.mp4.manifest.json.1234.abcdef12.tmp');
    writeFileSync(
      `${target}.owner`,
      JSON.stringify({ pid: 2_147_000_000, token: 'dead-owner', createdAt: 1 }),
    );
    writeFileSync(staging, 'partial');
    const project = createDefaultProject('Dead owner', { id: 'dead-owner' });
    const root = project.compositions['root'] as unknown as { tracks: Array<{ clips: unknown[] }> };
    root.tracks[0]!.clips.push({
      id: 'clip',
      kind: 'video',
      assetId: 'missing-media',
      startUs: 0,
      durationUs: 1_000_000,
    });
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: dir,
        concurrency: 1,
        json: true,
        manifestOnly: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.artifactPath).toBe(target);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(staging)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not run journal recovery while a manifest-only result is owned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-owner-journal-order-'));
    const manifestPath = join(dir, 'manifest-guard.mp4.manifest.json');
    const mediaPath = join(dir, 'input.mp4');
    writeFileSync(mediaPath, 'probe fixture');
    const manifestOnlyProject = createDefaultProject('Manifest guard', { id: 'manifest-guard' });
    const manifestOnlyRoot = manifestOnlyProject.compositions['root'] as unknown as {
      tracks: Array<{ clips: unknown[] }>;
    };
    manifestOnlyRoot.tracks[0]!.clips.push({
      id: 'manifest-only-clip',
      kind: 'video',
      assetId: 'missing-media',
      startUs: 0,
      durationUs: 1_000_000,
    });
    const manifestOnly = await runHeadlessRender({
      project: manifestOnlyProject,
      preset: 'mp4',
      outDir: dir,
      concurrency: 1,
      json: true,
      manifestOnly: true,
    });
    expect(manifestOnly.exitCode).toBe(0);
    const manifestFromManifestOnlyRender = readFileSync(manifestPath);
    const mediaName = 'manifest-guard.mp4';
    const stagedMediaPath = join(dir, `.${mediaName}.interrupted.partial`);
    const mediaBackup = join(dir, `.${mediaName}.interrupted.backup`);
    const stagedManifestPath = join(dir, `.manifest-guard.mp4.manifest.json.interrupted.tmp`);
    const manifestBackup = join(dir, `.manifest-guard.mp4.manifest.json.interrupted.backup`);
    writeFileSync(manifestBackup, 'older journal backup');
    writeFileSync(
      `${manifestPath}.owner`,
      JSON.stringify({
        pid: process.pid,
        token: 'manifest-only-render-owner',
        createdAt: Date.now(),
      }),
    );
    writeFileSync(
      join(dir, `.${mediaName}.render.lock`),
      JSON.stringify({
        pid: 2_147_000_000,
        token: 'dead-render-lock',
        startedAt: new Date(1).toISOString(),
        activePartialPath: null,
        transaction: {
          phase: 'committing',
          mediaPath: join(dir, mediaName),
          stagedMediaPath,
          mediaBackup,
          hadMedia: false,
          manifestPath,
          stagedManifestPath,
          manifestBackup,
          hadManifest: true,
        },
      }),
    );

    const project = createDefaultProject('Manifest guard', { id: 'manifest-guard' });
    const root = project.compositions['root'] as unknown as { tracks: Array<{ clips: unknown[] }> };
    root.tracks[0]!.clips.push({
      id: 'guard-clip',
      kind: 'video',
      assetId: mediaPath,
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    });
    (project.assets as Record<string, unknown>)[mediaPath] = { id: mediaPath, kind: 'video' };
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    setMediaProbeSpawnForTests(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        kill: vi.fn(() => true),
      });
      setTimeout(() => {
        child.stdout.end(
          JSON.stringify({
            streams: [{ codec_type: 'video', width: 320, height: 240, pix_fmt: 'yuv420p' }],
            format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.0' },
          }),
        );
        child.exitCode = 0;
        child.emit('close', 0, null);
      }, 0);
      return child as never;
    });
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: dir,
        concurrency: 1,
        json: true,
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(capture.text().trim())).toMatchObject({
        code: 'RENDER_OUTPUT_BUSY',
      });
      expect(readFileSync(manifestPath)).toEqual(manifestFromManifestOnlyRender);
      expect(readFileSync(manifestBackup, 'utf8')).toBe('older journal backup');
    } finally {
      restore();
      setMediaProbeSpawnForTests(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a manifest target that is also a media input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-manifest-collision-'));
    const media = join(dir, 'collision.mp4.manifest.json');
    writeFileSync(media, 'original media');
    const project = createDefaultProject('Collision', { id: 'collision' });
    (project.assets as Record<string, unknown>)[media] = { id: media, kind: 'video' };
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: dir,
        concurrency: 1,
        json: true,
        manifestOnly: true,
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(capture.text().trim()).code).toBe('RENDER_OUTPUT_COLLIDES_WITH_INPUT');
      expect(readFileSync(media, 'utf8')).toBe('original media');
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a manifest-only output that resolves to an input at the manifest path', async () => {
    const directory = mkdtempSync(join(tempDir, 'render-output-collision-'));
    const inputPath = join(directory, 'collision.mp4.manifest.json');
    const original = Buffer.from('original input bytes');
    writeFileSync(inputPath, original);
    const project = createDefaultProject('Collision', { id: 'collision' });
    (project.assets as Record<string, unknown>)[inputPath] = { id: inputPath, kind: 'video' };
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: directory,
        concurrency: 1,
        json: true,
      });
      expect(result.exitCode).toBe(1);
      const event = JSON.parse(capture.text().trim()) as { code: string; message: string };
      expect(event.code).toBe('RENDER_OUTPUT_COLLIDES_WITH_INPUT');
      expect(event.message).toContain(inputPath);
      expect(readFileSync(inputPath)).toEqual(original);
    } finally {
      restore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses real media output that resolves to a video input before rendering', async () => {
    const directory = mkdtempSync(join(tempDir, 'render-media-output-collision-'));
    const mediaPath = join(directory, 'collision.mp4');
    const manifestPath = `${mediaPath}.manifest.json`;
    const original = Buffer.from('placeholder input bytes, deliberately not a video');
    writeFileSync(mediaPath, original);
    const project = createDefaultProject('Collision', { id: 'collision' });
    const root = project.compositions['root'] as unknown as {
      tracks: Array<{ clips: unknown[] }>;
    };
    root.tracks[0]!.clips.push({
      id: 'collision-video',
      kind: 'video',
      assetId: mediaPath,
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    });
    (project.assets as Record<string, unknown>)[mediaPath] = { id: mediaPath, kind: 'video' };
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    let mediaProbes = 0;
    setMediaProbeSpawnForTests(() => {
      mediaProbes++;
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        kill: vi.fn(() => true),
      });
      setTimeout(() => {
        child.stdout.end(
          JSON.stringify({
            streams: [{ codec_type: 'video', width: 320, height: 240, pix_fmt: 'yuv420p' }],
            format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.0' },
          }),
        );
        child.exitCode = 0;
        child.emit('close', 0, null);
      }, 0);
      return child as never;
    });
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: directory,
        concurrency: 1,
        json: true,
      });
      expect(result.exitCode).toBe(1);
      const event = JSON.parse(capture.text().trim()) as { code: string; message: string };
      expect(event.code).toBe('RENDER_OUTPUT_COLLIDES_WITH_INPUT');
      expect(event.message).toContain(mediaPath);
      expect(readFileSync(mediaPath)).toEqual(original);
      expect(existsSync(manifestPath)).toBe(false);
      expect(mediaProbes).toBe(1);
    } finally {
      restore();
      setMediaProbeSpawnForTests(undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a preview path that equals an inactive registered asset', async () => {
    const directory = mkdtempSync(join(tempDir, 'render-preview-inactive-collision-'));
    const activePath = join(directory, 'active.mp4');
    const previewPath = join(directory, 'preview-0.png');
    const original = Buffer.from('inactive asset bytes');
    writeFileSync(activePath, 'active media bytes');
    writeFileSync(previewPath, original);
    const project = createDefaultProject('Preview collision');
    const root = project.compositions['root'] as unknown as { tracks: Array<{ clips: unknown[] }> };
    root.tracks[0]!.clips.push({
      id: 'active-clip',
      kind: 'video',
      assetId: activePath,
      startUs: 0,
      durationUs: 1_000_000,
    });
    (project.assets as Record<string, unknown>)[activePath] = { id: activePath, kind: 'video' };
    (project.assets as Record<string, unknown>)[previewPath] = { id: previewPath, kind: 'video' };
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    setMediaProbeSpawnForTests(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        kill: vi.fn(() => true),
      });
      setTimeout(() => {
        child.stdout.end(
          JSON.stringify({
            streams: [{ codec_type: 'video', width: 320, height: 240, pix_fmt: 'yuv420p' }],
            format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.0' },
          }),
        );
        child.exitCode = 0;
        child.emit('close', 0, null);
      }, 0);
      return child as never;
    });
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: directory,
        concurrency: 1,
        json: true,
        frameUs: 0,
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(capture.text().trim()).code).toBe('RENDER_OUTPUT_COLLIDES_WITH_INPUT');
      expect(readFileSync(previewPath)).toEqual(original);
    } finally {
      restore();
      setMediaProbeSpawnForTests(undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a PNG preview without IDAT image data', () => {
    const directory = mkdtempSync(join(tempDir, 'empty-png-preview-'));
    const artifactPath = join(directory, 'preview-0.png');
    const stagingPath = join(directory, '.preview-0-staging.png');
    const validPng = encodeRgbaPng(1, 1, Uint8Array.from([1, 2, 3, 255]));
    const png = Buffer.concat([
      validPng.subarray(0, 8),
      validPng.subarray(8, 33),
      validPng.subarray(validPng.length - 12),
    ]);
    try {
      writeFileSync(stagingPath, png);
      expect(
        publishPreviewAtomically(stagingPath, artifactPath, new AbortController().signal, 1, 1),
      ).toBe(false);
      expect(existsSync(artifactPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a PNG preview with a truncated IDAT chunk', () => {
    const directory = mkdtempSync(join(tempDir, 'truncated-png-preview-'));
    const artifactPath = join(directory, 'preview-0.png');
    const stagingPath = join(directory, '.preview-0-staging.png');
    const validPng = encodeRgbaPng(1, 1, Uint8Array.from([1, 2, 3, 255]));
    try {
      writeFileSync(stagingPath, validPng.subarray(0, validPng.length - 15));
      expect(
        publishPreviewAtomically(stagingPath, artifactPath, new AbortController().signal, 1, 1),
      ).toBe(false);
      expect(existsSync(artifactPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!HAS_FFMPEG)('publishes a complete PNG written by FFmpeg', () => {
    const directory = mkdtempSync(join(tempDir, 'ffmpeg-png-preview-'));
    const artifactPath = join(directory, 'preview-0.png');
    const stagingPath = join(directory, '.preview-0-staging.png');
    try {
      const encoded = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=2x2:d=0.1',
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-vcodec',
          'png',
          'pipe:1',
        ],
        { encoding: 'buffer' },
      );
      expect(encoded.status, encoded.stderr.toString()).toBe(0);
      writeFileSync(stagingPath, encoded.stdout);
      expect(
        publishPreviewAtomically(stagingPath, artifactPath, new AbortController().signal, 2, 2),
      ).toBe(true);
      expect(existsSync(artifactPath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains ASS directory ownership when writing the ASS file throws', () => {
    const ownedDirectories: string[] = [];
    const plan = {
      mode: 'media',
      clips: [],
      captions: [{ text: 'Caption', startUs: 0, endUs: 1_000_000 }],
      fontFile: 'font.ttf',
      assDocument: '[Events]',
      width: 320,
      height: 180,
      fps: '30/1',
      durationUs: 1_000_000,
      warnings: [],
    } as never;
    setAssFileWriterForTests(() => {
      throw new Error('ASS write failed');
    });
    try {
      expect(() =>
        buildFfmpegArgs(
          plan,
          'mp4',
          join(tempDir, 'ass-output.mp4'),
          [],
          undefined,
          ownedDirectories,
        ),
      ).toThrow('ASS write failed');
      expect(ownedDirectories).toHaveLength(1);
      expect(existsSync(ownedDirectories[0]!)).toBe(true);
    } finally {
      setAssFileWriterForTests(undefined);
      for (const directory of ownedDirectories) rmSync(directory, { recursive: true, force: true });
    }
    expect(existsSync(ownedDirectories[0]!)).toBe(false);
  });

  it('excludes title instances bound to disabled tracks', () => {
    const project = {
      schemaVersion: 1,
      rootCompositionId: 'root',
      assets: {},
      compositions: {
        root: {
          tracks: [
            {
              id: 'disabled',
              kind: 'video',
              enabled: false,
              clips: [{ id: 'title-clip', startUs: 0, durationUs: 1_000_000 }],
            },
            {
              id: 'enabled',
              kind: 'video',
              enabled: true,
              clips: [{ id: 'other-clip', startUs: 0, durationUs: 1_000_000 }],
            },
          ],
        },
      },
      pluginData: {
        'joy.contentTemplates': {
          instances: {
            title: { clipId: 'title-clip' },
          },
        },
      },
    } as never;
    expect(collectTitleSources(project)).toEqual([]);
  });

  it('keeps title stacking in normalized order when the track array is reordered', () => {
    const forward = timelineOrderProject(['low', 'high']);
    const reversed = timelineOrderProject(['high', 'low']);
    const desktopItems = normalizeUniversalTimeline(reversed).items;

    expect(
      collectTitleSources(forward).map((source) => [source.instanceId, source.trackOrder]),
    ).toEqual([
      ['title-low', 0],
      ['title-high', 1],
    ]);
    expect(
      collectTitleSources(reversed).map((source) => [source.instanceId, source.trackOrder]),
    ).toEqual(collectTitleSources(forward).map((source) => [source.instanceId, source.trackOrder]));
    expect(desktopItems.filter((item) => item.trackEnabled).map((item) => item.trackOrder)).toEqual(
      [0, 1],
    );
  });

  it('honors an authoritative deck row that disables a title track', () => {
    const project = timelineOrderProject(['low', 'high'], 'low');
    const desktopItems = normalizeUniversalTimeline(project).items;

    expect(collectTitleSources(project).map((source) => source.instanceId)).toEqual(['title-high']);
    expect(desktopItems.find((item) => item.trackId === 'low')?.trackEnabled).toBe(false);
  });

  it('uses deck activation for title source collection and preparation refusal when raw track is disabled', async () => {
    const project = createDefaultProject('Deck enabled title');
    const composition = project.compositions['root'] as unknown as {
      tracks: Array<{ id: string; enabled?: boolean; clips: Array<{ id: string }> }>;
    };
    const track = composition.tracks[0]!;
    const clip = {
      id: 'deck-title',
      kind: 'video',
      assetId: 'asset-default',
      startUs: 0,
      durationUs: 1_000_000,
    };
    track.clips.push(clip as never);
    track.enabled = false;
    const mutableProject = project as unknown as {
      timelineTrackDeck?: unknown;
      pluginData: Record<string, unknown>;
    };
    mutableProject.timelineTrackDeck = {
      rows: [{ compositionId: 'root', trackId: track.id, order: 0, enabled: true, locked: false }],
    };
    mutableProject.pluginData['joy.contentTemplates'] = {
      instances: {
        title: {
          clipId: clip.id,
          objectId: 'title-object',
          lines: { primary: 'Title' },
          font: { sha256: 'sha256:test' },
          layout: {},
        },
      },
    };

    expect(collectTitleSources(project).map((source) => source.instanceId)).toEqual(['title']);
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: join(outDir, 'deck-enabled-title'),
        concurrency: 1,
        json: true,
        manifestOnly: true,
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(capture.text().trim()).code).toBe('RENDER_PREPARATION_REQUIRED');
    } finally {
      restore();
    }
  });

  it('exposes mp4/webm/prores render presets with deterministic specs', () => {
    expect(isRenderPresetId('mp4')).toBe(true);
    expect(isRenderPresetId('webm')).toBe(true);
    expect(isRenderPresetId('prores')).toBe(true);
    expect(isRenderPresetId('flac')).toBe(false);

    expect(RENDER_PRESETS.mp4.container).toBe('mp4');
    expect(RENDER_PRESETS.mp4.videoCodec).toBe('h264');
    expect(RENDER_PRESETS.webm.container).toBe('webm');
    expect(RENDER_PRESETS.prores.videoCodec).toBe('prores-ks');
  });

  it('handles render command with explicit project id and writes manifest', async () => {
    const project = createDefaultProject('Render Cmd Test Project');
    const root = project.compositions['root'] as unknown as {
      tracks: Array<{ id: string; clips: unknown[] }>;
    };
    for (const t of root.tracks) {
      t.clips.push({
        id: `render-clip-${t.id}-1`,
        kind: 'video',
        assetId: 'asset-default',
        startUs: 0,
        durationUs: 2_000_000,
        sourceInUs: 0,
      });
      t.clips.push({
        id: `render-clip-${t.id}-2`,
        kind: 'video',
        assetId: 'asset-default',
        startUs: 2_000_000,
        durationUs: 1_000_000,
        sourceInUs: 0,
      });
    }
    saveProject(project, { source: 'sqlite', path: testDbPath, revision: 0 });

    const code = await runCli([
      'render',
      '--project',
      project.id,
      '--preset',
      'mp4',
      '--out',
      outDir,
      '--sqlite-path',
      testDbPath,
    ]);
    expect(code).toBe(0);

    const expectedManifest = join(outDir, `${project.id}.mp4.manifest.json`);
    expect(existsSync(expectedManifest)).toBe(true);
    const manifest = JSON.parse(readFileSync(expectedManifest, 'utf8'));
    expect(manifest.projectId).toBe(project.id);
    expect(manifest.preset).toBe('mp4');
    expect(manifest.totalClips).toBeGreaterThan(0);
    expect(manifest.totalFrames).toBeGreaterThan(0);
  });

  it('streams newline-delimited JSON events when --json is set', async () => {
    const project = createDefaultProject('JSON Render Project');
    const root = project.compositions['root'] as unknown as {
      tracks: Array<{ id: string; clips: unknown[] }>;
    };
    for (const t of root.tracks) {
      t.clips.push({
        id: `json-clip-${t.id}`,
        kind: 'video',
        assetId: 'asset-default',
        startUs: 0,
        durationUs: 500_000,
        sourceInUs: 0,
      });
    }
    saveProject(project, { source: 'sqlite', path: testDbPath, revision: 0 });

    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    let result;
    try {
      result = await runHeadlessRender({
        project,
        preset: 'webm',
        outDir: join(outDir, 'json'),
        concurrency: 2,
        json: true,
      });
    } finally {
      restore();
    }

    expect(result.exitCode).toBe(0);
    expect(result.preset).toBe('webm');
    expect(result.totalClips).toBeGreaterThan(0);

    const lines = capture
      .text()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const parsed = lines.map((line) => JSON.parse(line));
    const types = parsed.map((e: { type: string }) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('complete');

    const start = parsed.find(
      (e: { type: string; projectId: string }) => e.type === 'start' && e.projectId === project.id,
    );
    expect(start).toBeDefined();
    expect(start.preset).toBe('webm');

    const complete = parsed.find(
      (e: { type: string; projectId: string }) =>
        e.type === 'complete' && e.projectId === project.id,
    );
    expect(complete).toBeDefined();
    expect(complete.artifactPath).toContain(project.id);
  });

  it('rejects unknown preset names with exit code 2', async () => {
    const project = createDefaultProject('Bad Preset Project');
    saveProject(project, { source: 'sqlite', path: testDbPath, revision: 0 });

    const code = await runCli([
      'render',
      '--project',
      project.id,
      '--preset',
      'avi',
      '--sqlite-path',
      testDbPath,
    ]);
    expect(code).toBe(2);
  });

  it('requires --project flag', async () => {
    const code = await runCli(['render', '--preset', 'mp4']);
    expect(code).toBe(1);
  });

  it('handleRenderCommand wires through runHeadlessRender with json mode', async () => {
    const project = createDefaultProject('Wired Render Project');
    saveProject(project, { source: 'sqlite', path: testDbPath, revision: 0 });

    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    try {
      const code = await handleRenderCommand([], {
        project: project.id,
        preset: 'prores',
        out: join(outDir, 'wired'),
        concurrency: 1,
        json: true,
        // An empty project only succeeds as a plan; a real render of it is a failure.
        manifestOnly: true,
        sqlitePath: testDbPath,
      } as unknown as Parameters<typeof handleRenderCommand>[1]);
      expect(code).toBe(0);
    } finally {
      restore();
    }
    const events = capture
      .text()
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(events.some((e: { type: string }) => e.type === 'start')).toBe(true);
    expect(
      events.some(
        (e: { type: string; preset: string }) => e.type === 'start' && e.preset === 'prores',
      ),
    ).toBe(true);
  });
});

function planDoc(
  tracks: Array<Record<string, unknown>>,
  extra: { width?: number; height?: number; fps?: number } = {},
): unknown {
  return {
    id: 'plan-doc',
    title: 'Plan doc',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        width: extra.width ?? 1080,
        height: extra.height ?? 1920,
        frameRate: { num: extra.fps ?? 30, den: 1 },
        durationUs: 10_000_000,
        tracks,
      },
    },
  };
}

describe('planRender (pure planning of a project document)', () => {
  const mp4 = RENDER_PRESETS.mp4;

  it('allots round(duration x fps) frames, at least one, with contiguous first-frame offsets', () => {
    const plan = planRender(
      planDoc([
        {
          id: 't1',
          clips: [
            { id: 'tiny', startUs: 0, durationUs: 1_000 },
            { id: 'half-up', startUs: 0, durationUs: 50_000 },
            { id: 'second', startUs: 0, durationUs: 1_000_000 },
          ],
        },
        { id: 't2', clips: [{ id: 'other-track', startUs: 0, durationUs: 2_000_000 }] },
      ]),
      mp4,
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.clips.map((c) => [c.clipId, c.frames, c.firstFrame])).toEqual([
      ['tiny', 1, 0],
      ['half-up', 2, 1],
      ['second', 30, 3],
      ['other-track', 60, 33],
    ]);
    expect(plan.totalFrames).toBe(93);
    expect(plan.warnings).toEqual([]);
  });

  it('skips disabled tracks and says so', () => {
    const plan = planRender(
      planDoc([
        { id: 'off', enabled: false, clips: [{ id: 'ghost', durationUs: 1_000_000 }] },
        { id: 'on', enabled: true, clips: [{ id: 'real', durationUs: 1_000_000 }] },
      ]),
      mp4,
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.clips.map((c) => c.clipId)).toEqual(['real']);
    expect(plan.warnings).toEqual(['Skipped disabled track "off" (1 clip(s)).']);
  });

  it('honors disabled track deck rows when planning clips', () => {
    const deckProject = timelineOrderProject(['low', 'high'], 'low') as Record<string, unknown>;
    deckProject['id'] = 'deck-plan';
    const plan = planRender(deckProject, mp4);

    if (!plan.ok) throw new Error(plan.message);
    expect(plan.clips.map((clip) => clip.clipId)).toEqual(['clip-high']);
  });

  it('warns once when the composition differs from the preset shape or rate', () => {
    const plan = planRender(
      planDoc([{ id: 't', clips: [{ id: 'c', durationUs: 1_000_000 }] }], {
        width: 1920,
        height: 1080,
        fps: 60,
      }),
      mp4,
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.composition).toMatchObject({ width: 1920, height: 1080, fps: 60 });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/1920x1080 @ 60 fps.*1080x1920 @ 30 fps/);
  });

  it('refuses documents that are not projects instead of throwing', () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /not a JOY Media project/],
      [[], /not a JOY Media project/],
      [{ compositions: {}, rootCompositionId: 'root' }, /no "id"/],
      [{ id: 'x', rootCompositionId: 'root' }, /compositions/],
      [{ id: 'x', rootCompositionId: 'nope', compositions: { root: {} } }, /"nope"/],
      [planDoc([{ clips: [] }]), /track #1 is missing its "id"/],
      [
        planDoc([{ id: 't', clips: [{ durationUs: 1 }] }]),
        /clip #1 on track "t" is missing its "id"/,
      ],
    ];
    for (const [doc, message] of cases) {
      const plan = planRender(doc, mp4);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.message).toMatch(message);
    }
  });

  it('refuses impossible clip durations (negative, text, missing, non-finite, over 24 h)', () => {
    for (const durationUs of [-1, 'soon', null, undefined, Number.NaN, MAX_CLIP_DURATION_US + 1]) {
      const plan = planRender(planDoc([{ id: 't', clips: [{ id: 'bad', durationUs }] }]), mp4);
      expect(plan.ok, String(durationUs)).toBe(false);
      if (!plan.ok)
        expect(plan.message).toMatch(/clip "bad" on track "t" has an invalid durationUs/);
    }
    const edge = planRender(
      planDoc([{ id: 't', clips: [{ id: 'max', durationUs: MAX_CLIP_DURATION_US }] }]),
      mp4,
    );
    expect(edge.ok).toBe(true);
  });
});

describe('safeFileStem', () => {
  it('leaves ordinary project ids alone and defuses path tricks', () => {
    expect(safeFileStem('proj-mv7zifcl')).toBe('proj-mv7zifcl');
    expect(safeFileStem('v1.2_final')).toBe('v1.2_final');
    expect(safeFileStem('../../escape')).not.toMatch(/[\\/]/);
    expect(safeFileStem('../../escape').startsWith('.')).toBe(false);
    expect(safeFileStem('..')).toBe('__');
    expect(safeFileStem('a/b\\c:d')).toBe('a_b_c_d');
    expect(safeFileStem('x'.repeat(500)).length).toBe(120);
  });
});

describe('runHeadlessRender writes an honest, atomic, deterministic manifest', () => {
  function timelineProject(id: string): ReturnType<typeof createDefaultProject> {
    const project = createDefaultProject('Honest', { id });
    const root = project.compositions['root'] as unknown as {
      tracks: Array<{ id: string; clips: unknown[] }>;
    };
    root.tracks[0]!.clips.push(
      { id: 'a', kind: 'video', assetId: 'x', startUs: 0, durationUs: 2_000_000, sourceInUs: 0 },
      {
        id: 'b',
        kind: 'video',
        assetId: 'x',
        startUs: 2_000_000,
        durationUs: 500_000,
        sourceInUs: 0,
      },
    );
    root.tracks[1]!.clips.push({
      id: 'c',
      kind: 'video',
      assetId: 'x',
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
    });
    return project;
  }

  it('says no media was produced, in the result and in the manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-honest-'));
    try {
      const capture = new StringWritable();
      const restore = redirectStdout(capture);
      let result;
      try {
        result = await runHeadlessRender({
          project: timelineProject('honest-1'),
          preset: 'mp4',
          outDir: dir,
          concurrency: 2,
          json: true,
        });
      } finally {
        restore();
      }
      expect(result.exitCode).toBe(0);
      expect(result.mediaProduced).toBe(false);
      expect(result.manifestWritten).toBe(true);
      expect(readdirSync(dir)).toEqual(['honest-1.mp4.manifest.json']);

      const manifest = JSON.parse(readFileSync(result.artifactPath, 'utf8'));
      expect(manifest).toMatchObject({
        mediaProduced: false,
        mediaFile: null,
        note: MANIFEST_ONLY_MESSAGE,
      });

      const events = capture
        .text()
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      expect(events[events.length - 1]).toMatchObject({
        type: 'complete',
        mediaProduced: false,
        manifestWritten: true,
        message: MANIFEST_ONLY_MESSAGE,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not change the project input digest while rendering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-input-digest-'));
    const project = timelineProject('input-digest-1');
    const digestBefore = renderInputsDigest(project);
    try {
      const result = await runHeadlessRender({
        project,
        preset: 'mp4',
        outDir: dir,
        concurrency: 2,
        json: true,
        manifestOnly: true,
      });
      expect(result.exitCode).toBe(0);
      expect(renderInputsDigest(project)).toBe(digestBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a non-negative render duration when the wall clock moves backwards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-clock-'));
    const capture = new StringWritable();
    const restore = redirectStdout(capture);
    const wallClock = vi.spyOn(Date, 'now');
    wallClock.mockReturnValueOnce(1_000).mockReturnValueOnce(900);
    try {
      const result = await runHeadlessRender({
        project: timelineProject('clock-backwards-1'),
        preset: 'mp4',
        outDir: dir,
        concurrency: 1,
        json: true,
      });
      const complete = capture
        .text()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .at(-1)!;
      const manifest = JSON.parse(readFileSync(result.artifactPath, 'utf8')) as {
        durationMs: number;
      };

      expect(result.exitCode).toBe(0);
      expect(complete).toMatchObject({ type: 'complete', durationMs: result.durationMs });
      expect(cliSchemaErrors('render-event.v1.schema.json', complete)).toEqual([]);
      expect(complete.durationMs).toBeGreaterThanOrEqual(0);
      expect(manifest.durationMs).toBe(result.durationMs);
    } finally {
      restore();
      wallClock.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plans identically at every concurrency (frame ranges never depend on worker order)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-conc-'));
    try {
      const plans: unknown[] = [];
      for (const concurrency of [1, 3, 32]) {
        const capture = new StringWritable();
        const restore = redirectStdout(capture);
        try {
          const result = await runHeadlessRender({
            project: timelineProject('conc-1'),
            preset: 'mp4',
            outDir: join(dir, String(concurrency)),
            concurrency,
            json: true,
          });
          const {
            durationMs: _d,
            renderedAt: _r,
            ...rest
          } = JSON.parse(readFileSync(result.artifactPath, 'utf8'));
          plans.push(rest);
        } finally {
          restore();
        }
      }
      expect(plans[1]).toEqual(plans[0]);
      expect(plans[2]).toEqual(plans[0]);
      const clips = (plans[0] as { clips: Array<{ frameRange: { first: number; last: number } }> })
        .clips;
      expect(clips.map((c) => [c.frameRange.first, c.frameRange.last])).toEqual([
        [0, 59],
        [60, 74],
        [75, 104],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('draws the progress bar only when asked, never in --json mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-progress-'));
    try {
      const run = async (json: boolean, progress: boolean): Promise<string> => {
        const capture = new StringWritable();
        const restore = redirectStdout(capture);
        try {
          await runHeadlessRender({
            project: timelineProject('progress-1'),
            preset: 'mp4',
            outDir: dir,
            concurrency: 2,
            json,
            progress,
          });
        } finally {
          restore();
        }
        return capture.text();
      };
      expect(await run(false, true)).toContain('\r');
      expect(await run(false, false)).not.toContain('\r');
      expect(await run(true, true)).not.toContain('\r');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails before announcing any work when --out is a file, and leaves the file alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-render-outfile-'));
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'keep me', 'utf8');
    try {
      const capture = new StringWritable();
      const restore = redirectStdout(capture);
      let result;
      try {
        result = await runHeadlessRender({
          project: timelineProject('outfile-1'),
          preset: 'mp4',
          outDir: file,
          concurrency: 2,
          json: true,
        });
      } finally {
        restore();
      }
      expect(result.exitCode).toBe(1);
      const events = capture
        .text()
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      expect(events.map((e) => e.type)).toEqual(['error']);
      expect(events[0].code).toBe('output');
      expect(readFileSync(file, 'utf8')).toBe('keep me');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
