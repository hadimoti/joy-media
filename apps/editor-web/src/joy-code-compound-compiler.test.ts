import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { canonicalBindingKey } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { compileJoyCodeCompoundDraft } from './joy-code-compound-compiler.js';

describe('Joy Code compound compiler', () => {
  it('compiles mixed timeline, title, caption, and transition operations against one base', () => {
    const result = compileJoyCodeCompoundDraft({
      planId: 'compound-1',
      baseRevision: 'rev-1',
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      registeredAssetIds: ['asset-a'],
      operations: [
        {
          id: 'title',
          dependsOn: [],
          kind: 'text.insertTemplate',
          templateId: 'clean-title',
          content: 'سلام',
          startUs: 2_000_000,
          durationUs: 2_000_000,
          placementPreset: 'center',
        },
        {
          id: 'caption',
          dependsOn: ['title'],
          kind: 'caption.setTemplate',
          captionClipId: 'caption-clip-1',
          templateId: 'joy-rtl-classic',
        },
        { id: 'burn', dependsOn: ['caption'], kind: 'caption.setBurnIn', enabled: true },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseRevision).toBe('rev-1');
    expect(result.proposalHash).toMatch(/^joy-code-proposal-[0-9a-f]{64}$/);
    expect(result.operationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.proposalHash).toBe(`joy-code-proposal-${result.operationDigest}`);
    expect(result.documentChanged).toBe(true);
    expect(result.document.visualObjects['text-clean-title-compound-1-0']).toBeDefined();
    expect(result.document.captionDocuments['captions-fa']?.styleRef).toBe('joy-rtl-classic');
    expect(result.document.pluginData['joy.captions.burnIn']).toBe(true);
    expect(result.groups.map((group) => group.kind)).toEqual(['text', 'caption', 'caption']);
  });

  it('is byte-stable and rejects any failed sub-operation without partial output', () => {
    const input = {
      planId: 'compound-2',
      baseRevision: 'rev-2',
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      registeredAssetIds: [],
      operations: [
        {
          id: 'bad',
          dependsOn: [],
          kind: 'text.insertTemplate' as const,
          templateId: 'missing',
          content: 'x',
          startUs: 0,
          durationUs: 1_000_000,
          placementPreset: 'center' as const,
        },
      ],
    };
    const first = compileJoyCodeCompoundDraft(input);
    const second = compileJoyCodeCompoundDraft(input);
    expect(first).toEqual(second);
    expect(first.ok).toBe(false);
  });

  it('compiles inspector keyframes into the universal property-animation document', () => {
    const result = compileJoyCodeCompoundDraft({
      planId: 'compound-motion',
      baseRevision: 'rev-motion',
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      registeredAssetIds: [],
      operations: [
        {
          id: 'opacity-key',
          dependsOn: [],
          kind: 'motion.setKeyframe',
          binding: {
            ownerKind: 'visual-object',
            ownerId: 'intro-title',
            propertyId: 'x',
            timeDomain: 'composition',
          },
          key: {
            kind: 'scalar',
            timeUs: 750_000,
            value: 0.6,
            interpolation: 'bezier',
            bezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const animation = Object.values(result.document.propertyAnimations ?? {})[0];
    expect(animation?.binding.ownerId).toBe('intro-title');
    expect(animation?.value).toMatchObject({
      kind: 'scalar',
      curve: {
        keyframes: [
          { timeUs: 0, value: 0, interpolation: 'linear' },
          { timeUs: 750_000, value: 0.6, interpolation: 'bezier' },
          { timeUs: 30_000_000, value: 300, interpolation: 'linear' },
        ],
      },
    });
    expect(result.groups[0]?.kind).toBe('motion');
  });

  it('rejects motion bindings outside the implemented visual-object domain', () => {
    const result = compileJoyCodeCompoundDraft({
      planId: 'compound-motion-invalid',
      baseRevision: 'rev-motion',
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      registeredAssetIds: [],
      operations: [
        {
          id: 'bad-key',
          dependsOn: [],
          kind: 'motion.setKeyframe',
          binding: {
            ownerKind: 'audio-clip',
            ownerId: 'clip-audio',
            propertyId: 'gain',
            timeDomain: 'audio-timeline',
          },
          key: { kind: 'scalar', timeUs: 0, value: 1, interpolation: 'linear' },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('JOY_CODE_MOTION_KEYFRAME_REJECTED');
    expect(result.error.message).toContain('not implemented');
  });

  it('applies the same binding restrictions when removing a keyframe', () => {
    const result = compileJoyCodeCompoundDraft({
      planId: 'compound-motion-remove-invalid',
      baseRevision: 'rev-motion',
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      registeredAssetIds: [],
      operations: [
        {
          id: 'bad-remove',
          dependsOn: [],
          kind: 'motion.removeKeyframe',
          binding: {
            ownerKind: 'audio-clip',
            ownerId: 'clip-audio',
            propertyId: 'gain',
            timeDomain: 'audio-timeline',
          },
          timeUs: 0,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('JOY_CODE_MOTION_KEYFRAME_REJECTED');
    expect(result.error.message).toContain('not implemented');
  });

  it('keeps split presentation bindings and stable IDs across multiple compound splits', () => {
    const result = compileJoyCodeCompoundDraft({
      planId: 'compound-split',
      baseRevision: 'rev-split',
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      registeredAssetIds: [],
      operations: [
        {
          id: 'split-at-two',
          dependsOn: [],
          kind: 'timeline.splitClip',
          compositionId: 'root',
          trackId: 'track-0',
          clipId: 'intro',
          atUs: 2_000_000,
        },
        {
          id: 'split-at-one',
          dependsOn: [],
          kind: 'timeline.splitClip',
          compositionId: 'root',
          trackId: 'track-0',
          clipId: 'intro',
          atUs: 1_000_000,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.timeline === undefined) return;
    const splitCommands = result.timeline.commands.filter(
      (command) => command.type === 'timeline.splitClip',
    );
    expect(splitCommands.map((command) => command.payload.newClipId)).toEqual([
      'compound-split-split-0',
      'compound-split-split-1',
    ]);
    const clipObjects = result.document.pluginData['joy.clipObjects'];
    expect(clipObjects).toMatchObject({
      'compound-split-split-0': 'intro-title',
      'compound-split-split-1': 'intro-title',
    });
  });

  it('derives an inserted asset family from the canonical document, never the legacy bare-id input', () => {
    const timeline = timelineWithAudioTrack();
    const visualProject = {
      ...INITIAL_EDITOR_PROJECT,
      assets: {
        ...INITIAL_EDITOR_PROJECT.assets,
        'voice-over': {
          id: 'voice-over',
          kind: 'audio' as const,
          displayName: 'Voice over',
          descriptor: { mimeType: 'audio/wav', durationUs: 1_000_000 },
        },
      },
    };
    const operation = {
      id: 'insert-voice',
      dependsOn: [],
      kind: 'timeline.insertExistingAsset' as const,
      compositionId: 'root',
      targetTrackId: 'audio-track',
      assetId: 'voice-over',
      startUs: 0,
      durationUs: 1_000_000,
    };
    const accepted = compileJoyCodeCompoundDraft({
      planId: 'compound-audio',
      baseRevision: 'rev-audio',
      timeline,
      visualProject,
      registeredAssetIds: ['voice-over'],
      operations: [operation],
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.timeline?.commands).toContainEqual(
      expect.objectContaining({
        type: 'timeline.insertClip',
        payload: expect.objectContaining({ expectedFamily: 'audio' }),
      }),
    );

    const rejectedBareId = compileJoyCodeCompoundDraft({
      planId: 'compound-audio-missing',
      baseRevision: 'rev-audio',
      timeline,
      visualProject: INITIAL_EDITOR_PROJECT,
      // This deprecated input intentionally contains the ID. It is ignored.
      registeredAssetIds: ['voice-over'],
      operations: [operation],
    });
    expect(rejectedBareId).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_TIMELINE_ASSET_UNAVAILABLE', operationId: 'insert-voice' },
    });
  });

  it('removes deleted clip presentation bindings and clip-owned animations', () => {
    const binding = {
      ownerKind: 'color-clip' as const,
      ownerId: 'intro',
      propertyId: 'adjust.exposure',
      timeDomain: 'clip-local' as const,
    };
    const document = {
      ...INITIAL_EDITOR_PROJECT,
      propertyAnimations: {
        [canonicalBindingKey(binding)]: {
          binding,
          value: {
            kind: 'scalar' as const,
            curve: { keyframes: [{ timeUs: 0, value: 1, interpolation: 'linear' as const }] },
          },
        },
      },
      universalTimeline: {
        schemaVersion: 1 as const,
        items: [
          {
            id: 'intro',
            compositionId: 'root',
            trackId: 'track-0',
            elementKind: 'video' as const,
            startUs: 0,
            durationUs: 10_000_000,
            source: { kind: 'asset' as const, id: 'intro' },
            withinTrackOrder: 0,
          },
        ],
      },
    };
    const result = compileJoyCodeCompoundDraft({
      planId: 'compound-delete',
      baseRevision: 'rev-delete',
      timeline: buildReferenceSpikeProject(),
      visualProject: document,
      registeredAssetIds: [],
      operations: [
        {
          id: 'delete-intro',
          dependsOn: [],
          kind: 'timeline.removeClip',
          compositionId: 'root',
          trackId: 'track-0',
          clipId: 'intro',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.propertyAnimations?.[canonicalBindingKey(binding)]).toBeUndefined();
    expect(result.document.universalTimeline?.items).toEqual([]);
  });
});

function timelineWithAudioTrack() {
  const base = buildReferenceSpikeProject();
  const root = base.compositions.root!;
  return {
    ...base,
    compositions: {
      ...base.compositions,
      root: {
        ...root,
        tracks: [
          ...root.tracks.map((track) => ({ ...track, family: 'visual' as const })),
          {
            id: 'audio-track',
            kind: 'video' as const,
            family: 'audio' as const,
            order: root.tracks.length,
            enabled: true,
            locked: false,
            clips: [],
          },
        ],
      },
    },
  };
}
