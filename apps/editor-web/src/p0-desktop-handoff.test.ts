import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { compileTitleInstance } from '@joy-media/motion-core';
import {
  createProjectPackage,
  importProjectPackage,
  parseProjectPackage,
  serializeProjectPackage,
} from './project-package.js';
import { EditorSession } from './editor-session.js';
import { readProjectBundle } from './project-lifecycle.js';
import { upsertCatalogProject } from './project-catalog.js';
import { P0_TITLE_FONTS } from './p0-title-fonts.js';
import {
  captureTitleMarkup,
  closeP0DesktopHandoff,
  prepareP0DesktopHandoff,
  runP0DesktopHandoff,
  type P0DesktopHandoffOperation,
} from './p0-desktop-handoff-harness.js';
import { buildTitleSceneFrame } from '@joy-media/motion-core';

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
    const projected = projectV3ToDesktopDocuments(buildHistoricalSchemaProjects().v3);
    const records = new Map<string, string>();
    const storage = {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => records.set(key, value),
      removeItem: (key: string) => records.delete(key),
    };
    const entry = {
      id: projected.visual.id,
      title: projected.visual.title,
      createdAt: projected.visual.createdAt,
      updatedAt: projected.visual.updatedAt,
      timelineProjectId: projected.timeline.project.id,
      visualProjectId: projected.visual.id,
    };
    upsertCatalogProject(storage, entry);
    new EditorSession(storage, projected.timeline.project, projected.visual, {
      lookInstances: projected.lookInstances,
    });
    const created = await createProjectPackage(entry, storage, {
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseProjectPackage(JSON.parse(serializeProjectPackage(created)));
    const imported = await importProjectPackage(storage, parsed, {
      collision: 'rename',
      createId: () => 'p0-desktop-roundtrip',
      now: () => '2026-01-02T00:00:00.000Z',
    });
    const bundle = readProjectBundle(storage, imported.entry);
    const reopened = new EditorSession(storage, bundle.timeline, bundle.visual, {
      lookInstances: bundle.lookInstances,
    });
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
    expect(imported.missingAssetIds).toContain(imported.assetIdMap['asset-video']);
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
      buildTitleSceneFrame(fade, fade.objectId, 2_000_000, 0, { widthPx: 1080, heightPx: 1920 })
        .motion.opacity,
    ).toBe(0);
    expect(
      buildTitleSceneFrame(slide, slide.objectId, 2_000_000, 0, { widthPx: 1080, heightPx: 1920 })
        .motion.translateYPx,
    ).toBeGreaterThan(0);
    expect(
      buildTitleSceneFrame(hold, hold.objectId, 2_000_000, 0, { widthPx: 1080, heightPx: 1920 })
        .motion.opacity,
    ).toBe(1);
    expect(
      buildTitleSceneFrame(fade, fade.objectId, 2_000_000, 2_000_000, {
        widthPx: 1080,
        heightPx: 1920,
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
});
