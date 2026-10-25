import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, type Sandbox } from '../humanized/harness.js';
import { handlePlanCommand } from './plan-cmd.js';
import { setTitleTextMeasurer } from '../services/prepared-title.js';
import { loadNotoSansArabicFaces } from '@joy-media/html-scene-runtime';
import {
  setRenderPreparationFactsProviderForTests,
  validateRenderPreparation,
  type RenderPreparationFacts,
} from '../services/render-preparation.js';
import {
  createProject,
  exportAndValidate,
  jsonError,
  singleJson,
} from '../humanized/project-helpers.js';

let sb: Sandbox;
beforeEach(() => {
  sb = createSandbox('prepared-plan');
});
afterEach(() => {
  setTitleTextMeasurer(undefined);
  setRenderPreparationFactsProviderForTests(undefined);
  sb.cleanup();
});

const preparationFacts: RenderPreparationFacts = {
  libassProbe: {
    usable: true,
    executablePath: 'ffmpeg',
    canonicalFace: 'Noto Sans Arabic Arabic 400',
    log: '',
    libassVersion: '0.17',
    shaperVersion: '10.0',
  },
  libassAvailable: true,
  canonicalFaces: loadNotoSansArabicFaces(),
  chromium: {
    launchable: true,
    executablePath: 'chromium',
    executableSha256: `sha256:${'c'.repeat(64)}`,
    version: 'Chromium 140.0',
  },
  ffmpeg: {
    executablePath: 'ffmpeg',
    executableSha256: `sha256:${'f'.repeat(64)}`,
    version: 'ffmpeg version 7',
    buildConfiguration: '--enable-libass',
    requiredFilters: ['ass', 'subtitles'],
    libassVersion: '0.17',
    shaperVersion: 'harfbuzz 10',
  },
};

interface PlanSummary {
  planId: string;
  projectId: string;
  baseRevision: number;
  resultHash: string;
  changedEntities: unknown[];
}
interface Receipt {
  projectId: string;
  planId: string;
  baseRevision: number;
  revision: number;
  replayed: boolean;
}
interface Envelope {
  revision: number;
  appliedPlans?: Record<string, unknown>;
  project: {
    title?: string;
    compositions: Record<
      string,
      {
        tracks: Array<{
          id: string;
          clips: Array<{ id: string; startUs: number; durationUs: number }>;
        }>;
      }
    >;
  };
}

async function fileProject(): Promise<{ path: string; clipA: string; clipB: string }> {
  const id = await createProject(sb, 'Prepared edit fixture');
  const path = sb.path('project.json');
  await exportAndValidate(sb, id, 'project.json');
  const first = await sb.run([
    'timeline',
    'add-clip',
    '--project',
    path,
    '--asset',
    'asset-default',
    '--start',
    '0',
    '--duration',
    '10',
    '--json',
  ]);
  expect(first.code).toBe(0);
  const firstDoc = first.json<{ clip: { id: string } }>();
  const track = await sb.run([
    'timeline',
    'add-track',
    '--project',
    path,
    '--family',
    'visual',
    '--name',
    'Video 2',
    '--json',
  ]);
  expect(track.code).toBe(0);
  const second = await sb.run([
    'timeline',
    'add-clip',
    '--project',
    path,
    '--track',
    'track-v1',
    '--asset',
    'asset-default',
    '--start',
    '12',
    '--duration',
    '5',
    '--json',
  ]);
  expect(second.code).toBe(0);
  return { path, clipA: firstDoc.clip.id, clipB: second.json<{ clip: { id: string } }>().clip.id };
}

function operations(clipA: string, clipB: string): unknown {
  return {
    schemaVersion: 1,
    operations: [
      { id: 'op-trim', op: 'trimClip', clipId: clipA, startUs: 1_000_000, durationUs: 8_000_000 },
      { id: 'op-move', op: 'moveClip', clipId: clipB, trackId: 'track-v2', startUs: 2_000_000 },
    ],
  };
}

async function prepare(
  path: string,
  ops: unknown,
  output = sb.path('plan.json'),
): Promise<PlanSummary> {
  writeFileSync(sb.path('operations.json'), JSON.stringify(ops));
  const result = await sb.run([
    'plan',
    'prepare',
    sb.path('operations.json'),
    '--project',
    path,
    '--output',
    output,
    '--json',
  ]);
  expect(result.code, result.stderr).toBe(0);
  return singleJson<PlanSummary>(result);
}

function envelope(path: string): Envelope {
  return JSON.parse(readFileSync(path, 'utf8')) as Envelope;
}

