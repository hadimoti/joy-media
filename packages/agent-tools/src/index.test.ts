import { describe, expect, it } from 'vitest';
import {
  buildEditorContext,
  createToolRegistry,
  createFindClipTool,
  createFindActiveClipsTool,
  createSearchTranscriptTool,
  createGetAudioRegionsTool,
  createInspectPropertiesTool,
  createFindMissingAssetsTool,
  createEstimateImpactTool,
  createGetTimelineSummaryTool,
  createGetProviderCapabilitiesTool,
  createGetBrandConstraintsTool,
  createInsertClipTool,
  createRemoveClipTool,
  createMoveClipTool,
  createTrimClipTool,
  createSplitClipTool,
  createJoinClipsTool,
  createSetGainTool,
  createSetPanTool,
  createSetMuteTool,
  createSetFadeTool,
  createAddEffectTool,
} from './index.js';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';

const mockProject: SpikeProject = {
  schemaVersion: 0,
  id: 'test-project',
  rootCompositionId: 'comp-1',
  compositions: {
    'comp-1': {
      id: 'comp-1',
      name: 'Main Composition',
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      durationUs: 60_000_000,
      tracks: [
        {
          id: 'track-1',
          kind: 'video',
          order: 0,
          enabled: true,
          clips: [
            {
              id: 'clip-1',
              kind: 'video',
              startUs: 0,
              durationUs: 5_000_000,
              assetId: 'asset-1',
              sourceInUs: 0,
            },
            {
              id: 'clip-2',
              kind: 'video',
              startUs: 5_000_000,
              durationUs: 5_000_000,
              assetId: 'asset-2',
              sourceInUs: 0,
            },
          ],
        },
        {
          id: 'track-2',
          kind: 'video',
          order: 1,
          enabled: true,
          clips: [],
        },
      ],
    },
  },
};

