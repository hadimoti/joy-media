import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runCli } from '../cli.js';
import {
  handleRenderCommand,
  isRenderPresetId,
  MANIFEST_ONLY_MESSAGE,
  MAX_CLIP_DURATION_US,
  planRender,
  RENDER_PRESETS,
  runHeadlessRender,
  safeFileStem,
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
