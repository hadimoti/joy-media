import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildHistoricalSchemaProjects } from '@joy-media/test-fixtures';
import {
  projectV3ToDesktopDocuments,
  projectV3ToDesktopVisual,
  normalizeUniversalTimeline,
  validateJoyProjectV1,
  validateSpikeProject,
  type JoyProjectV1,
  type JoyProjectV3,
  type JsonValue,
} from '@joy-media/project-schema';
import { compileTitleInstance, P0_PAINT_POLICY, P0_TEMPLATES } from '@joy-media/motion-core';
import { importProjectPackage, parseProjectPackage } from './project-package.js';
import { EditorSession } from './editor-session.js';
import { readProjectBundle } from './project-lifecycle.js';
import { P0_TITLE_FONTS } from './p0-title-fonts.js';
import {
  captureTitleMarkup,
  closeP0DesktopHandoff,
  prepareP0DesktopHandoff,
  runP0DesktopHandoff,
  type P0DesktopHandoffOperation,
} from './p0-desktop-handoff-harness.js';
import { buildTitleSceneFrame } from '@joy-media/motion-core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- direct source import is required for parity.
// @ts-ignore -- this cross-project source import is intentionally outside the editor tsconfig root.
import { renderTitleFrames } from '../../cli/src/services/title-frames.js';
import { scenePaintFontDescriptors } from '../../../packages/html-scene-runtime/src/font-descriptors.js';
import type { RenderFrameIR, VideoFrameNode } from '@joy-media/render-ir';
import { renderP0DesktopCompositorFrame } from './p0-desktop-handoff-harness.js';

const hash = (bytes: ArrayLike<number>): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

function makeInstance(
  templateId: 'joy.p0.lower-third' | 'joy.p0.title',
  weight: 400 | 700,
  primary: string,
  direction: 'ltr' | 'rtl' = 'ltr',
  presetId: 'joy-fade-in' | 'joy-slide-up' | 'hold' = 'joy-slide-up',
) {
  const font = P0_TITLE_FONTS.find((entry) => entry.subset === 'arabic' && entry.weight === weight);
  if (!font) throw new Error(`Canonical font descriptor missing for ${weight}`);
  const result = compileTitleInstance(
    {
      instanceId: `test-${templateId}-${weight}`,
      templateId,
      clipId: `clip-test-${templateId}-${weight}`,
      objectId: `object-test-${templateId}-${weight}`,
      lines: { primary, secondary: 'Edit · مراجعة' },
      direction,
      font: { family: 'Noto Sans Arabic', weight },
      fontSha256: font.sha256,
      placement: { xPx: 80, yPx: 300, maxWidthPx: 920, safeInsetPx: 32 },
      motion: { presetId, inUs: 250_000, outUs: 200_000 },
      clipDurationUs: 2_000_000,
      frame: { widthPx: 1080, heightPx: 1920 },
    },
    (text, size) => [...text].length * size * 0.55,
  );
  if (!result.ok) throw new Error(`P0 fixture compilation failed: ${result.code}`);
  return result.instance;
}

const titleInstanceId = (instance: ReturnType<typeof makeInstance>): string =>
  `test-${instance.templateId}-${instance.font.weight}`;

function operationResult(response: Awaited<ReturnType<typeof runP0DesktopHandoff>>, id: string) {
  const result = response.operations.find((entry) => entry.id === id);
  if (result === undefined) throw new Error(`Browser handoff operation missing: ${id}`);
  return result;
}

