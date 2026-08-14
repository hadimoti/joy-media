import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { buildDualLensProjection } from './dual-lens-model.js';
import type { HistoryEntry } from './editor-session.js';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';

describe('Dual Lens Creative Document projections', () => {
  it('projects the same complete element taxonomy into Dual Lens Time', () => {
    const { timeline, visual } = buildTimelineElementsShowcase();
    const projection = buildDualLensProjection(timeline, visual, 7_000_000, []);
    const kinds = new Set(
      projection.lanes
        .filter((lane) => !lane.advanced)
        .flatMap((lane) => lane.items)
        .flatMap((item) => (item.elementKind === undefined ? [] : [item.elementKind])),
    );

    expect(kinds).toEqual(
      new Set([
        'video',
        'overlay',
        'text',
        'caption',
        'motion',
        'effect',
        'filter',
        'scene3d',
        'adjust',
        'audio',
      ]),
    );
  });

  it('extends Time view through the actual end of long authored media', () => {
    const project = buildReferenceSpikeProject();
    const root = project.compositions[project.rootCompositionId]!;
    const firstTrack = root.tracks[0]!;
    const firstClip = firstTrack.clips[0]!;
    const longProject = {
      ...project,
      compositions: {
        ...project.compositions,
        [project.rootCompositionId]: {
          ...root,
          durationUs: 60_000_000,
          tracks: [
            {
              ...firstTrack,
              clips: [{ ...firstClip, startUs: 0, durationUs: 116_000_000 }],
            },
          ],
        },
      },
    };

    expect(buildDualLensProjection(longProject, INITIAL_EDITOR_PROJECT, 0, []).durationUs).toBe(
      116_000_000,
    );
  });

  it('traces only the media chain active at the current frame', () => {
    const project = buildReferenceSpikeProject();
    const atFive = buildDualLensProjection(project, INITIAL_EDITOR_PROJECT, 5_000_000, []);
    const atTwelve = buildDualLensProjection(project, INITIAL_EDITOR_PROJECT, 12_000_000, []);

    expect([...atFive.traceNodeIds]).toEqual(
      expect.arrayContaining(['clip:intro', 'clip:b-roll-a', 'output:program']),
    );
    expect(atFive.traceNodeIds.has('clip:product')).toBe(false);
    expect(atFive.traceNodeIds.has('clip:outro')).toBe(false);
    expect([...atTwelve.traceNodeIds]).toEqual(
      expect.arrayContaining(['clip:product', 'clip:b-roll-a', 'output:program']),
    );
    expect(atTwelve.traceNodeIds.has('clip:intro')).toBe(false);
  });

  it('keeps advanced data lanes available but explicitly classified', () => {
    const projection = buildDualLensProjection(
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
      2_000_000,
      [],
    );
    const advanced = projection.lanes.filter((lane) => lane.advanced);

    expect(advanced.map((lane) => lane.label)).toEqual([
      'Text',
      'Audio',
      'Captions',
      'Script',
      'Prompts',
      'Model outputs',
      'Agent change sets',
    ]);
    expect(advanced.find((lane) => lane.label === 'Captions')?.items).toEqual([
      expect.objectContaining({
        id: 'caption:caption-clip-1',
        startUs: 1_000_000,
        endUs: 5_000_000,
      }),
    ]);
    expect(projection.traceNodeIds.has('data:captions:captions-fa')).toBe(true);
  });

  it('projects generation provenance and KiloCode change sets without a second engine', () => {
    const history: HistoryEntry[] = [
      {
        id: 'history-agent-1',
        source: 'document',
        label: 'Agent: generate intro',
        direction: 'current',
        commandCount: 1,
        sequence: 1,
      },
    ];
    const creative = {
      ...INITIAL_EDITOR_PROJECT,
      assets: {
        ...INITIAL_EDITOR_PROJECT.assets,
        'asset-intro': {
          id: 'asset-intro',
          kind: 'video' as const,
          displayName: 'Generated intro',
          generationProvenance: {
            providerId: 'local-worker',
            modelId: 'flux-dev',
            modelVersion: '2026-07',
            prompt: 'Soft purple product reveal',
            seed: 42,
            inputAssetHashes: [],
            parameters: {},
            generatedAssetId: 'asset-intro',
            createdAt: '2026-07-26T00:00:00.000Z',
          },
        },
      },
    };

    const projection = buildDualLensProjection(
      buildReferenceSpikeProject(),
      creative,
      5_000_000,
      history,
    );

    expect(projection.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'provider:local-worker:flux-dev', kind: 'provider' }),
        expect.objectContaining({ id: 'agent:kilocode', kind: 'agent' }),
      ]),
    );
    expect(projection.traceNodeIds.has('provider:local-worker:flux-dev')).toBe(true);
    expect(projection.lanes.find((lane) => lane.label === 'Prompts')?.items[0]).toEqual(
      expect.objectContaining({
        label: 'Soft Purple Product Reveal',
        icon: 'prompt',
        startUs: 0,
        endUs: 10_000_000,
      }),
    );
  });
});
