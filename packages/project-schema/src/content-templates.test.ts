import { describe, expect, it } from 'vitest';
import { validateContentInstances } from './content-templates.js';
import { validateJoyProjectV1 } from './v1.js';

const hash = `sha256:${'a'.repeat(64)}`;

function instance(instanceId: string, overrides: Record<string, unknown> = {}) {
  return {
    templateId: 'joy.p0.title',
    templateVersion: 1,
    templateSha256: hash,
    compilerVersion: 1,
    objectId: `object-${instanceId}`,
    clipId: `clip-${instanceId}`,
    lines: { primary: 'Main title', secondary: 'Subtitle' },
    font: { family: 'Noto Sans Arabic', weight: 400, sha256: hash },
    direction: 'auto',
    placement: { xPx: 100, yPx: 120, maxWidthPx: 1000, safeInsetPx: 40 },
    motion: { presetId: 'joy-fade-in', inUs: 100_000, outUs: 100_000 },
    layout: {
      primaryLines: ['Main title'],
      secondaryLines: ['Subtitle'],
      fontSizePx: 40,
      secondarySizePx: 24,
      lineHeightPx: 48,
      boxHeightPx: 120,
    },
    ...overrides,
  };
}

function project(
  instances: Record<string, unknown> = {
    first: instance('first'),
    second: instance('second', { templateId: 'joy.p0.lower-third' }),
  },
) {
  return {
    schemaVersion: 1,
    id: 'project-1',
    title: 'Content templates',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 1920,
        height: 1080,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 10_000_000,
        background: '#000000',
        tracks: [
          {
            id: 'visual-track',
            kind: 'video',
            name: 'Visual',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'clip-first',
                kind: 'video',
                startUs: 0,
                durationUs: 2_000_000,
                assetId: 'a',
                sourceInUs: 0,
              },
              {
                id: 'clip-second',
                kind: 'video',
                startUs: 2_000_000,
                durationUs: 2_000_000,
                assetId: 'b',
                sourceInUs: 0,
              },
            ],
          },
        ],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    captionDocuments: {},
    visualObjects: {
      'object-first': {
        id: 'object-first',
        kind: 'html-scene',
        scenePackageId: 'joy.p0.title',
        transform: transform(),
      },
      'object-second': {
        id: 'object-second',
        kind: 'html-scene',
        scenePackageId: 'joy.p0.lower-third',
        transform: transform(),
      },
    },
    pluginData: {
      'joy.contentTemplates': { version: 1, instances },
      'joy.clipObjects': { 'clip-first': 'object-first', 'clip-second': 'object-second' },
    },
  };
}

function transform() {
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}

function expectInvalid(doc: unknown) {
  expect(validateContentInstances(doc).length).toBeGreaterThan(0);
}