describe('plan prepare, inspect and apply', () => {
  it('freezes media-dir inputs so the prepared project validates with that directory', async () => {
    const project = await fileProject();
    const mediaDir = sb.path('media');
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(sb.path('media', 'asset-default'), 'media bytes');
    const operationsPath = sb.path('title-operations.json');
    writeFileSync(
      operationsPath,
      JSON.stringify({
        schemaVersion: 1,
        operations: [
          {
            id: 'add-title',
            op: 'instantiateTemplate',
            instanceId: 'speaker',
            templateId: 'joy.p0.lower-third',
            trackId: 'track-v2',
            lines: { primary: 'Sara', secondary: 'Host' },
            font: { family: 'Noto Sans Arabic', weight: 700 },
            direction: 'ltr',
            startUs: 1_000_000,
            durationUs: 4_000_000,
            placement: { xPx: 64, yPx: 650, maxWidthPx: 900, safeInsetPx: 36 },
            motion: { presetId: 'hold', inUs: 0, outUs: 0 },
          },
        ],
      }),
    );
    setTitleTextMeasurer((text, size) => Array.from(text).length * size * 0.45);
    setRenderPreparationFactsProviderForTests(async () => preparationFacts);
    const planPath = sb.path('media-dir-plan.json');
    const prepareCode = await handlePlanCommand(['prepare', operationsPath], {
      project: project.path,
      output: planPath,
      mediaDir,
      json: true,
    } as never);
    expect(prepareCode).toBe(0);
    const revision = envelope(project.path).revision;
    const applyCode = await handlePlanCommand(['apply', planPath], {
      project: project.path,
      expectedRevision: String(revision),
      idempotencyKey: 'media-dir-plan',
      json: true,
    } as never);
    expect(applyCode).toBe(0);
    const saved = envelope(project.path).project as never;
    await expect(
      validateRenderPreparation(saved, preparationFacts, undefined, mediaDir),
    ).resolves.toBeDefined();
    await expect(validateRenderPreparation(saved, preparationFacts)).rejects.toMatchObject({
      code: 'RENDER_ENVIRONMENT_DRIFT',
    });
  });

  it('prepares a plan without changing a byte of the project and inspect shows its diff', async () => {
    const project = await fileProject();
    const before = readFileSync(project.path);
    const summary = await prepare(project.path, operations(project.clipA, project.clipB));
    expect(readFileSync(project.path).equals(before)).toBe(true);
    const inspect = await sb.run(['plan', 'inspect', sb.path('plan.json'), '--json']);
    expect(inspect.code).toBe(0);
    expect(inspect.json<{ changedEntities: unknown[] }>().changedEntities).toEqual(
      summary.changedEntities,
    );
    expect(summary.planId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('applies a mixed plan once and returns a replay receipt without writing again', async () => {
    const project = await fileProject();
    const summary = await prepare(project.path, operations(project.clipA, project.clipB));
    const revision = envelope(project.path).revision;
    const first = await sb.run([
      'plan',
      'apply',
      sb.path('plan.json'),
      '--project',
      project.path,
      '--expected-revision',
      String(revision),
      '--idempotency-key',
      'key-one',
      '--json',
    ]);
    expect(first.code).toBe(0);
    const receipt = singleJson<Receipt>(first);
    expect(receipt).toMatchObject({
      planId: summary.planId,
      revision: revision + 1,
      replayed: false,
    });
    const saved = envelope(project.path);
    expect(
      saved.project.compositions[Object.keys(saved.project.compositions)[0]!]!.tracks.flatMap(
        (track) => track.clips,
      ).find((clip) => clip.id === project.clipA),
    ).toMatchObject({ startUs: 1_000_000, durationUs: 8_000_000 });
    expect(
      saved.project.compositions[Object.keys(saved.project.compositions)[0]!]!.tracks.find(
        (track) => track.id === 'track-v2',
      )!.clips.map((clip) => clip.id),
    ).toContain(project.clipB);
    const bytes = readFileSync(project.path);
    const replay = await sb.run([
      'plan',
      'apply',
      sb.path('plan.json'),
      '--project',
      project.path,
      '--expected-revision',
      String(revision),
      '--idempotency-key',
      'key-one',
      '--json',
    ]);
    expect(replay.code).toBe(0);
    expect(replay.json<Receipt>().replayed).toBe(true);
    expect(readFileSync(project.path).equals(bytes)).toBe(true);
  });

  it('rejects stale revision without writing or recording an idempotency key', async () => {
    const project = await fileProject();
    await prepare(project.path, operations(project.clipA, project.clipB));
    const before = readFileSync(project.path);
    const result = await sb.run([
      'plan',
      'apply',
      sb.path('plan.json'),
      '--project',
      project.path,
      '--expected-revision',
      '0',
      '--idempotency-key',
      'stale-key',
      '--json',
    ]);
    expect(jsonError(result, 1).code).toBe('STALE_REVISION');
    expect(readFileSync(project.path).equals(before)).toBe(true);
    expect(envelope(project.path).appliedPlans).toBeUndefined();
  });

  it('does not write a plan when the first operation has an invalid target', async () => {
    const project = await fileProject();
    const before = readFileSync(project.path);
    writeFileSync(
      sb.path('operations.json'),
      JSON.stringify({
        schemaVersion: 1,
        operations: [{ id: 'bad', op: 'trimClip', clipId: 'missing', durationUs: 1 }],
      }),
    );
    const result = await sb.run([
      'plan',
      'prepare',
      sb.path('operations.json'),
      '--project',
      project.path,
      '--output',
      sb.path('bad-plan.json'),
      '--json',
    ]);
    expect(jsonError(result, 1).code).toBe('CLIP_NOT_FOUND');
    expect(readFileSync(project.path).equals(before)).toBe(true);
    expect(() => readFileSync(sb.path('bad-plan.json'))).toThrow();
  });

  it('rejects unsupported operations during prepare', async () => {
    const project = await fileProject();
    writeFileSync(
      sb.path('operations.json'),
      JSON.stringify({ schemaVersion: 1, operations: [{ id: 'unsupported', op: 'add-clip' }] }),
    );
    const result = await sb.run([
      'plan',
      'prepare',
      sb.path('operations.json'),
      '--project',
      project.path,
      '--output',
      sb.path('unsupported-plan.json'),
      '--json',
    ]);
    expect(jsonError(result, 1).code).toBe('PLAN_UNSUPPORTED_OPERATION');
  });

  it('rejects a plan whose immutable contents were edited', async () => {
    const project = await fileProject();
    await prepare(project.path, operations(project.clipA, project.clipB));
    const original = JSON.parse(readFileSync(sb.path('plan.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    original['projectId'] = `${String(original['projectId'])}-edited`;
    writeFileSync(sb.path('plan.json'), JSON.stringify(original));
    const inspect = await sb.run(['plan', 'inspect', sb.path('plan.json'), '--json']);
    expect(jsonError(inspect, 1).code).toBe('PLAN_TAMPERED');
    const apply = await sb.run([
      'plan',
      'apply',
      sb.path('plan.json'),
      '--project',
      project.path,
      '--expected-revision',
      String(envelope(project.path).revision),
      '--idempotency-key',
      'tampered',
      '--json',
    ]);
    expect(jsonError(apply, 1).code).toBe('PLAN_TAMPERED');
  });

  it('rejects reusing a key for another plan without changing project bytes', async () => {
    const project = await fileProject();
    const summary = await prepare(project.path, operations(project.clipA, project.clipB));
    const revision = envelope(project.path).revision;
    const first = await sb.run([
      'plan',
      'apply',
      sb.path('plan.json'),
      '--project',
      project.path,
      '--expected-revision',
      String(revision),
      '--idempotency-key',
      'same-key',
      '--json',
    ]);
    expect(first.code).toBe(0);
    const receiptBytes = readFileSync(project.path);
    const secondOps = {
      schemaVersion: 1,
      operations: [{ id: 'op', op: 'trimClip', clipId: project.clipA, durationUs: 7_000_000 }],
    };
    await prepare(project.path, secondOps, sb.path('other-plan.json'));
    const result = await sb.run([
      'plan',
      'apply',
      sb.path('other-plan.json'),
      '--project',
      project.path,
      '--expected-revision',
      String(revision),
      '--idempotency-key',
      'same-key',
      '--json',
    ]);
    expect(summary.planId).not.toBe(
      JSON.parse(readFileSync(sb.path('other-plan.json'), 'utf8')).planId,
    );
    expect(jsonError(result, 1).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(readFileSync(project.path).equals(receiptBytes)).toBe(true);
  });

  it('detects a hand edit with an unchanged revision', async () => {
    const project = await fileProject();
    await prepare(project.path, operations(project.clipA, project.clipB));
    const revision = envelope(project.path).revision;
    const parsed = envelope(project.path);
    parsed.project.title = `${parsed.project.title ?? ''} hand edit`;
    writeFileSync(project.path, JSON.stringify(parsed));
    const stale = await sb.run([
      'plan',
      'apply',
      sb.path('plan.json'),
      '--project',
      project.path,
      '--expected-revision',
      String(revision),
      '--idempotency-key',
      'hand-edit',
      '--json',
    ]);
    expect(jsonError(stale, 1).code).toBe('STALE_PLAN');
  });

  it('keeps the applied ledger across direct edits and replays before revision checks', async () => {
    const clean = await fileProject();
    await prepare(clean.path, operations(clean.clipA, clean.clipB), sb.path('recovery-plan.json'));
    const baseRevision = envelope(clean.path).revision;
    const applied = await sb.run([
      'plan',
      'apply',
      sb.path('recovery-plan.json'),
      '--project',
      clean.path,
      '--expected-revision',
      String(baseRevision),
      '--idempotency-key',
      'durable-key',
      '--json',
    ]);
    expect(applied.code).toBe(0);
    const direct = await sb.run([
      'timeline',
      'remove-clip',
      '--project',
      clean.path,
      '--clip',
      clean.clipB,
      '--json',
    ]);
    expect(direct.code).toBe(0);
    const bytes = readFileSync(clean.path);
    const replay = await sb.run([
      'plan',
      'apply',
      sb.path('recovery-plan.json'),
      '--project',
      clean.path,
      '--expected-revision',
      String(baseRevision),
      '--idempotency-key',
      'durable-key',
      '--json',
    ]);
    expect(replay.json<Receipt>().replayed).toBe(true);
    expect(readFileSync(clean.path).equals(bytes)).toBe(true);
  });

  it('refuses a replay whose stored receipt contradicts its plan, writing nothing', async () => {
    const project = await fileProject();
    await prepare(
      project.path,
      operations(project.clipA, project.clipB),
      sb.path('checked-plan.json'),
    );
    const baseRevision = envelope(project.path).revision;
    const apply = () =>
      sb.run([
        'plan',
        'apply',
        sb.path('checked-plan.json'),
        '--project',
        project.path,
        '--expected-revision',
        String(baseRevision),
        '--idempotency-key',
        'checked-key',
        '--json',
      ]);
    expect((await apply()).code).toBe(0);
    // Hand-edit the stored receipt so that it no longer describes the plan's result.
    const doc = JSON.parse(readFileSync(project.path, 'utf8')) as {
      appliedPlans: Record<string, { receipt: { resultHash: string } }>;
    };
    doc.appliedPlans['checked-key']!.receipt.resultHash = `sha256:${'0'.repeat(64)}`;
    writeFileSync(project.path, JSON.stringify(doc, null, 2));
    const bytes = readFileSync(project.path);
    expect(jsonError(await apply(), 1).code).toBe('PROJECT_FILE_INVALID');
    expect(readFileSync(project.path).equals(bytes)).toBe(true);
  });

  it('carries the ledger into a re-export of the same project only', async () => {
    const project = await fileProject();
    const id = (JSON.parse(readFileSync(project.path, 'utf8')) as { id: string }).id;
    await prepare(
      project.path,
      operations(project.clipA, project.clipB),
      sb.path('carried-plan.json'),
    );
    const baseRevision = envelope(project.path).revision;
    const applied = await sb.run([
      'plan',
      'apply',
      sb.path('carried-plan.json'),
      '--project',
      project.path,
      '--expected-revision',
      String(baseRevision),
      '--idempotency-key',
      'carried-key',
      '--json',
    ]);
    expect(applied.code).toBe(0);
    await exportAndValidate(sb, id, 'project.json');
    expect(envelope(project.path).appliedPlans).toHaveProperty('carried-key');
    const other = await createProject(sb, 'Another project');
    await exportAndValidate(sb, other, 'project.json');
    expect(envelope(project.path).appliedPlans).toBeUndefined();
  });

  it('reports usage errors as one JSON error line with exit code 2', async () => {
    const result = await sb.run([
      'plan',
      'apply',
      sb.path('plan.json'),
      '--project',
      sb.path('project.json'),
      '--expected-revision',
      'not-a-number',
      '--idempotency-key',
      'k',
      '--json',
    ]);
    expect(jsonError(result, 2).code).toBe('USAGE');
  });

  it('allows SQLite reads during prepare but refuses SQLite apply clearly', async () => {
    const id = await createProject(sb, 'SQLite read-only plan');
    const added = await sb.run([
      'timeline',
      'add-clip',
      '--project',
      id,
      '--duration',
      '10',
      '--json',
    ]);
    expect(added.code).toBe(0);
    const clipId = added.json<{ clip: { id: string } }>().clip.id;
    writeFileSync(
      sb.path('sqlite-ops.json'),
      JSON.stringify({
        schemaVersion: 1,
        operations: [{ id: 'trim', op: 'trimClip', clipId, durationUs: 8_000_000 }],
      }),
    );
    const prepared = await sb.run([
      'plan',
      'prepare',
      sb.path('sqlite-ops.json'),
      '--project',
      id,
      '--output',
      sb.path('sqlite-plan.json'),
      '--json',
    ]);
    expect(prepared.code).toBe(0);
    const result = await sb.run([
      'plan',
      'apply',
      sb.path('sqlite-plan.json'),
      '--project',
      id,
      '--expected-revision',
      '2',
      '--idempotency-key',
      'sqlite-key',
      '--json',
    ]);
    expect(jsonError(result, 1).code).toBe('PLAN_STORE_UNSUPPORTED');
  });
});
