import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runCli } from '../cli.js';
import {
  handleRenderCommand,
  isRenderPresetId,
  RENDER_PRESETS,
  runHeadlessRender,
} from './render-cmd.js';
import { createDefaultProject, saveProject } from '../utils/project-loader.js';

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

describe('joy render (headless batch render command)', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'joy-render-cmd-test-'));
  const testDbPath = join(tempDir, 'render-test.sqlite3');
  const outDir = join(tempDir, 'renders');

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

  it('cleans up render test artifacts', () => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore on Windows transient locks
    }
  });
});
