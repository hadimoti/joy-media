import { afterEach, describe, expect, it } from 'vitest';
import { setTitleTextMeasurer, applyPreparedTitleOperation } from './prepared-title.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../cli.js';
import type { CliProjectDocument } from '../utils/project-loader.js';
import { loadNotoSansArabicFaces } from '@joy-media/html-scene-runtime';
import { preflightRenderPreparation, type RenderPreparationFacts } from './render-preparation.js';

const measure = (text: string, size: number) => Array.from(text).length * size * 0.45;
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code} failure.`);
}
let directory: string;
async function capture(fn: () => Promise<number>): Promise<string> {
  const write = process.stdout.write;
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    if (code !== 0) throw new Error(out);
    return out;
  } finally {
    process.stdout.write = write;
  }
}
async function project(): Promise<CliProjectDocument> {
  directory = mkdtempSync(join(tmpdir(), 'prepared-title-'));
  const db = join(directory, 'p.sqlite'),
    path = join(directory, 'p.json');
  const created = JSON.parse(
    await capture(() => runCli(['project', 'create', 'Title', '--sqlite-path', db, '--json'])),
  ) as { id: string };
  await capture(() =>
    runCli(['project', 'export', created.id, '--sqlite-path', db, '--output', path, '--json']),
  );
  return JSON.parse(readFileSync(path, 'utf8')).source as CliProjectDocument;
}
const instantiate = (extra: Record<string, unknown> = {}) => ({
  id: 'title',
  op: 'instantiateTemplate',
  instanceId: 'speaker',
  templateId: 'joy.p0.lower-third',
  trackId: 'track-v1',
  lines: { primary: 'Sara', secondary: '' },
  font: { family: 'Noto Sans Arabic', weight: 700 },
  direction: 'ltr',
  startUs: 0,
  durationUs: 2_000_000,
  placement: { xPx: 64, yPx: 420, maxWidthPx: 900, safeInsetPx: 36 },
  motion: { presetId: 'hold', inUs: 0, outUs: 0 },
  ...extra,
});
afterEach(() => {
  setTitleTextMeasurer(undefined);
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('prepared title resolution', () => {
  it('resolves frozen data deterministically across prepares', async () => {
    setTitleTextMeasurer(measure);
    const source = await project();
    const a = applyPreparedTitleOperation(source, instantiate(), true);
    const b = applyPreparedTitleOperation(source, instantiate(), true);
    expect(a.operation).toEqual(b.operation);
    expect(a.operation).toHaveProperty('resolved.layout.primaryLines', ['Sara']);
  });
  it('rejects fields outside the instantiate operation', async () => {
    setTitleTextMeasurer(measure);
    const p = (await project()) as any;
    expectCode(
      () => applyPreparedTitleOperation(p, instantiate({ surprise: true }), true),
      'PLAN_INVALID_OPERATION',
    );
  });
  it('requires a registered Chromium measurer', async () => {
    const p = (await project()) as any;
    try {
      applyPreparedTitleOperation(p, instantiate(), true);
      throw new Error('Expected setup failure.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'SETUP_REQUIRED',
        message:
          'Title text measurement needs a Chromium browser; set JOY_CHROMIUM_PATH or install the Playwright Chromium browser',
      });
    }
  });
  it('enforces the eight instance project limit', async () => {
    setTitleTextMeasurer(measure);
    const p = (await project()) as any;
    const titles: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`i${i}`, {}]),
    );
    p.pluginData = { ...p.pluginData, 'joy.contentTemplates': { version: 1, instances: titles } };
    expectCode(() => applyPreparedTitleOperation(p, instantiate(), true), 'SLICE_LIMIT');
  });
  it.each([
    ['TEMPLATE_UNSUPPORTED', { templateId: 'bad' }],
    ['FONT_UNAVAILABLE', { font: { family: 'Arial', weight: 700 } }],
    ['ID_CONFLICT', { instanceId: 'existing' }],
    ['TRACK_NOT_FOUND', { trackId: 'missing' }],
    ['TRACK_KIND_MISMATCH', { trackId: 'track-v1' }],
    ['TRACK_LOCKED', { trackId: 'track-v1' }],
    ['CLIP_OVERLAP', { startUs: 0 }],
    ['TEXT_OVERFLOW', { placement: { xPx: 64, yPx: 1900, maxWidthPx: 900, safeInsetPx: 36 } }],
    ['RANGE_ERROR', { durationUs: 0 }],
  ])('produces %s for its condition', async (code, change) => {
    setTitleTextMeasurer(measure);
    const p = (await project()) as any;
    const op = instantiate(change);
    if (code === 'ID_CONFLICT')
      p.visualObjects = {
        ...p.visualObjects,
        [`object-${String((op as any).instanceId)}`]: {} as never,
      };
    if (code === 'TRACK_KIND_MISMATCH') {
      p.compositions[p.rootCompositionId]!.tracks[0]!.kind = 'audio';
      p.compositions[p.rootCompositionId]!.tracks[0]!.family = 'audio';
    }
    if (code === 'TRACK_LOCKED') p.compositions[p.rootCompositionId]!.tracks[0]!.locked = true;
    if (code === 'CLIP_OVERLAP')
      p.compositions[p.rootCompositionId]!.tracks[0]!.clips.push({
        id: 'overlap',
        kind: 'video',
        startUs: 1_000_000,
        durationUs: 1_000_000,
      });
    expectCode(() => applyPreparedTitleOperation(p, op, true), code);
  });
  it('checks duration and composition timing limits', async () => {
    setTitleTextMeasurer(measure);
    const p = (await project()) as any;
    expectCode(
      () => applyPreparedTitleOperation(p, instantiate({ durationUs: 500 }), true),
      'RANGE_ERROR',
    );
    expectCode(
      () =>
        applyPreparedTitleOperation(
          p,
          instantiate({ startUs: 59_000_000, durationUs: 2_000_000 }),
          true,
        ),
      'RANGE_ERROR',
    );
  });
  it('reports TEMPLATE_NOT_FOUND for text updates without a matching instance', async () => {
    setTitleTextMeasurer(measure);
    const p = await project();
    expectCode(
      () =>
        applyPreparedTitleOperation(
          p,
          {
            id: 'rename',
            op: 'updateTemplateText',
            instanceId: 'missing',
            lines: { primary: 'Name' },
          },
          true,
        ),
      'TEMPLATE_NOT_FOUND',
    );
  });
  it('produces frozen normalized data for a semantics-3 title plan', async () => {
    setTitleTextMeasurer(measure);
    expect(
      applyPreparedTitleOperation(await project(), instantiate(), true).operation,
    ).toHaveProperty('resolved');
  });

  it('refuses caption preparation before title measurement when canonical libass is unusable', async () => {
    const p = await project();
    const mutable = p as any;
    mutable.compositions[mutable.rootCompositionId].tracks[0].clips.push({
      id: 'caption',
      kind: 'caption',
      captionDocumentId: 'caption-doc',
      startUs: 0,
      durationUs: 1_000_000,
    });
    mutable.captionDocuments = { 'caption-doc': { segments: [] } };
    const facts: RenderPreparationFacts = {
      libassProbe: {
        usable: false,
        executablePath: 'ffmpeg',
        canonicalFace: 'Noto Sans Arabic Arabic 400',
        reason: 'probe failed',
        log: '',
      },
      libassAvailable: true,
      canonicalFaces: loadNotoSansArabicFaces(),
      chromium: {
        launchable: true,
        executablePath: null,
        executableSha256: null,
        version: 'Chromium test',
      },
      ffmpeg: {
        executablePath: 'ffmpeg',
        executableSha256: null,
        version: 'ffmpeg',
        buildConfiguration: '',
        requiredFilters: [],
        libassVersion: 'unknown',
        shaperVersion: 'unknown',
      },
    };
    await expect(
      preflightRenderPreparation(p, [{ op: 'addCaption' }], facts),
    ).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
  });
});