function projectContext(
  instance = makeInstance('joy.p0.title', 400, 'Surface eviction title'),
  options: { startUs?: number; durationUs?: number; enabled?: boolean } = {},
): {
  visual: JoyProjectV1;
  timeline: ReturnType<typeof projectV3ToDesktopDocuments>['timeline']['project'];
} {
  const base = buildHistoricalSchemaProjects().v3;
  const startUs = options.startUs ?? 100_000;
  const durationUs = options.durationUs ?? 1_000_000;
  const objectId = instance.objectId;
  const clipId = instance.clipId;
  const visual: JoyProjectV1 = {
    ...base,
    schemaVersion: 1,
    ...(base.timelineTrackDeck === undefined
      ? {}
      : {
          timelineTrackDeck: {
            ...base.timelineTrackDeck,
            rows: base.timelineTrackDeck.rows.map((row) => ({
              ...row,
              enabled: options.enabled ?? true,
            })),
          },
        }),
    compositions: {
      ...base.compositions,
      root: {
        ...base.compositions.root!,
        tracks: base.compositions.root!.tracks.map((track) => ({
          ...track,
          enabled: options.enabled ?? true,
        })),
      },
    },
    visualObjects: {
      ...base.visualObjects,
      [objectId]: {
        id: objectId,
        kind: 'html-scene',
        scenePackageId: instance.templateId,
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    },
    pluginData: {
      ...base.pluginData,
      'joy.contentTemplates': {
        version: 1,
        instances: { [titleInstanceId(instance)]: instance } as unknown as JsonValue,
      },
      'joy.clipObjects': { [clipId]: objectId },
    },
    universalTimeline: {
      schemaVersion: 1,
      items: [
        {
          id: clipId,
          compositionId: 'root',
          trackId: 'video-track',
          elementKind: 'html-scene',
          startUs,
          durationUs,
          source: { kind: 'object', id: objectId },
          withinTrackOrder: 1,
        },
      ],
    },
  };
  return {
    visual,
    timeline: projectV3ToDesktopDocuments(base).timeline.project,
  };
}

function compositorContext(
  lower: ReturnType<typeof makeInstance>,
  upper: ReturnType<typeof makeInstance>,
  reverseVideoOrder = false,
): ReturnType<typeof projectContext> {
  const source = buildHistoricalSchemaProjects().v3;
  const base = projectV3ToDesktopVisual(source);
  const baseWithoutDeck = { ...base };
  delete baseWithoutDeck.timelineTrackDeck;
  const root = base.compositions.root!;
  const order = reverseVideoOrder
    ? { video: 0, lower: 1, upper: 2 }
    : { lower: 0, upper: 1, video: 2 };
  const trackTemplate = root.tracks[0]!;
  const tracks = Array.from({ length: 3 }, (_, index) => ({
    ...trackTemplate,
    id: `p0-compositor-track-${index}`,
    order: index,
    enabled: true,
  }));
  const trackFor = (layer: keyof typeof order) => `p0-compositor-track-${order[layer]}`;
  const visual = {
    ...baseWithoutDeck,
    compositions: {
      ...base.compositions,
      root: { ...root, tracks },
    },
    visualObjects: {
      ...base.visualObjects,
      [lower.objectId]: {
        id: lower.objectId,
        kind: 'html-scene' as const,
        scenePackageId: lower.templateId,
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
      [upper.objectId]: {
        id: upper.objectId,
        kind: 'html-scene' as const,
        scenePackageId: upper.templateId,
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    },
    pluginData: {
      ...base.pluginData,
      'joy.contentTemplates': {
        version: 1,
        instances: {
          [titleInstanceId(lower)]: lower,
          [titleInstanceId(upper)]: upper,
        },
      },
      'joy.clipObjects': {
        [lower.clipId]: lower.objectId,
        [upper.clipId]: upper.objectId,
      },
    },
    universalTimeline: {
      schemaVersion: 1 as const,
      items: [
        {
          id: lower.clipId,
          compositionId: 'root',
          trackId: trackFor('lower'),
          elementKind: 'html-scene' as const,
          startUs: 0,
          durationUs: 1_000_000,
          source: { kind: 'object' as const, id: lower.objectId },
          withinTrackOrder: 0,
        },
        {
          id: upper.clipId,
          compositionId: 'root',
          trackId: trackFor('upper'),
          elementKind: 'html-scene' as const,
          startUs: 0,
          durationUs: 1_000_000,
          source: { kind: 'object' as const, id: upper.objectId },
          withinTrackOrder: 0,
        },
        {
          id: 'compositor-video',
          compositionId: 'root',
          trackId: trackFor('video'),
          elementKind: 'video' as const,
          startUs: 0,
          durationUs: 1_000_000,
          source: { kind: 'asset' as const, id: 'asset-video' },
          withinTrackOrder: 0,
        },
      ],
    },
  } as unknown as JoyProjectV1;
  return {
    visual,
    timeline: projectV3ToDesktopDocuments(source).timeline.project,
  };
}

function compositorFrame(
  lower: ReturnType<typeof makeInstance>,
  upper: ReturnType<typeof makeInstance>,
  includeVideo: boolean,
): RenderFrameIR {
  const node = (id: string, translateX = 250): VideoFrameNode => ({
    kind: 'video-frame',
    id,
    zIndex: 0,
    opacity: 1,
    transform: { translateX, translateY: 0, scaleX: 1, scaleY: 1 },
    width: 540,
    height: 960,
    sourceTimeUs: 0,
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  return {
    version: 1,
    compositionId: 'root',
    timeUs: 360_000,
    viewport: { width: 540, height: 960, dpr: 1 },
    background: { r: 24, g: 28, b: 38, a: 1 },
    nodes: [
      node(lower.objectId),
      node(upper.objectId),
      ...(includeVideo ? [node('compositor-video', 0)] : []),
    ],
  };
}

function pixelAt(pixels: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [...pixels.slice(offset, offset + 4)];
}

describe('P0 desktop title handoff', () => {
  beforeAll(prepareP0DesktopHandoff, 240_000);
  afterAll(closeP0DesktopHandoff, 240_000);

  it('projects v3 deterministically without mutating the authority and refuses unmapped content', () => {
    const source = buildHistoricalSchemaProjects().v3;
    const before = structuredClone(source);
    const first = projectV3ToDesktopDocuments(source);
    const second = projectV3ToDesktopDocuments(source);
    expect(first).toEqual(second);
    expect(source).toEqual(before);
    expect(first.visual.schemaVersion).toBe(1);
    expect(first.timeline.schemaVersion).toBe(0);
    expect(validateJoyProjectV1(first.visual)).toEqual([]);
    expect(validateSpikeProject(first.timeline.project)).toEqual([]);
    const expectedVisual = structuredClone(source) as unknown as Record<string, unknown>;
    for (const field of ['artifacts', 'artifactVersions', 'workflow', 'lookInstances'])
      delete expectedVisual[field];
    expectedVisual.schemaVersion = 1;
    expect(first.visual).toEqual(expectedVisual);
    expect(projectV3ToDesktopVisual(source)).toEqual(first.visual);
    expect(() => projectV3ToDesktopVisual({ ...source, artifacts: { x: {} } } as never)).toThrow(
      expect.objectContaining({ code: 'DESKTOP_PROJECTION_UNMAPPED_ARTIFACTS' }),
    );
    expect(() => projectV3ToDesktopVisual({ ...source, title: '' })).toThrow(
      expect.objectContaining({ code: 'DESKTOP_PROJECTION_INVALID_INPUT' }),
    );
  });

  it.each([
    ['artifacts', { artifacts: { x: {} } }, 'DESKTOP_PROJECTION_UNMAPPED_ARTIFACTS'],
    [
      'artifactVersions',
      { artifactVersions: { x: [] } },
      'DESKTOP_PROJECTION_UNMAPPED_ARTIFACT_VERSIONS',
    ],
    ['workflow', { workflow: { nodes: ['x'] } }, 'DESKTOP_PROJECTION_UNMAPPED_WORKFLOW'],
    ['lookInstances', { lookInstances: { x: {} } }, 'DESKTOP_PROJECTION_UNMAPPED_LOOK_INSTANCES'],
  ] as const)('refuses unmapped %s before v3 validation', (_name, additions, code) => {
    expect(() => projectV3ToDesktopVisual(additions as never)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('preserves every universal timeline field, clip identity and timing in schema 0', () => {
    const source = buildHistoricalSchemaProjects().v3;
    const baseVisual = projectV3ToDesktopDocuments(source).visual;
    const baseItems = normalizeUniversalTimeline(baseVisual).document.items;
    const withMediaBindings: JoyProjectV3 = {
      ...source,
      captionDocuments: {
        'caption-doc': {
          id: 'caption-doc',
          language: 'fa',
          direction: 'rtl',
          speakers: [],
          words: {},
          segments: [],
        },
      },
      universalTimeline: {
        schemaVersion: 1,
        items: [
          ...baseItems,
          {
            id: 'audio-binding',
            compositionId: 'root',
            trackId: 'video-track',
            elementKind: 'audio',
            startUs: 400_000,
            durationUs: 700_000,
            source: { kind: 'asset', id: 'asset-video' },
            sourceInUs: 120_000,
            withinTrackOrder: 2,
          },
          {
            id: 'caption-binding',
            compositionId: 'root',
            trackId: 'video-track',
            elementKind: 'caption',
            startUs: 500_000,
            durationUs: 600_000,
            source: { kind: 'caption', id: 'caption-doc' },
            withinTrackOrder: 3,
          },
        ],
      },
    };
    const projected = projectV3ToDesktopDocuments(withMediaBindings);
    const expectedItems = normalizeUniversalTimeline(projected.visual).items;
    expect(projected.timeline.universalTimeline.items).toHaveLength(expectedItems.length);
    expectedItems.forEach((expected, index) => {
      const actual = projected.timeline.universalTimeline.items[index];
      expect(actual?.id).toBe(expected.id);
      expect(actual?.compositionId).toBe(expected.compositionId);
      expect(actual?.trackId).toBe(expected.trackId);
      expect(actual?.elementKind).toBe(expected.elementKind);
      expect(actual?.startUs).toBe(expected.startUs);
      expect(actual?.durationUs).toBe(expected.durationUs);
      expect(actual?.withinTrackOrder).toBe(expected.withinTrackOrder);
      expect(actual?.source).toEqual(expected.source);
    });
    const expectedClips = Object.values(source.compositions).flatMap((composition) =>
      composition.tracks.flatMap((track) =>
        track.clips.map((clip) => ({ compositionId: composition.id, trackId: track.id, clip })),
      ),
    );
    expect(projected.timeline.clipBindings).toHaveLength(expectedClips.length);
    expectedClips.forEach((expected, index) => {
      const actual = projected.timeline.clipBindings[index];
      expect(actual?.compositionId).toBe(expected.compositionId);
      expect(actual?.trackId).toBe(expected.trackId);
      expect(actual?.clip.id).toBe(expected.clip.id);
      expect(actual?.clip.startUs).toBe(expected.clip.startUs);
      expect(actual?.clip.durationUs).toBe(expected.clip.durationUs);
      expect(actual?.sourceBinding).toEqual(
        expectedItems.find((item) => item.id === expected.clip.id),
      );
    });
    expect(projected.timeline.audioBindings).toEqual([
      expect.objectContaining({
        id: 'audio-binding',
        compositionId: 'root',
        trackId: 'video-track',
        elementKind: 'audio',
        startUs: 400_000,
        durationUs: 700_000,
        source: { kind: 'asset', id: 'asset-video' },
        sourceInUs: 120_000,
        withinTrackOrder: 2,
      }),
    ]);
    expect(projected.timeline.captionBindings).toEqual([
      expect.objectContaining({
        id: 'caption-binding',
        compositionId: 'root',
        trackId: 'video-track',
        elementKind: 'caption',
        startUs: 500_000,
        durationUs: 600_000,
        source: { kind: 'caption', id: 'caption-doc' },
        withinTrackOrder: 3,
      }),
    ]);
  });

  it('keeps unknown plugin namespaces and title hashes, layouts, IDs, timing and ordering', () => {
    const source = buildHistoricalSchemaProjects().v3;
    const instance = makeInstance('joy.p0.lower-third', 700, 'Persisted title');
    const root = source.compositions.root!;
    const withTitle = {
      ...source,
      compositions: {
        ...source.compositions,
        root: {
          ...root,
          tracks: root.tracks.map((track) => ({
            ...track,
            clips: [
              ...track.clips,
              {
                kind: 'video' as const,
                id: instance.clipId,
                startUs: 0,
                durationUs: 2_000_000,
                assetId: 'asset-video',
                sourceInUs: 0,
              },
            ],
          })),
        },
      },
      visualObjects: {
        ...source.visualObjects,
        [instance.objectId]: {
          id: instance.objectId,
          kind: 'html-scene' as const,
          scenePackageId: instance.templateId,
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
          },
        },
      },
      pluginData: {
        ...source.pluginData,
        'third-party.unknown': { retained: ['opaque', 2] },
        'joy.contentTemplates': {
          version: 1,
          instances: { [titleInstanceId(instance)]: instance },
        },
        'joy.clipObjects': { [instance.clipId]: instance.objectId },
      },
    } as JoyProjectV3;
    const projected = projectV3ToDesktopDocuments(withTitle).visual;
    expect(projected.pluginData['third-party.unknown']).toEqual({ retained: ['opaque', 2] });
    expect(projected.pluginData['joy.contentTemplates']).toEqual({
      version: 1,
      instances: { [titleInstanceId(instance)]: instance },
    });
    expect(projected.pluginData['joy.contentTemplates']).toMatchObject({
      instances: {
        [titleInstanceId(instance)]: {
          templateSha256: instance.templateSha256,
          font: { sha256: instance.font.sha256, weight: 700 },
          layout: instance.layout,
          clipId: instance.clipId,
          objectId: instance.objectId,
        },
      },
    });
    expect(projected.compositions.root?.tracks[0]?.clips[0]).toMatchObject({
      id: 'clip-video',
      startUs: 0,
      durationUs: 5_000_000,
    });
  });

  it('rejects incompatible canonical font descriptors during title compilation', () => {
    const result = compileTitleInstance(
      {
        instanceId: 'bad-font',
        templateId: 'joy.p0.title',
        clipId: 'bad-font-clip',
        objectId: 'bad-font-object',
        lines: { primary: 'Unsupported font', secondary: '' },
        direction: 'ltr',
        font: { family: 'Noto Sans Arabic', weight: 400 },
        fontSha256: '0'.repeat(64),
        placement: { xPx: 40, yPx: 40, maxWidthPx: 800, safeInsetPx: 20 },
        motion: { presetId: 'hold', inUs: 0, outUs: 0 },
        clipDurationUs: 1_000_000,
        frame: { widthPx: 1080, heightPx: 1920 },
      },
      (text, size) => [...text].length * size * 0.5,
    );
    expect(result).toMatchObject({ ok: false });
  });

  it('round-trips the projected package through import and a reopened EditorSession', async () => {
    const source = buildHistoricalSchemaProjects().v3;
    const instance = makeInstance('joy.p0.title', 400, 'Imported desktop title');
    const media = Buffer.from('desktop export media');
    const directory = mkdtempSync(join(tmpdir(), 'joy-p0-desktop-roundtrip-'));
    const mediaPath = join(directory, 'original.mp4');
    const outputPath = join(directory, 'project.joy');
    writeFileSync(mediaPath, media);
    const root = source.compositions.root!;
    const project = {
      ...source,
      title: 'Desktop export round trip',
      assets: {
        ...source.assets,
        'asset-video': {
          ...source.assets['asset-video']!,
          bytes: media.byteLength,
          sha256: hash(media),
          descriptor: { mimeType: 'video/mp4' },
        },
      },
      compositions: {
        ...source.compositions,
        root: {
          ...root,
          tracks: root.tracks.map((track) => ({
            ...track,
            clips: [
              ...track.clips,
              {
                kind: 'video' as const,
                id: instance.clipId,
                startUs: 1_250_000,
                durationUs: 2_000_000,
                assetId: 'asset-video',
                sourceInUs: 250_000,
              },
            ],
          })),
        },
      },
      visualObjects: {
        ...source.visualObjects,
        [instance.objectId]: {
          id: instance.objectId,
          kind: 'html-scene' as const,
          scenePackageId: instance.templateId,
          transform: {
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            opacity: 1,
            crop: { left: 0, top: 0, right: 0, bottom: 0 },
          },
        },
      },
      pluginData: {
        ...source.pluginData,
        'joy.contentTemplates': {
          version: 1,
          instances: { [titleInstanceId(instance)]: instance },
        },
        'joy.clipObjects': { [instance.clipId]: instance.objectId },
      },
    } as JoyProjectV3;
    const projected = projectV3ToDesktopDocuments(project);
    try {
      const { writeDesktopProjectExport } = (await vi.importActual(
        '../../cli/src/services/desktop-export.js',
      )) as {
        writeDesktopProjectExport: (
          project: JoyProjectV3,
          sources: Readonly<Record<string, string>>,
          outputPath: string,
          exportedAt?: Date,
        ) => Promise<void>;
      };
      await writeDesktopProjectExport(
        project,
        { 'asset-video': mediaPath },
        outputPath,
        new Date(),
      );
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    const exportedPackage = JSON.parse(readFileSync(outputPath, 'utf8')) as unknown;
    const records = new Map<string, string>();
    const storage = {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => records.set(key, value),
      removeItem: (key: string) => records.delete(key),
    };
    const parsed = parseProjectPackage(exportedPackage);
    const importedAssets: Array<{ assetId: string; bytes: Uint8Array }> = [];
    const imported = await importProjectPackage(storage, parsed, {
      collision: 'rename',
      createId: () => 'p0-desktop-roundtrip',
      now: () => '2026-01-02T00:00:00.000Z',
      assetWriter: async (asset) => {
        importedAssets.push({
          assetId: asset.assetId,
          bytes: new Uint8Array(await asset.blob.arrayBuffer()),
        });
      },
    });
    const bundle = readProjectBundle(storage, imported.entry);
    const reopened = new EditorSession(storage, bundle.timeline, bundle.visual, {
      lookInstances: bundle.lookInstances,
    });
    rmSync(directory, { recursive: true, force: true });
    expect(reopened.timelineProject.schemaVersion).toBe(0);
    expect(reopened.visualProject.schemaVersion).toBe(1);
    const expectedCompositions = Object.fromEntries(
      Object.entries(projected.visual.compositions).map(([id, composition]) => [
        id,
        {
          ...composition,
          tracks: composition.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) =>
              clip.kind === 'video'
                ? { ...clip, assetId: imported.assetIdMap[clip.assetId] ?? clip.assetId }
                : clip,
            ),
          })),
        },
      ]),
    );
    expect(reopened.visualProject.compositions).toEqual(expectedCompositions);
    expect(reopened.timelineProject.compositions.root?.tracks[0]?.clips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: instance.clipId,
          startUs: 1_250_000,
          durationUs: 2_000_000,
          sourceInUs: 250_000,
        }),
      ]),
    );
    expect(reopened.visualProject.pluginData['joy.contentTemplates']).toMatchObject({
      instances: { [titleInstanceId(instance)]: instance },
    });
    expect(reopened.visualProject.assets[imported.assetIdMap['asset-video']!]).toMatchObject({
      bytes: media.byteLength,
      sha256: hash(media),
      descriptor: { mimeType: 'video/mp4' },
    });
    expect(importedAssets).toEqual([
      { assetId: imported.assetIdMap['asset-video'], bytes: new Uint8Array(media) },
    ]);
    expect(imported.missingAssetIds).toEqual([]);
  });

  it('wraps long title text into the stored layout lines', () => {
    const instance = makeInstance(
      'joy.p0.title',
      400,
      'A deliberately long bilingual headline that must wrap across several measured lines before it reaches the safe title boundary',
    );
    expect(instance.layout.primaryLines.length).toBeGreaterThan(1);
    expect(instance.layout.primaryLines.join(' ')).toContain('bilingual headline');
  });

  it.each([
    ['joy.p0.lower-third', 400, 'An independent Latin title', 'ltr'],
    [
      'joy.p0.lower-third',
      700,
      '\u0645\u062f\u06cc\u0631\u06cc\u062a \u0645\u062d\u0635\u0648\u0644',
      'rtl',
    ],
    ['joy.p0.title', 400, 'A centered title that wraps when its width is constrained', 'ltr'],
    [
      'joy.p0.title',
      700,
      '\u0639\u0646\u0648\u0627\u0646 \u0641\u0627\u0631\u0633\u06cc \u0628\u0631\u0627\u06cc \u067e\u06cc\u0634\u200c\u0646\u0645\u0627\u06cc\u0634',
      'rtl',
    ],
  ] as const)(
    'covers %s with non-default text and weight %s',
    async (templateId, weight, text, direction) => {
      const instance = makeInstance(templateId, weight, text, direction);
      expect(instance.layout.primaryLines.join(' ')).toContain(text.split(' ')[0] ?? text);
      const frame = buildTitleSceneFrame(instance, instance.objectId, 2_000_000, 360_000, {
        widthPx: 1080,
        heightPx: 1920,
        fontFaces: scenePaintFontDescriptors(),
        frameRate: { num: 30, den: 1 },
        locale: direction === 'rtl' ? 'fa-IR' : 'en',
      });
      expect(frame.paintLines.primary.length).toBeGreaterThan(0);
      const capture = await captureTitleMarkup(frame.markup, 1080, 1920);
      try {
        expect(capture.png.byteLength).toBeGreaterThan(0);
      } finally {
        await capture.close();
      }
    },
    180_000,
  );

  it('samples fade, slide and hold motion at clip-local start and end boundaries', () => {
    const fade = makeInstance('joy.p0.title', 400, 'Fade', 'ltr', 'joy-fade-in');
    const slide = makeInstance('joy.p0.title', 400, 'Slide');
    const hold = makeInstance('joy.p0.title', 400, 'Hold', 'ltr', 'hold');
    expect(
      buildTitleSceneFrame(fade, fade.objectId, 2_000_000, 0, {
        widthPx: 1080,
        heightPx: 1920,
        fontFaces: scenePaintFontDescriptors(),
      }).motion.opacity,
    ).toBe(0);
    expect(
      buildTitleSceneFrame(slide, slide.objectId, 2_000_000, 0, {
        widthPx: 1080,
        heightPx: 1920,
        fontFaces: scenePaintFontDescriptors(),
      }).motion.translateYPx,
    ).toBeGreaterThan(0);
    expect(
      buildTitleSceneFrame(hold, hold.objectId, 2_000_000, 0, {
        widthPx: 1080,
        heightPx: 1920,
        fontFaces: scenePaintFontDescriptors(),
      }).motion.opacity,
    ).toBe(1);
    expect(
      buildTitleSceneFrame(fade, fade.objectId, 2_000_000, 2_000_000, {
        widthPx: 1080,
        heightPx: 1920,
        fontFaces: scenePaintFontDescriptors(),
      }).motion.opacity,
    ).toBe(0);
  });

  it('uses non-zero clip starts and half-open start/end activation boundaries', async () => {
    const context = projectContext();
    const response = await runP0DesktopHandoff(
      [99_999, 100_000, 1_099_999, 1_100_000].map((timeUs, index) => ({
        id: `boundary-${index}`,
        kind: 'sync' as const,
        context,
        timeUs,
      })),
    );
    expect(operationResult(response, 'boundary-0').surfaceIds).toHaveLength(0);
    expect(operationResult(response, 'boundary-1').surfaceIds).toContain(
      'object-test-joy.p0.title-400',
    );
    expect(operationResult(response, 'boundary-2').surfaceIds).toContain(
      'object-test-joy.p0.title-400',
    );
    expect(operationResult(response, 'boundary-3').surfaceIds).toHaveLength(0);
    expect(response.cleanup).toMatchObject({ retainedFrameBytes: 0, hosts: 0 });
  }, 180_000);

  it('captures through the real desktop surface cache and preserves transparent RGBA edges', async () => {
    const context = projectContext();
    const response = await runP0DesktopHandoff([
      { id: 'capture', kind: 'capture', context, timeUs: 360_000, width: 1080, height: 1920 },
    ]);
    const frame = operationResult(response, 'capture');
    const bitmap = frame.surfaces['object-test-joy.p0.title-400'];
    expect(frame.error).toBeUndefined();
    expect(bitmap).toBeDefined();
    expect(bitmap?.data.byteLength).toBe(1080 * 1920 * 4);
    expect(bitmap?.data[3]).toBe(0);
    expect(bitmap?.data[bitmap.data.length - 1]).toBe(0);
    expect(response.cleanup).toMatchObject({ retainedFrameBytes: 0, hosts: 0 });
  }, 180_000);

  it('invalidates cached pixels after an edit and produces stable repeated hashes', async () => {
    const original = makeInstance('joy.p0.title', 400, 'First title');
    const context = projectContext(original);
    const edited = makeInstance('joy.p0.title', 400, 'Changed title');
    const response = await runP0DesktopHandoff([
      { id: 'first', kind: 'capture', context, timeUs: 360_000, width: 320, height: 568 },
      { id: 'repeat', kind: 'capture', context, timeUs: 360_000, width: 320, height: 568 },
      {
        id: 'edited',
        kind: 'capture',
        context: projectContext(edited),
        timeUs: 360_000,
        width: 320,
        height: 568,
      },
    ]);
    const first = operationResult(response, 'first').surfaces[original.objectId];
    const repeat = operationResult(response, 'repeat').surfaces[original.objectId];
    const afterEdit = operationResult(response, 'edited').surfaces[edited.objectId];
    expect(first).toBeDefined();
    expect(repeat).toBeDefined();
    expect(hash(first!.data)).toBe(hash(repeat!.data));
    expect(afterEdit).toBeDefined();
    expect(hash(afterEdit!.data)).not.toBe(hash(first!.data));
  }, 180_000);

  it('produces identical RGBA across repeated captures from shared title-frame inputs', async () => {
    const instance = makeInstance('joy.p0.title', 700, 'Parity title');
    const frame = buildTitleSceneFrame(instance, titleInstanceId(instance), 1_000_000, 360_000, {
      widthPx: 1080,
      heightPx: 1920,
      fontFaces: scenePaintFontDescriptors(),
      frameRate: { num: 30, den: 1 },
      locale: 'en',
    });
    expect(frame.instanceId).toBe(titleInstanceId(instance));
    const context = projectContext(instance);
    const response = await runP0DesktopHandoff([
      { id: 'desktop', kind: 'capture', context, timeUs: 360_000, width: 320, height: 568 },
      { id: 'cli-style', kind: 'capture', context, timeUs: 360_000, width: 320, height: 568 },
    ]);
    const desktop = operationResult(response, 'desktop').surfaces[instance.objectId];
    const cliStyle = operationResult(response, 'cli-style').surfaces[instance.objectId];
    expect(desktop?.data).toEqual(cliStyle?.data);
  }, 180_000);

  it('keeps only the current RGBA frame and cancels capture with host cleanup', async () => {
    const context = projectContext();
    const response = await runP0DesktopHandoff([
      { id: 'first', kind: 'capture', context, timeUs: 360_000, width: 320, height: 568 },
      { id: 'second', kind: 'capture', context, timeUs: 390_000, width: 320, height: 568 },
      { id: 'cancel', kind: 'cancel', context, timeUs: 400_000, width: 320, height: 568 },
    ]);
    expect(operationResult(response, 'second').metrics.retainedFrameBytes).toBe(320 * 568 * 4);
    expect(operationResult(response, 'cancel').error).toMatch(/^AbortError:/);
    expect(operationResult(response, 'cancel').metrics).toMatchObject({
      retainedFrameBytes: 0,
      hosts: 0,
    });
    expect(response.cleanup).toMatchObject({ retainedFrameBytes: 0, hosts: 0 });
  }, 180_000);

  it('retains overlapping title objects in their declared layer order', async () => {
    const first = makeInstance('joy.p0.lower-third', 400, 'Lower layer');
    const second = makeInstance('joy.p0.title', 700, 'Upper layer');
    const source = buildHistoricalSchemaProjects().v3;
    const root = source.compositions.root!;
    const ordered = {
      ...source,
      compositions: {
        ...source.compositions,
        root: {
          ...root,
          tracks: root.tracks.map((track) => ({
            ...track,
            clips: [
              ...track.clips,
              ...[first, second].map((instance) => ({
                kind: 'video' as const,
                id: instance.clipId,
                startUs: 0,
                durationUs: 1_000_000,
                assetId: 'asset-video',
                sourceInUs: 0,
              })),
            ],
          })),
        },
      },
      visualObjects: {
        ...source.visualObjects,
        ...[first, second].reduce<Record<string, JoyProjectV1['visualObjects'][string]>>(
          (objects, instance) => {
            objects[instance.objectId] = {
              id: instance.objectId,
              kind: 'html-scene',
              scenePackageId: instance.templateId,
              transform: {
                x: 0,
                y: 0,
                scaleX: 1,
                scaleY: 1,
                rotationDeg: 0,
                opacity: 1,
                crop: { left: 0, top: 0, right: 0, bottom: 0 },
              },
            };
            return objects;
          },
          {},
        ),
      },
      pluginData: {
        ...source.pluginData,
        'joy.contentTemplates': {
          version: 1,
          instances: { [titleInstanceId(first)]: first, [titleInstanceId(second)]: second },
        },
        'joy.clipObjects': {
          [first.clipId]: first.objectId,
          [second.clipId]: second.objectId,
        },
      },
      universalTimeline: {
        schemaVersion: 1 as const,
        items: [
          {
            id: first.clipId,
            compositionId: 'root',
            trackId: 'video-track',
            elementKind: 'html-scene' as const,
            startUs: 0,
            durationUs: 1_000_000,
            source: { kind: 'object' as const, id: first.objectId },
            withinTrackOrder: 2,
          },
          {
            id: second.clipId,
            compositionId: 'root',
            trackId: 'video-track',
            elementKind: 'html-scene' as const,
            startUs: 0,
            durationUs: 1_000_000,
            source: { kind: 'object' as const, id: second.objectId },
            withinTrackOrder: 3,
          },
        ],
      },
    } as JoyProjectV3;
    const projected = projectV3ToDesktopDocuments(ordered);
    const projection = projected.timeline;
    expect(projection.universalTimeline.items.map((item) => item.withinTrackOrder)).toEqual([2, 3]);
    expect(projection.universalTimeline.items.map((item) => item.source)).toEqual([
      { kind: 'object', id: first.objectId },
      { kind: 'object', id: second.objectId },
    ]);
    const browser = await runP0DesktopHandoff([
      {
        id: 'ordered-overlap',
        kind: 'capture',
        context: { visual: projected.visual, timeline: projection.project },
        timeUs: 360_000,
        width: 320,
        height: 568,
      },
    ]);
    const orderedCapture = operationResult(browser, 'ordered-overlap');
    expect(orderedCapture.error).toBeUndefined();
    expect(orderedCapture.surfaceIds).toEqual([first.objectId, second.objectId]);
    expect(Object.keys(orderedCapture.surfaces)).toEqual([first.objectId, second.objectId]);
  }, 180_000);

  it('occludes lower-track titles with upper video in production compositor pixels', async () => {
    const lower = makeInstance('joy.p0.lower-third', 400, 'Lower title');
    const upper = makeInstance('joy.p0.title', 700, 'Upper title');
    const context = compositorContext(lower, upper);
    const reversedContext = compositorContext(lower, upper, true);
    const captureResponse = await runP0DesktopHandoff([
      {
        id: 'compositor-surfaces',
        kind: 'capture',
        context,
        timeUs: 360_000,
        width: 540,
        height: 960,
      },
    ]);
    const captured = operationResult(captureResponse, 'compositor-surfaces');
    expect(captured.error).toBeUndefined();
    const lowerSurface = captured.surfaces[lower.objectId];
    const upperSurface = captured.surfaces[upper.objectId];
    expect(lowerSurface).toBeDefined();
    expect(upperSurface).toBeDefined();
    if (lowerSurface === undefined || upperSurface === undefined)
      throw new Error('Desktop surface cache did not return both real title surfaces');

    const videoData = new Uint8Array(540 * 960 * 4);
    for (let y = 0; y < 960; y++) {
      for (let x = 250; x < 350; x++) {
        const offset = (y * 540 + x) * 4;
        videoData[offset] = 20;
        videoData[offset + 1] = 220;
        videoData[offset + 2] = 40;
        videoData[offset + 3] = 255;
      }
    }
    const surfaces = {
      [lower.objectId]: lowerSurface,
      [upper.objectId]: upperSurface,
    };
    const video = {
      'compositor-video': { width: 540, height: 960, data: videoData },
    };
    const completeFrame = compositorFrame(lower, upper, true);
    const titleFrame: RenderFrameIR = {
      ...completeFrame,
      nodes: completeFrame.nodes.filter((node) => node.id !== 'compositor-video'),
    };
    const videoOnlyFrame: RenderFrameIR = {
      ...completeFrame,
      nodes: completeFrame.nodes.filter((node) => node.id === 'compositor-video'),
    };
    const titleOnly = await renderP0DesktopCompositorFrame(titleFrame, context, 360_000, surfaces);
    const videoOnly = await renderP0DesktopCompositorFrame(
      videoOnlyFrame,
      context,
      360_000,
      surfaces,
      video,
    );
    const composited = await renderP0DesktopCompositorFrame(
      completeFrame,
      context,
      360_000,
      surfaces,
      video,
    );
    const reversed = await renderP0DesktopCompositorFrame(
      completeFrame,
      reversedContext,
      360_000,
      surfaces,
      video,
    );

    const lowerPixels = Buffer.from(lowerSurface.data);
    const findLowerPixel = (minX: number, maxX: number) => {
      for (let y = 0; y < lowerSurface.height; y++) {
        for (let x = minX; x < maxX; x++) {
          if (lowerPixels[(y * lowerSurface.width + x) * 4 + 3]! > 0) return { x, y };
        }
      }
      throw new Error(`No rendered lower-title pixels found in x=${minX}..${maxX}`);
    };
    const opaqueTitlePixel = findLowerPixel(40, 100);
    const transparentTitlePixel = findLowerPixel(100, lowerSurface.width - 250);
    const opaquePoint = { x: opaqueTitlePixel.x + 250, y: opaqueTitlePixel.y };
    const transparentPoint = { x: transparentTitlePixel.x + 250, y: transparentTitlePixel.y };
    expect(opaquePoint.x).toBeLessThan(350);
    expect(transparentPoint.x).toBeGreaterThanOrEqual(350);

    const opaqueComposited = pixelAt(
      composited.data,
      composited.width,
      opaquePoint.x,
      opaquePoint.y,
    );
    const opaqueVideoOnly = pixelAt(videoOnly.data, videoOnly.width, opaquePoint.x, opaquePoint.y);
    expect(opaqueComposited).toEqual(opaqueVideoOnly);

    const transparentComposited = pixelAt(
      composited.data,
      composited.width,
      transparentPoint.x,
      transparentPoint.y,
    );
    const transparentTitleOnly = pixelAt(
      titleOnly.data,
      titleOnly.width,
      transparentPoint.x,
      transparentPoint.y,
    );
    const transparentBackground = pixelAt(
      videoOnly.data,
      videoOnly.width,
      transparentPoint.x,
      transparentPoint.y,
    );
    expect(transparentComposited).toEqual(transparentTitleOnly);
    expect(transparentComposited).not.toEqual(transparentBackground);

    const reversePointForward = pixelAt(
      composited.data,
      composited.width,
      opaquePoint.x,
      opaquePoint.y,
    );
    const reversePointReversed = pixelAt(
      reversed.data,
      reversed.width,
      opaquePoint.x,
      opaquePoint.y,
    );
    expect(reversePointReversed).not.toEqual(reversePointForward);
  }, 180_000);

  it.each([
    [
      'track disabled',
      (context: ReturnType<typeof projectContext>) => ({
        ...context,
        visual: {
          ...context.visual,
          compositions: {
            ...context.visual.compositions,
            root: {
              ...context.visual.compositions.root!,
              tracks: context.visual.compositions.root!.tracks.map((track) => ({
                ...track,
                enabled: false,
              })),
            },
          },
        },
      }),
    ],
    ['clip outside its half-open window', (context: ReturnType<typeof projectContext>) => context],
    [
      'object removed',
      (context: ReturnType<typeof projectContext>) => ({
        ...context,
        visual: { ...context.visual, visualObjects: {} },
      }),
    ],
    [
      'instance removed',
      (context: ReturnType<typeof projectContext>) => ({
        ...context,
        visual: {
          ...context.visual,
          pluginData: { ...context.visual.pluginData, 'joy.contentTemplates': { instances: {} } },
        },
      }),
    ],
  ] as const)(
    'evicts surfaces when %s',
    async (label, update) => {
      const context = projectContext();
      const stale =
        label === 'track disabled'
          ? projectContext(undefined, { enabled: false })
          : update(context);
      const operations: P0DesktopHandoffOperation[] = [
        { id: 'initial', kind: 'sync', context, timeUs: 200_000 },
        {
          id: 'stale',
          kind: 'sync',
          context: stale,
          timeUs: label === 'clip outside its half-open window' ? 1_100_000 : 200_000,
        },
      ];
      const response = await runP0DesktopHandoff(operations);
      expect(operationResult(response, 'initial').error).toBeUndefined();
      expect(operationResult(response, 'stale').surfaceIds).toHaveLength(0);
      expect(operationResult(response, 'stale').metrics.hosts).toBe(0);
      expect(response.cleanup).toMatchObject({ retainedFrameBytes: 0, hosts: 0 });
    },
    180_000,
  );

  it.each([
    ['joy.p0.lower-third', 400, 'A thoughtful bilingual title for JOY', 'ltr'],
    ['joy.p0.lower-third', 700, 'مدیریت محصول و روایت تصویری', 'rtl'],
    [
      'joy.p0.title',
      400,
      'A centered title with a deliberately long line that wraps cleanly',
      'ltr',
    ],
    ['joy.p0.title', 700, 'عنوان فارسی برای پیش‌نمایش', 'rtl'],
  ] as const)(
    'renders %s weight %s with bundled fonts and stable pixels',
    async (templateId, weight, text, direction) => {
      const instance = makeInstance(templateId, weight, text, direction);
      const frame = buildTitleSceneFrame(instance, instance.objectId, 2_000_000, 360_000, {
        widthPx: 1080,
        heightPx: 1920,
        fontFaces: scenePaintFontDescriptors(),
        frameRate: { num: 30, den: 1 },
        locale: direction === 'rtl' ? 'fa-IR' : 'en',
      });
      const first = await captureTitleMarkup(frame.markup, 1080, 1920);
      const second = await captureTitleMarkup(frame.markup, 1080, 1920);
      try {
        expect(first.png.byteLength).toBeGreaterThan(0);
        expect(hash(first.png)).toBe(hash(second.png));
        expect(frame.paintLines.primary.join(' ')).toContain(text.split(' ')[0] ?? text);
        expect(frame.motion.opacity).toBeGreaterThan(0);
      } finally {
        await first.close();
        await second.close();
      }
    },
    180_000,
  );

  it('matches production renderTitleFrames and desktop title RGBA', async () => {
    const durationUs = 3_000_000;
    const fps = { num: 4, den: 1 };
    const sampleFrames = [1, 6, 11] as const;
    const cases = (['joy.p0.lower-third', 'joy.p0.title'] as const).flatMap((templateId) =>
      ([400, 700] as const).flatMap((weight) =>
        (
          [
            ['latin', 'JOY Media title', 'ltr'],
            ['persian', '\u0633\u0644\u0627\u0645 \u062c\u0647\u0627\u0646', 'rtl'],
          ] as const
        ).map(([language, primary, direction]) => {
          const font = P0_TITLE_FONTS.find(
            (entry) => entry.subset === 'arabic' && entry.weight === weight,
          );
          if (!font) throw new Error(`Canonical font descriptor missing for ${weight}`);
          const instanceId = `parity-${templateId}-${weight}-${language}`;
          const compiled = compileTitleInstance(
            {
              instanceId,
              templateId,
              clipId: `clip-${instanceId}`,
              objectId: `object-${instanceId}`,
              lines: { primary, secondary: 'Parity' },
              direction,
              font: { family: 'Noto Sans Arabic', weight },
              fontSha256: font.sha256,
              placement: { xPx: 20, yPx: 420, maxWidthPx: 680, safeInsetPx: 10 },
              motion: { presetId: 'joy-slide-up', inUs: 1_000_000, outUs: 1_000_000 },
              clipDurationUs: durationUs,
              frame: { widthPx: 720, heightPx: 1280 },
            },
            (text, size) => [...text].length * size * 0.55,
          );
          if (!compiled.ok) throw new Error(`P0 parity fixture failed: ${compiled.code}`);
          return { language, instance: compiled.instance, instanceId };
        }),
      ),
    );
    const sources = cases.map(({ instance, instanceId }) => ({
      instanceId,
      instance,
      startUs: 0,
      durationUs,
      trackOrder: 0,
    }));
    const rendered = await renderTitleFrames(sources, { width: 720, height: 1280, fps });
    const operations = cases.flatMap(({ instance, instanceId }) => {
      const sourceContext = projectContext(instance, { startUs: 0, durationUs });
      const context = {
        ...sourceContext,
        visual: {
          ...sourceContext.visual,
          compositions: {
            ...sourceContext.visual.compositions,
            [sourceContext.visual.rootCompositionId]: {
              ...sourceContext.visual.compositions[sourceContext.visual.rootCompositionId]!,
              width: 720,
              height: 1280,
            },
          },
        },
      };
      return sampleFrames.map((sampleFrame) => ({
        id: `${instanceId}-${sampleFrame}`,
        kind: 'capture' as const,
        context,
        timeUs: sampleFrame * 250_000,
        width: 720,
        height: 1280,
      }));
    });
    try {
      const browser = await runP0DesktopHandoff(operations);
      for (const { instance, instanceId, language } of cases) {
        const layer = rendered.layers.find((entry) => entry.instanceId === instanceId);
        if (!layer) throw new Error(`CLI title layer missing for ${instanceId}`);
        for (const sampleFrame of sampleFrames) {
          const timeUs = sampleFrame * 250_000;
          const operationId = `${instanceId}-${sampleFrame}`;
          const operation = operationResult(browser, operationId);
          expect(operation.error, operationId).toBeUndefined();
          const surface = operation.surfaces[instance.objectId];
          if (!surface) throw new Error(`Desktop RGBA missing for ${operationId}`);
          const png = readFileSync(
            layer.inputPattern.replace('%05d', String(sampleFrame).padStart(5, '0')),
          );
          const cliRgba = decodeFilterZeroRgbaPng(png);
          const desktopRgba = Buffer.from(surface.data);
          let firstDifference = -1;
          for (let index = 0; index < cliRgba.length; index++) {
            if (cliRgba[index] !== desktopRgba[index]) {
              firstDifference = index;
              break;
            }
          }
          expect(
            firstDifference,
            `${instance.templateId} weight ${instance.font.weight} ${language} at ${timeUs}us; first differing byte ${firstDifference}`,
          ).toBe(-1);
        }
      }
    } finally {
      rendered.cleanup();
    }
  }, 300_000);

  it('keeps title text inside the safe area and paints the declared plate', async () => {
    const instance = makeInstance('joy.p0.lower-third', 400, 'Placement check', 'ltr', 'hold');
    const durationUs = 1_000_000;
    const context = projectContext(instance, { startUs: 0, durationUs });
    const template = P0_TEMPLATES[instance.templateId];
    expect(template.plate.kind).toBe('translucent-rectangle');
    const expectedPlate = {
      x: instance.placement.xPx,
      y: instance.placement.yPx,
      width: instance.placement.maxWidthPx,
      height: instance.layout.boxHeightPx,
    };
    const anchorX =
      template.alignment === 'center'
        ? instance.placement.xPx + instance.placement.maxWidthPx / 2
        : instance.placement.xPx + template.plate.paddingX;
    const primaryTop = instance.placement.yPx + template.plate.paddingY;
    const expectedTextBoxes = [
      ...instance.layout.primaryLines.map((text, index) => ({
        text,
        x: template.alignment === 'center' ? instance.placement.xPx : anchorX,
        width:
          template.alignment === 'center'
            ? instance.placement.maxWidthPx
            : instance.placement.maxWidthPx - template.plate.paddingX,
        y: primaryTop + index * instance.layout.lineHeightPx,
        height: instance.layout.lineHeightPx,
      })),
      ...instance.layout.secondaryLines.map((text, index) => ({
        text,
        x: template.alignment === 'center' ? instance.placement.xPx : anchorX,
        width:
          template.alignment === 'center'
            ? instance.placement.maxWidthPx
            : instance.placement.maxWidthPx - template.plate.paddingX,
        y:
          primaryTop +
          instance.layout.primaryLines.length * instance.layout.lineHeightPx +
          index *
            Math.round(instance.layout.secondarySizePx * P0_PAINT_POLICY.lineHeightMultiplier),
        height: Math.round(instance.layout.secondarySizePx * P0_PAINT_POLICY.lineHeightMultiplier),
      })),
    ];
    const response = await runP0DesktopHandoff([
      {
        id: 'placement',
        kind: 'capture',
        context: {
          ...context,
          visual: {
            ...context.visual,
            compositions: {
              ...context.visual.compositions,
              [context.visual.rootCompositionId]: {
                ...context.visual.compositions[context.visual.rootCompositionId]!,
                width: 1080,
                height: 1920,
              },
            },
          },
        },
        timeUs: 500_000,
        width: 1080,
        height: 1920,
      },
    ]);
    const result = operationResult(response, 'placement');
    expect(result.error).toBeUndefined();
    const surface = result.surfaces[instance.objectId];
    if (!surface) throw new Error('Placement capture returned no title surface');
    const pixels = Buffer.from(surface.data);
    const plateBounds = { left: 1080, top: 1920, right: -1, bottom: -1 };
    let textPixelCount = 0;
    for (let y = 0; y < surface.height; y++) {
      for (let x = 0; x < surface.width; x++) {
        const offset = (y * surface.width + x) * 4;
        if (
          pixels[offset] === 0 &&
          pixels[offset + 1] === 0 &&
          pixels[offset + 2] === 0 &&
          pixels[offset + 3]! > 0
        ) {
          textPixelCount++;
          plateBounds.left = Math.min(plateBounds.left, x);
          plateBounds.top = Math.min(plateBounds.top, y);
          plateBounds.right = Math.max(plateBounds.right, x);
          plateBounds.bottom = Math.max(plateBounds.bottom, y);
        }
        if (
          pixels[offset]! > 160 &&
          pixels[offset + 1]! > 160 &&
          pixels[offset + 2]! > 160 &&
          pixels[offset + 3]! > 0
        ) {
          const inside = expectedTextBoxes.some(
            (box) =>
              x >= box.x - 1 &&
              x <= box.x + box.width + 1 &&
              y >= box.y - 1 &&
              y <= box.y + box.height + 1,
          );
          expect(inside, `text raster pixel ${x},${y} is outside the declared text boxes`).toBe(
            true,
          );
        }
      }
    }
    expect(textPixelCount).toBeGreaterThan(0);
    expect(plateBounds.left).toBeGreaterThanOrEqual(expectedPlate.x - 1);
    expect(plateBounds.top).toBeGreaterThanOrEqual(expectedPlate.y - 1);
    expect(plateBounds.right).toBeLessThanOrEqual(expectedPlate.x + expectedPlate.width);
    expect(plateBounds.bottom).toBeLessThanOrEqual(expectedPlate.y + expectedPlate.height);
    expect(plateBounds.left).toBeLessThanOrEqual(expectedPlate.x + 1);
    expect(plateBounds.top).toBeLessThanOrEqual(expectedPlate.y + 1);
    expect(plateBounds.right).toBeGreaterThanOrEqual(expectedPlate.x + expectedPlate.width - 2);
    expect(plateBounds.bottom).toBeGreaterThanOrEqual(expectedPlate.y + expectedPlate.height - 2);
  }, 180_000);
});

function decodeFilterZeroRgbaPng(png: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!png.subarray(0, 8).equals(signature)) throw new Error('CLI title output is not a PNG');
  let width = 0;
  let height = 0;
  let offset = 8;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('CLI PNG is not 8-bit RGBA');
    } else if (type === 'IDAT') compressed.push(data);
    offset += length + 12;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const rowBytes = width * 4;
  const rgba = Buffer.allocUnsafe(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const source = y * (rowBytes + 1);
    if (raw[source] !== 0) throw new Error('CLI PNG uses a nonzero row filter');
    raw.copy(rgba, y * rowBytes, source + 1, source + 1 + rowBytes);
  }
  return rgba;
}