const creativeProject: JoyProjectV1 = {
  schemaVersion: 1,
  id: 'test-project',
  title: 'Test Project',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  rootCompositionId: 'comp-1',
  settings: { defaultLocale: 'en-US' },
  compositions: {
    'comp-1': {
      id: 'comp-1',
      name: 'Main Composition',
      width: 1920,
      height: 1080,
      pixelAspectRatio: { num: 1, den: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 60_000_000,
      background: '#000000',
      tracks: [],
    },
  },
  assets: {
    'asset-1': { id: 'asset-1', kind: 'video', displayName: 'Opening Interview' },
  },
  variables: {},
  markers: [],
  visualObjects: {
    'title-1': {
      id: 'title-1',
      kind: 'text',
      text: 'Hello',
      transform: {
        x: 20,
        y: 30,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    },
  },
  captionDocuments: {
    'captions-1': {
      id: 'captions-1',
      language: 'en-US',
      direction: 'ltr',
      speakers: [],
      words: {
        hello: { id: 'hello', text: 'Hello', startUs: 0, endUs: 400_000, confidence: 0.95 },
        world: { id: 'world', text: 'world', startUs: 400_000, endUs: 900_000 },
      },
      segments: [
        {
          id: 'segment-1',
          startUs: 0,
          endUs: 900_000,
          wordIds: ['hello', 'world'],
        },
      ],
    },
  },
  pluginData: {},
  audio: {
    clips: {
      'clip-1': { gain: 1, pan: 0, mute: false, solo: false },
    },
    buses: [
      {
        id: 'master',
        name: 'Master',
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        inputs: [],
      },
    ],
    effects: [],
  },
};

describe('Context Builder', () => {
  it('produces bounded summaries', () => {
    const context = buildEditorContext(mockProject);
    expect(context.project.id).toBe('test-project');
    expect(context.project.compositionCount).toBe(1);
    expect(context.project.trackCount).toBe(2);
    expect(context.project.clipCount).toBe(2);
  });

  it('includes all required sections', () => {
    const context = buildEditorContext(mockProject);
    expect(context.project).toBeDefined();
    expect(context.selection).toBeDefined();
    expect(context.timeline).toBeDefined();
    expect(context.audio).toBeDefined();
    expect(context.providers).toBeDefined();
    expect(context.availableTools).toBeDefined();
    expect(context.recentHistory).toBeDefined();
    expect(context.constraints).toBeDefined();
  });

  it('respects max timeline summary items', () => {
    const context = buildEditorContext(mockProject, { maxTimelineSummaryItems: 1 });
    expect(context.timeline.compositions.length).toBeLessThanOrEqual(1);
  });

  it('does not claim opaque SpikeProject asset references are missing', () => {
    const context = buildEditorContext(mockProject);
    expect(context.project.missingAssets).toEqual([]);
  });

  it('reports no audio/captions for a SpikeProject, whose tracks are video-only by design', () => {
    // model.ts's P00 spike `Track.kind` is `'video'` only (captions/audio live
    // in the later JoyProjectV1 schema instead), so this can never be true for
    // a SpikeProject — this test previously asserted the opposite against a
    // fixture typed as `'audio'`, which never satisfied the real `Track` type.
    const context = buildEditorContext(mockProject);
    expect(context.project.hasAudio).toBe(false);
    expect(context.project.hasCaptions).toBe(false);
  });

  it('binds creative metadata, live selection, captions, audio, and real missing assets', () => {
    const context = buildEditorContext(mockProject, undefined, undefined, {
      creativeProject,
      selection: {
        selectedClipIds: ['clip-2'],
        selectedTrackIds: ['track-1'],
        playheadUs: 5_500_000,
      },
    });
    expect(context.project).toMatchObject({
      name: 'Test Project',
      hasAudio: true,
      hasCaptions: true,
      missingAssets: ['asset-2'],
    });
    expect(context.selection).toEqual({
      selectedClipIds: ['clip-2'],
      selectedTrackIds: ['track-1'],
      playheadUs: 5_500_000,
    });
    expect(context.captions).toMatchObject({ documentCount: 1, totalWordCount: 2 });
    expect(context.audio).toMatchObject({ clipCount: 1, busCount: 1, hasDialogue: true });
  });
});

describe('Query Tools', () => {
  it('findClip returns stable IDs', () => {
    const tool = createFindClipTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, { clipId: 'clip-1' });
    expect(result.success).toBe(true);
    expect(result.stableIds).toEqual(['clip-1']);
  });

  it('findClip searches creative asset names and sources', () => {
    const tool = createFindClipTool();
    const context = buildEditorContext(mockProject, undefined, undefined, { creativeProject });
    expect(tool.execute(context, { name: 'interview' }).stableIds).toEqual(['clip-1']);
    expect(tool.execute(context, { source: 'asset-2' }).stableIds).toEqual(['clip-2']);
  });

  it('findClip handles missing input', () => {
    const tool = createFindClipTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('findActiveClips validates time range', () => {
    const tool = createFindActiveClipsTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, { startUs: 1000, endUs: 500 });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('findActiveClips returns every clip overlapping the requested range', () => {
    const result = createFindActiveClipsTool().execute(buildEditorContext(mockProject), {
      startUs: 4_500_000,
      endUs: 5_500_000,
    });
    expect(result.stableIds).toEqual(['clip-1', 'clip-2']);
  });

  it('searchTranscript requires captions', () => {
    const tool = createSearchTranscriptTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, { query: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no captions');
  });

  it('searchTranscript returns matching caption segments', () => {
    const context = buildEditorContext(mockProject, undefined, undefined, { creativeProject });
    const result = createSearchTranscriptTool().execute(context, { query: 'WORLD' });
    expect(result.stableIds).toEqual(['segment-1']);
    expect(result.data).toEqual({
      segments: [
        {
          id: 'segment-1',
          documentId: 'captions-1',
          language: 'en-US',
          text: 'Hello world',
          startUs: 0,
          endUs: 900_000,
        },
      ],
    });
  });

  it('getAudioRegions validates type', () => {
    const tool = createGetAudioRegionsTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, { type: 'invalid' });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('getAudioRegions distinguishes unavailable analysis from an empty result', () => {
    const tool = createGetAudioRegionsTool();
    expect(tool.execute(buildEditorContext(mockProject), { type: 'silence' })).toMatchObject({
      success: false,
      error: 'audio analysis regions are unavailable',
    });
    const context = buildEditorContext(mockProject, undefined, undefined, {
      audioRegions: [{ id: 'silence-1', type: 'silence', startUs: 1_000_000, endUs: 2_000_000 }],
    });
    expect(tool.execute(context, { type: 'silence' }).stableIds).toEqual(['silence-1']);
    expect(tool.execute(context, { type: 'speech' }).stableIds).toEqual([]);
  });

  it('inspectProperties requires entityId', () => {
    const tool = createInspectPropertiesTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('inspectProperties returns indexed entity data and rejects unknown IDs', () => {
    const tool = createInspectPropertiesTool();
    const context = buildEditorContext(mockProject, undefined, undefined, { creativeProject });
    expect(tool.execute(context, { entityId: 'title-1' })).toMatchObject({
      success: true,
      stableIds: ['title-1'],
      data: { entity: { id: 'title-1', kind: 'visual.text' } },
    });
    expect(tool.execute(context, { entityId: 'missing' })).toMatchObject({
      success: false,
      error: 'entity "missing" not found',
    });
  });

  it('findMissingAssets returns stable IDs', () => {
    const tool = createFindMissingAssetsTool();
    const context = buildEditorContext(mockProject, undefined, undefined, { creativeProject });
    const result = tool.execute(context, {});
    expect(result.success).toBe(true);
    expect(result.stableIds).toEqual(['asset-2']);
  });

  it('estimateImpact requires changeType', () => {
    const tool = createEstimateImpactTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('estimateImpact returns a deterministic render estimate', () => {
    const result = createEstimateImpactTool().execute(buildEditorContext(mockProject), {
      changeType: 'export video',
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        affectedClipCount: 2,
        timelineDurationUs: 60_000_000,
        estimatedWorkerTimeMs: 60_000,
        confidence: 'medium',
      },
    });
  });

  it('getTimelineSummary returns composition IDs', () => {
    const tool = createGetTimelineSummaryTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(true);
    expect(result.stableIds).toContain('comp-1');
  });

  it('getProviderCapabilities returns provider IDs', () => {
    const tool = createGetProviderCapabilitiesTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(true);
  });

  it('getBrandConstraints returns empty', () => {
    const tool = createGetBrandConstraintsTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(true);
    expect(result.stableIds).toEqual([]);
  });
});

describe('Edit Tools', () => {
  it('insertClip validates inputs', () => {
    const tool = createInsertClipTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('insertClip checks preconditions', () => {
    const tool = createInsertClipTool();
    const context = buildEditorContext(mockProject);
    const preconditions = tool.checkPreconditions(context, {
      compositionId: 'comp-1',
      trackId: 'track-1',
      clip: {
        id: 'clip-new',
        kind: 'video',
        startUs: 10_000_000,
        durationUs: 1_000_000,
        assetId: 'asset-new',
        sourceInUs: 0,
      },
    });
    expect(preconditions.length).toBe(0);
  });

  it('insertClip supports dry-run', () => {
    const tool = createInsertClipTool();
    const context = buildEditorContext(mockProject);
    const diff = tool.dryRun(context, {
      compositionId: 'comp-1',
      trackId: 'track-1',
      clip: { id: 'clip-new' },
    });
    expect(diff.created).toContain('clip-new');
  });

  it('insertClip returns stable IDs', () => {
    const tool = createInsertClipTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {
      compositionId: 'comp-1',
      trackId: 'track-1',
      clip: { id: 'clip-new' },
    });
    expect(result.success).toBe(true);
    expect(result.stableIds).toContain('clip-new');
  });

  it('removeClip validates inputs', () => {
    const tool = createRemoveClipTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(false);
  });

  it('removeClip supports dry-run', () => {
    const tool = createRemoveClipTool();
    const context = buildEditorContext(mockProject);
    const diff = tool.dryRun(context, { clipId: 'clip-1' });
    expect(diff.deleted).toContain('clip-1');
  });

  it('moveClip validates time range', () => {
    const tool = createMoveClipTool();
    const context = buildEditorContext(mockProject);
    const preconditions = tool.checkPreconditions(context, {
      clipId: 'clip-1',
      newStartUs: -1000,
    });
    expect(preconditions.length).toBeGreaterThan(0);
  });

  it('trimClip requires start or end', () => {
    const tool = createTrimClipTool();
    const context = buildEditorContext(mockProject);
    const preconditions = tool.checkPreconditions(context, { clipId: 'clip-1' });
    expect(preconditions.length).toBeGreaterThan(0);
  });

  it('splitClip requires newClipId', () => {
    const tool = createSplitClipTool();
    const context = buildEditorContext(mockProject);
    const preconditions = tool.checkPreconditions(context, {
      clipId: 'clip-1',
      atUs: 2_500_000,
    });
    expect(preconditions.length).toBeGreaterThan(0);
  });

  it('joinClips requires both clip IDs', () => {
    const tool = createJoinClipsTool();
    const context = buildEditorContext(mockProject);
    const preconditions = tool.checkPreconditions(context, {
      firstClipId: 'clip-1',
    });
    expect(preconditions.length).toBeGreaterThan(0);
  });

  it('setGain requires gain value', () => {
    const tool = createSetGainTool();
    const context = buildEditorContext(mockProject);
    const preconditions = tool.checkPreconditions(context, { clipId: 'clip-1' });
    expect(preconditions.length).toBeGreaterThan(0);
  });

  it('setPan requires pan value', () => {
    const tool = createSetPanTool();
    const context = buildEditorContext(mockProject);
    const preconditions = tool.checkPreconditions(context, { clipId: 'clip-1' });
    expect(preconditions.length).toBeGreaterThan(0);
  });

  it('setMute requires mute value', () => {
    const tool = createSetMuteTool();
    const context = buildEditorContext(mockProject);
    const preconditions = tool.checkPreconditions(context, { clipId: 'clip-1' });
    expect(preconditions.length).toBeGreaterThan(0);
  });

  it('setFade requires fade values', () => {
    const tool = createSetFadeTool();
    const context = buildEditorContext(mockProject);
    const preconditions = tool.checkPreconditions(context, { clipId: 'clip-1' });
    expect(preconditions.length).toBeGreaterThan(0);
  });

  it('addEffect requires effect object', () => {
    const tool = createAddEffectTool();
    const context = buildEditorContext(mockProject);
    const preconditions = tool.checkPreconditions(context, {
      id: 'effect-1',
      targetId: 'clip-1',
    });
    expect(preconditions.length).toBeGreaterThan(0);
  });

  it('all edit tools map to correct commands', () => {
    const tools = [
      { tool: createInsertClipTool(), command: 'timeline.insertClip' },
      { tool: createRemoveClipTool(), command: 'timeline.removeClip' },
      { tool: createMoveClipTool(), command: 'timeline.moveClip' },
      { tool: createTrimClipTool(), command: 'timeline.trimClip' },
      { tool: createSplitClipTool(), command: 'timeline.splitClip' },
      { tool: createJoinClipsTool(), command: 'timeline.joinClips' },
      { tool: createSetGainTool(), command: 'audioClip.setGain' },
      { tool: createSetPanTool(), command: 'audioClip.setPan' },
      { tool: createSetMuteTool(), command: 'audioClip.setMute' },
      { tool: createSetFadeTool(), command: 'audioClip.setFade' },
      { tool: createAddEffectTool(), command: 'audioEffect.add' },
    ];

    for (const { tool, command } of tools) {
      expect(tool.commandType).toBe(command);
    }
  });
});

describe('Tool Registry', () => {
  it('contains all expected tools', () => {
    const registry = createToolRegistry();
    const names = registry.getToolNames();

    expect(names).toContain('findClip');
    expect(names).toContain('findActiveClips');
    expect(names).toContain('searchTranscript');
    expect(names).toContain('getAudioRegions');
    expect(names).toContain('inspectProperties');
    expect(names).toContain('findMissingAssets');
    expect(names).toContain('estimateImpact');
    expect(names).toContain('getTimelineSummary');
    expect(names).toContain('getProviderCapabilities');
    expect(names).toContain('getBrandConstraints');
    expect(names).toContain('insertClip');
    expect(names).toContain('removeClip');
    expect(names).toContain('moveClip');
    expect(names).toContain('trimClip');
    expect(names).toContain('splitClip');
    expect(names).toContain('joinClips');
    expect(names).toContain('setGain');
    expect(names).toContain('setPan');
    expect(names).toContain('setMute');
    expect(names).toContain('setFade');
    expect(names).toContain('addEffect');
  });

  it('lookup by name works', () => {
    const registry = createToolRegistry();
    const tool = registry.getTool('findClip');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('findClip');
  });

  it('lookup by category works', () => {
    const registry = createToolRegistry();
    const queryTools = registry.getToolsByCategory('query');
    const editTools = registry.getToolsByCategory('edit');

    expect(queryTools.length).toBe(10);
    expect(editTools.length).toBe(11);
  });

  it('hasTool works correctly', () => {
    const registry = createToolRegistry();
    expect(registry.hasTool('findClip')).toBe(true);
    expect(registry.hasTool('nonexistent')).toBe(false);
  });

  it('has expected tools registered', () => {
    const registry = createToolRegistry();
    expect(registry.hasTool('insertClip')).toBe(true);
    expect(registry.hasTool('setGain')).toBe(true);
    expect(registry.hasTool('findClip')).toBe(true);
  });
});
