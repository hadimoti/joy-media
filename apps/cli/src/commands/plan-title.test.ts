import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import { runCli } from '../cli.js';
import { setTitleTextMeasurer } from '../services/prepared-title.js';
import { preparedPlanId } from '../services/prepared-edit.js';
import { findChromiumExecutable } from '@joy-media/html-scene-runtime';
import { loadNotoSansArabicFaces } from '@joy-media/html-scene-runtime';
import {
  setRenderPreparationFactsProviderForTests,
  type RenderPreparationFacts,
} from '../services/render-preparation.js';

const usableFacts: RenderPreparationFacts = {
  libassProbe: {
    usable: true,
    executablePath: 'ffmpeg',
    canonicalFace: 'Noto Sans Arabic Arabic 400',
    log: '',
  },
  libassAvailable: true,
  canonicalFaces: loadNotoSansArabicFaces(),
  chromium: {
    launchable: true,
    executablePath: 'chromium',
    executableSha256: 'sha256:chromium',
    version: 'Chromium 140.0',
  },
  ffmpeg: {
    executablePath: 'ffmpeg',
    executableSha256: 'sha256:ffmpeg',
    version: 'ffmpeg version 7',
    buildConfiguration: '--enable-libass',
    requiredFilters: ['ass', 'subtitles'],
    libassVersion: '0.17',
    shaperVersion: 'harfbuzz 10',
  },
};