describe('content template instances', () => {
  it('accepts an absent content-template namespace', () => {
    const doc = project();
    delete (doc.pluginData as Record<string, unknown>)['joy.contentTemplates'];
    expect(validateContentInstances(doc)).toEqual([]);
  });

  it('accepts two valid instances bound to root visual clips', () => {
    expect(validateContentInstances(project())).toEqual([]);
  });

  it('rejects unknown fields in the namespace, instance, and nested closed objects', () => {
    const namespaceDoc = project() as unknown as {
      pluginData: Record<string, Record<string, unknown>>;
    };
    namespaceDoc.pluginData['joy.contentTemplates']!.extra = true;
    expectInvalid(namespaceDoc);
    expectInvalid(project({ first: instance('first', { surprise: true }) }));
    expectInvalid(
      project({
        first: instance('first', {
          lines: { primary: 'Main title', secondary: 'Subtitle', extra: true },
        }),
      }),
    );
    expectInvalid(
      project({
        first: instance('first', {
          font: { family: 'Noto Sans Arabic', weight: 400, sha256: hash, extra: true },
        }),
      }),
    );
    expectInvalid(
      project({
        first: instance('first', {
          placement: { xPx: 100, yPx: 120, maxWidthPx: 1000, safeInsetPx: 40, extra: true },
        }),
      }),
    );
    expectInvalid(
      project({
        first: instance('first', { motion: { presetId: 'hold', inUs: 0, outUs: 0, extra: true } }),
      }),
    );
    expectInvalid(
      project({
        first: instance('first', {
          layout: {
            primaryLines: ['a'],
            secondaryLines: [],
            fontSizePx: 40,
            secondarySizePx: 24,
            lineHeightPx: 48,
            boxHeightPx: 120,
            extra: true,
          },
        }),
      }),
    );
  });

  it('rejects an unsupported template id', () => {
    expectInvalid(project({ first: instance('first', { templateId: 'joy.p0.unknown' }) }));
  });

  it('rejects a hash that does not use the sha256 identity format', () => {
    expectInvalid(project({ first: instance('first', { templateSha256: 'sha256:ABC' }) }));
  });

  it('rejects an unsupported text direction', () => {
    expectInvalid(project({ first: instance('first', { direction: 'vertical' }) }));
  });

  it('rejects motion whose in and out times exceed the clip duration', () => {
    expectInvalid(
      project({
        first: instance('first', { motion: { presetId: 'hold', inUs: 1_500_000, outUs: 600_001 } }),
      }),
    );
  });

  it('rejects an instance referencing a missing clip', () => {
    expectInvalid(project({ first: instance('first', { clipId: 'clip-missing' }) }));
  });

  it('rejects a clip that participates in a transition', () => {
    const doc = project() as unknown as {
      compositions: Record<string, { transitions?: unknown[] }>;
    };
    doc.compositions.root!.transitions = [
      {
        id: 'transition-1',
        trackId: 'visual-track',
        leftClipId: 'clip-first',
        rightClipId: 'clip-second',
        type: 'dissolve',
        durationUs: 100_000,
      },
    ];
    expectInvalid(doc);
  });

  it('rejects an instance referencing a missing visual object', () => {
    const doc = project() as unknown as { visualObjects: Record<string, unknown> };
    delete doc.visualObjects['object-first'];
    expectInvalid(doc);
  });

  it('rejects a visual object whose scene package does not match the template', () => {
    const doc = project() as unknown as {
      visualObjects: Record<string, { scenePackageId?: string }>;
    };
    const object = doc.visualObjects['object-first']!;
    object.scenePackageId = 'joy.p0.lower-third';
    expectInvalid(doc);
  });

  it('rejects an object id not derived from the instance id', () => {
    expectInvalid(project({ first: instance('first', { objectId: 'object-other' }) }));
  });

  it('rejects duplicate object ids across instances', () => {
    expectInvalid(project({ second: instance('second', { objectId: 'object-first' }) }));
  });

  it('rejects wrapped lines that do not reproduce the source text', () => {
    const base = instance('first');
    expectInvalid(
      project({
        first: { ...base, layout: { ...base.layout, primaryLines: ['Main'] } },
        second: instance('second', { templateId: 'joy.p0.lower-third' }),
      }),
    );
  });

  it('rejects a blank primary line', () => {
    expectInvalid(
      project({ first: instance('first', { lines: { primary: '  ', secondary: '' } }) }),
    );
  });

  it('rejects more than two primary layout lines', () => {
    expectInvalid(
      project({
        first: instance('first', {
          layout: {
            primaryLines: ['a', 'b', 'c'],
            secondaryLines: [],
            fontSizePx: 40,
            secondarySizePx: 24,
            lineHeightPx: 48,
            boxHeightPx: 120,
          },
        }),
      }),
    );
  });

  it('rejects primary font sizes outside 24 to 48 pixels', () => {
    expectInvalid(
      project({
        first: instance('first', {
          layout: {
            primaryLines: ['Main title'],
            secondaryLines: ['Subtitle'],
            fontSizePx: 23,
            secondarySizePx: 24,
            lineHeightPx: 48,
            boxHeightPx: 120,
          },
        }),
      }),
    );
  });

  it('rejects a string longer than 512 Unicode code points', () => {
    expectInvalid(
      project({
        first: instance('first', { lines: { primary: '😀'.repeat(513), secondary: '' } }),
      }),
    );
  });

  it('reports malformed content-template data through the v1 project validator', () => {
    const doc = project({ first: instance('first', { templateSha256: 'invalid' }) });
    expect(validateJoyProjectV1(doc).map((entry) => entry.code)).toContain(
      'PROJECT_SCHEMA_CONTENT_TEMPLATE',
    );
  });
});
