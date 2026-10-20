import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { compileCaptionAss } from './captions-ass.js';
import { loadNotoSansArabicFaces } from '@joy-media/html-scene-runtime';
import {
  freezeRenderPreparation,
  readRenderPreparation,
  renderInputsDigest,
  validateRenderPreparation,
  type RenderPreparationFacts,
} from './render-preparation.js';
import type { CliProjectDocument } from '../utils/project-loader.js';

function failureCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected preparation to fail.');
}

const facts: RenderPreparationFacts = {
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

const project = {
  id: 'project',
  pluginData: {
    'joy.contentTemplates': {
      version: 1,
      instances: { title: { lines: { primary: 'Sara' }, font: { weight: 700 } } },
    },
  },
  rootCompositionId: 'root',
  compositions: {
    root: { width: 1920, height: 1080, frameRate: { num: 30000, den: 1001 }, tracks: [] },
  },
} as unknown as CliProjectDocument;

describe('RenderPreparationV1', () => {
  it('freezes renderer, font, coverage, composition, and input digests', () => {
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    expect(preparation).toMatchObject({
      version: 'RenderPreparationV1',
      renderers: { title: 'chromium-scene-surface', caption: 'none' },
      composition: { width: 1920, height: 1080, fps: { num: 30000, den: 1001 } },
      coverage: { result: 'passed', checkedTextLength: 4 },
      fonts: [{ family: 'Noto Sans Arabic', weight: 700, subset: 'latin' }],
    });
    expect(preparation.fonts[0]?.length).toBeGreaterThan(0);
    expect(preparation.fonts[0]?.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(preparation.renderInputsDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const saved = {
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    };
    expect(readRenderPreparation(saved)).toEqual(preparation);
  });

  it('reports missing, malformed, and changed environment records with distinct codes', async () => {
    await expect(validateRenderPreparation(project)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_REQUIRED',
    });
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    const preparedProject = {
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    } as unknown as CliProjectDocument;
    const drifted = { ...preparedProject, title: 'changed' } as CliProjectDocument;
    await expect(validateRenderPreparation(drifted, facts)).rejects.toMatchObject({
      code: 'RENDER_ENVIRONMENT_DRIFT',
    });
    const malformed = {
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': {} },
    };
    await expect(
      validateRenderPreparation(malformed as unknown as CliProjectDocument, facts),
    ).rejects.toMatchObject({ code: 'RENDER_PREPARATION_INVALID' });
  });

  it('reports missing canonical faces and uncovered glyphs precisely', () => {
    expect(
      failureCode(() =>
        freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], {
          ...facts,
          canonicalFaces: [],
        }),
      ),
    ).toMatchObject({ code: 'FONT_UNAVAILABLE' });
    const emojiProject = structuredClone(project) as any;
    emojiProject.pluginData['joy.contentTemplates'].instances.title.lines.primary = '🚀';
    expect(
      failureCode(() =>
        freezeRenderPreparation(emojiProject, [{ op: 'instantiateTemplate' }], facts),
      ),
    ).toMatchObject({ code: 'FONT_UNSUPPORTED_GLYPH' });
  });

  it('freezes measured caption widths, hard breaks, and the ASS digest', async () => {
    const captionProject = {
      ...project,
      compositions: {
        root: {
          ...project.compositions.root,
          tracks: [
            {
              id: 'captions',
              enabled: true,
              clips: [
                {
                  id: 'caption-clip',
                  kind: 'caption',
                  captionDocumentId: 'caption-doc',
                  startUs: 0,
                  durationUs: 1_000_000,
                },
              ],
            },
          ],
        },
      },
      captionDocuments: {
        'caption-doc': {
          direction: 'ltr',
          words: {},
          segments: [{ startUs: 0, endUs: 1_000_000, textOverride: 'Hello world' }],
        },
      },
    } as unknown as CliProjectDocument;
    const measuredFacts = { ...facts, measureText: (_text: string, size: number) => size * 3 };
    const preparation = freezeRenderPreparation(
      captionProject,
      [{ op: 'addCaption' }],
      measuredFacts,
    );
    expect(preparation.captions.cues[0]).toMatchObject({
      lines: ['Hello world'],
      measuredWidthsPx: [180],
    });
    expect(preparation.captions.assDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const saved = {
      ...captionProject,
      pluginData: { ...captionProject.pluginData, 'joy.renderPreparation': preparation },
    } as unknown as CliProjectDocument;
    await expect(validateRenderPreparation(saved, measuredFacts)).resolves.toEqual(preparation);
  });

  it('refuses an older policy version as environment drift', async () => {
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    const saved = structuredClone({
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    }) as unknown as CliProjectDocument;
    (saved.pluginData['joy.renderPreparation'] as any).versions.renderer = '0';
    await expect(validateRenderPreparation(saved, facts)).rejects.toMatchObject({
      code: 'RENDER_ENVIRONMENT_DRIFT',
    });
  });

  it('refuses an unavailable libass version in a caption record', async () => {
    const captionProject = makeCaptionProject();
    const measuredFacts = { ...facts, measureText: (_text: string, size: number) => size * 3 };
    const preparation = freezeRenderPreparation(
      captionProject,
      [{ op: 'addCaption' }],
      measuredFacts,
    );
    const saved = structuredClone({
      ...captionProject,
      pluginData: { ...captionProject.pluginData, 'joy.renderPreparation': preparation },
    }) as unknown as CliProjectDocument;
    (saved.pluginData['joy.renderPreparation'] as any).ffmpeg.libassVersion = 'unavailable';
    await expect(validateRenderPreparation(saved, measuredFacts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });
  });

  it('refuses a changed frozen cue even when its ASS digest is recomputed', async () => {
    const captionProject = makeCaptionProject();
    const measuredFacts = { ...facts, measureText: (_text: string, size: number) => size * 3 };
    const preparation = freezeRenderPreparation(
      captionProject,
      [{ op: 'addCaption' }],
      measuredFacts,
    );
    const saved = structuredClone({
      ...captionProject,
      pluginData: { ...captionProject.pluginData, 'joy.renderPreparation': preparation },
    }) as unknown as CliProjectDocument;
    const record = saved.pluginData['joy.renderPreparation'] as any;
    record.captions.cues[0].lines[0] = 'Tampered cue';
    const ass = compileCaptionAss({
      width: 1920,
      height: 1080,
      fontFamily: 'Noto Sans Arabic',
      frameRate: { num: 30000, den: 1001 },
      fontSizePx: record.captions.fontSizePx,
      marginBottomPx: record.captions.placement.marginBottomPx,
      cues: record.captions.cues.map((cue: any) => ({ text: cue.lines.join('\n'), ...cue })),
    });
    record.captions.assDigest = `sha256:${createHash('sha256').update(Buffer.from(ass)).digest('hex')}`;
    await expect(validateRenderPreparation(saved, measuredFacts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });
  });

  it('refuses selected font weights that disagree with frozen title instances', async () => {
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    const saved = structuredClone({
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    }) as unknown as CliProjectDocument;
    (saved.pluginData['joy.renderPreparation'] as any).fonts[0].weight = 400;
    await expect(validateRenderPreparation(saved, facts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });
  });
});

function makeCaptionProject(): CliProjectDocument {
  return {
    ...project,
    compositions: {
      root: {
        ...project.compositions.root,
        tracks: [
          {
            id: 'captions',
            enabled: true,
            clips: [
              {
                id: 'caption-clip',
                kind: 'caption',
                captionDocumentId: 'caption-doc',
                startUs: 0,
                durationUs: 1_000_000,
              },
            ],
          },
        ],
      },
    },
    captionDocuments: {
      'caption-doc': {
        direction: 'ltr',
        words: {},
        segments: [{ startUs: 0, endUs: 1_000_000, textOverride: 'Hello world' }],
      },
    },
  } as unknown as CliProjectDocument;
}