let dir = '';
async function call(args: string[]): Promise<{ code: number; output: string }> {
  const write = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await runCli(args), output };
  } finally {
    process.stdout.write = write;
  }
}
async function fixture(): Promise<{ path: string; project: any; revision: number }> {
  dir = mkdtempSync(join(tmpdir(), 'plan-title-'));
  const db = join(dir, 'p.sqlite'),
    path = join(dir, 'p.json');
  const created = await call(['project', 'create', 'Title test', '--sqlite-path', db, '--json']);
  const id = JSON.parse(created.output).id as string;
  await call(['project', 'export', id, '--sqlite-path', db, '--output', path, '--json']);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  return { path, project: envelope.source, revision: envelope.revision };
}
function op() {
  return {
    id: 'add-title',
    op: 'instantiateTemplate',
    instanceId: 'speaker',
    templateId: 'joy.p0.lower-third',
    trackId: 'track-v1',
    lines: { primary: 'Sara', secondary: 'Host' },
    font: { family: 'Noto Sans Arabic', weight: 700 },
    direction: 'ltr',
    startUs: 1_000_000,
    durationUs: 4_000_000,
    placement: { xPx: 64, yPx: 650, maxWidthPx: 900, safeInsetPx: 36 },
    motion: { presetId: 'hold', inUs: 0, outUs: 0 },
  };
}
async function prepare(path: string, operations: unknown, name = 'plan.json') {
  const input = join(dir, 'ops.json'),
    output = join(dir, name);
  writeFileSync(input, JSON.stringify({ schemaVersion: 1, operations }));
  const result = await call([
    'plan',
    'prepare',
    input,
    '--project',
    path,
    '--output',
    output,
    '--json',
  ]);
  return { result, output };
}
async function apply(path: string, plan: string, revision: number, key: string) {
  return call([
    'plan',
    'apply',
    plan,
    '--project',
    path,
    '--expected-revision',
    String(revision),
    '--idempotency-key',
    key,
    '--json',
  ]);
}
afterEach(() => {
  setTitleTextMeasurer(undefined);
  setRenderPreparationFactsProviderForTests(undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => setRenderPreparationFactsProviderForTests(async () => usableFacts));

describe('prepared title plan flow', () => {
  it.runIf(process.env.JOY_REQUIRE_CHROMIUM === '1' || findChromiumExecutable() !== undefined)(
    'prepares a title with the real Chromium measurer and writes frozen layout',
    async () => {
      setRenderPreparationFactsProviderForTests(async () => usableFacts);
      const f = await fixture();
      const { result, output } = await prepare(f.path, [op()], 'real-plan.json');
      expect(result.code).toBe(0);
      const plan = JSON.parse(readFileSync(output, 'utf8'));
      expect(plan.semanticsVersion).toBe(3);
      expect(plan.operations[0].resolved.layout.fontSizePx).toBeGreaterThan(0);
      expect(plan.operations[0].resolved.layout.primaryLines).toEqual(['Sara']);
    },
  );
  it('prepares and applies frozen title data and replays without a second write', async () => {
    let measurements = 0;
    setRenderPreparationFactsProviderForTests(async () => usableFacts);
    setTitleTextMeasurer((text, size) => {
      measurements += 1;
      return Array.from(text).length * size * 0.45;
    });
    const f = await fixture();
    const { result, output } = await prepare(f.path, [op()]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(readFileSync(output, 'utf8'));
    expect(plan.semanticsVersion).toBe(3);
    expect(plan.renderPreparation.version).toBe('RenderPreparationV1');
    expect(plan.renderPreparation.renderers.title).toBe('chromium-scene-surface');
    const measured = measurements;
    const first = await apply(f.path, output, f.revision, 'title-key');
    expect(first.code).toBe(0);
    const savedBytes = readFileSync(f.path);
    const saved = JSON.parse(savedBytes.toString()).project;
    expect(saved.pluginData['joy.contentTemplates'].instances.speaker).toHaveProperty(
      'layout.primaryLines',
    );
    expect(saved.visualObjects['object-speaker']).toMatchObject({
      kind: 'html-scene',
      scenePackageId: 'joy.p0.lower-third',
    });
    expect(saved.compositions.root.tracks[0].clips).toContainEqual({
      id: 'clip-speaker',
      kind: 'video',
      startUs: 1_000_000,
      durationUs: 4_000_000,
    });
    expect(saved.pluginData['joy.clipObjects']['clip-speaker']).toBe('object-speaker');
    expect(saved.pluginData['joy.renderPreparation']).toEqual(plan.renderPreparation);
    expect(saved.universalTimeline.items).toContainEqual(
      expect.objectContaining({
        id: 'clip-speaker',
        trackId: 'track-v1',
        elementKind: 'html-scene',
      }),
    );
    expect(validateJoyProjectV1({ ...saved, schemaVersion: 1 })).toEqual([]);
    setTitleTextMeasurer(undefined);
    expect((await apply(f.path, output, f.revision + 1, 'title-key')).code).toBe(0);
    expect(readFileSync(f.path)).toEqual(savedBytes);
    expect(measurements).toBe(measured);
  });

  it('refuses a caption plan before writing when the canonical libass face is unusable', async () => {
    setRenderPreparationFactsProviderForTests(undefined);
    const f = await fixture();
    const { result, output } = await prepare(f.path, [
      { id: 'caption-preflight', op: 'addCaption' },
    ]);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ code: 'SETUP_REQUIRED' });
    expect(result.output).toContain('canonical-caption-face-unavailable');
    expect(existsSync(output)).toBe(false);
  });

  it('detects changed inputs at render and refuses a missing frozen record', async () => {
    const f = await fixture();
    setTitleTextMeasurer((text, size) => Array.from(text).length * size * 0.45);
    const prepared = await prepare(f.path, [op()]);
    expect(prepared.result.code).toBe(0);
    expect((await apply(f.path, prepared.output, f.revision, 'render-record')).code).toBe(0);
    const renderArgs = [
      'render',
      '--project',
      f.path,
      '--preset',
      'mp4',
      '--out',
      join(dir, 'render'),
      '--json',
    ];
    const applied = JSON.parse(readFileSync(f.path, 'utf8'));
    applied.project.title = 'Changed after preparation';
    writeFileSync(f.path, JSON.stringify(applied));
    const drift = await call(renderArgs);
    expect(drift.output).toContain('RENDER_ENVIRONMENT_DRIFT');

    delete applied.project.pluginData['joy.renderPreparation'];
    applied.project.title = 'Title test';
    writeFileSync(f.path, JSON.stringify(applied));
    const missing = await call(renderArgs);
    expect(missing.output).toContain('RENDER_PREPARATION_REQUIRED');
  });

  it('refuses a stale revision and does not trim a managed clip', async () => {
    setTitleTextMeasurer((text, size) => Array.from(text).length * size * 0.45);
    const f = await fixture();
    const { result, output } = await prepare(f.path, [op()]);
    expect(result.code).toBe(0);
    const stale = await apply(f.path, output, f.revision + 1, 'stale-key');
    expect(JSON.parse(stale.output)).toMatchObject({ code: 'STALE_REVISION' });
    expect((await apply(f.path, output, f.revision, 'valid-key')).code).toBe(0);
    const trim = await prepare(
      f.path,
      [{ id: 'trim', op: 'trimClip', clipId: 'clip-speaker', durationUs: 500_000 }],
      'trim.json',
    );
    expect(JSON.parse(trim.result.output)).toMatchObject({ code: 'TITLE_MANAGED_CLIP' });
  });

  it('refuses direct timeline removal of a title managed clip without writing', async () => {
    setTitleTextMeasurer((text, size) => Array.from(text).length * size * 0.45);
    const f = await fixture();
    const { result, output } = await prepare(f.path, [op()]);
    expect(result.code).toBe(0);
    expect((await apply(f.path, output, f.revision, 'remove-managed')).code).toBe(0);
    const before = readFileSync(f.path);
    const removed = await call([
      'timeline',
      'remove-clip',
      '--project',
      f.path,
      '--clip',
      'clip-speaker',
      '--json',
    ]);
    expect(JSON.parse(removed.output)).toMatchObject({
      code: 'TITLE_MANAGED_CLIP',
      message:
        'Clip "clip-speaker" is managed by a title instance; edit it with plan prepare and apply.',
    });
    expect(readFileSync(f.path)).toEqual(before);
  });

  it('rejects title semantics version 1', async () => {
    setTitleTextMeasurer((text, size) => Array.from(text).length * size * 0.45);
    const f = await fixture();
    const { result, output } = await prepare(f.path, [op()]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(readFileSync(output, 'utf8'));
    plan.semanticsVersion = 1;
    plan.planId = preparedPlanId(plan);
    writeFileSync(output, JSON.stringify(plan));
    const applied = await apply(f.path, output, f.revision, 'semantics');
    expect(JSON.parse(applied.output)).toMatchObject({
      type: 'error',
      code: 'PLAN_UNSUPPORTED_SEMANTICS',
    });
  });

  it('writes nothing when frozen title validation fails', async () => {
    setTitleTextMeasurer((text, size) => Array.from(text).length * size * 0.45);
    const f = await fixture();
    const { result, output } = await prepare(f.path, [op()]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(readFileSync(output, 'utf8'));
    plan.operations[0].resolved.layout.boxHeightPx = -1;
    plan.planId = preparedPlanId(plan);
    writeFileSync(output, JSON.stringify(plan));
    const before = readFileSync(f.path);
    const applied = await apply(f.path, output, f.revision, 'invalid-frozen');
    expect(JSON.parse(applied.output)).toMatchObject({
      type: 'error',
      code: 'PROJECT_VALIDATION_FAILED',
    });
    expect(readFileSync(f.path)).toEqual(before);
  });

  it('updates text while preserving title identity and placement', async () => {
    setTitleTextMeasurer((text, size) => Array.from(text).length * size * 0.45);
    const f = await fixture();
    const created = await prepare(f.path, [op()]);
    expect(created.result.code).toBe(0);
    await apply(f.path, created.output, f.revision, 'create');
    const current = JSON.parse(readFileSync(f.path, 'utf8'));
    const before = current.project.pluginData['joy.contentTemplates'].instances.speaker;
    const beforeClip = current.project.compositions.root.tracks[0].clips.find(
      (clip: any) => clip.id === before.clipId,
    );
    const update = await prepare(
      f.path,
      [
        {
          id: 'rename',
          op: 'updateTemplateText',
          instanceId: 'speaker',
          lines: { primary: 'Sara R.' },
        },
      ],
      'update.json',
    );
    expect(update.result.code).toBe(0);
    expect(
      JSON.parse(readFileSync(update.output, 'utf8')).operations[0].resolved.lines.primary,
    ).toBe('Sara R.');
    const applied = await apply(f.path, update.output, current.revision, 'rename');
    expect(applied.code).toBe(0);
    const after = JSON.parse(readFileSync(f.path, 'utf8')).project.pluginData[
      'joy.contentTemplates'
    ].instances.speaker;
    expect(after).toMatchObject({
      objectId: before.objectId,
      clipId: before.clipId,
      motion: before.motion,
      placement: before.placement,
    });
    expect(after.lines.primary).toBe('Sara R.');
    expect(
      JSON.parse(readFileSync(f.path, 'utf8')).project.compositions.root.tracks[0].clips.find(
        (clip: any) => clip.id === after.clipId,
      ),
    ).toEqual(beforeClip);
  });
});
