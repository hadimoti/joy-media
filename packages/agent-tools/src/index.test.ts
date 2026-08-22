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
import type { SpikeProject } from '@joy-media/project-schema';

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

  it('handles missing assets', () => {
    const context = buildEditorContext(mockProject);
    expect(context.project.missingAssets).toContain('asset-1');
    expect(context.project.missingAssets).toContain('asset-2');
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
});

describe('Query Tools', () => {
  it('findClip returns stable IDs', () => {
    const tool = createFindClipTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, { clipId: 'clip-1' });
    expect(result.success).toBe(true);
    expect(result.stableIds).toBeDefined();
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

  it('searchTranscript requires captions', () => {
    const tool = createSearchTranscriptTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, { query: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no captions');
  });

  it('getAudioRegions validates type', () => {
    const tool = createGetAudioRegionsTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, { type: 'invalid' });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('inspectProperties requires entityId', () => {
    const tool = createInspectPropertiesTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('findMissingAssets returns stable IDs', () => {
    const tool = createFindMissingAssetsTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(true);
    expect(result.stableIds).toEqual(['asset-1', 'asset-2']);
  });

  it('estimateImpact requires changeType', () => {
    const tool = createEstimateImpactTool();
    const context = buildEditorContext(mockProject);
    const result = tool.execute(context, {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
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

  it('registers 3D tools as explicit approval-bound definitions', () => {
    const registry = createToolRegistry();
    expect(registry.hasTool('scene3d.summary')).toBe(true);
    expect(registry.hasTool('scene3d.add')).toBe(true);
    expect(registry.scene3dDefinitions).toHaveLength(9);
    expect(registry.tools.get('scene3d.summary')).toMatchObject({
      category: 'query',
      requiresConfirmation: false,
      supportsDryRun: false,
    });
    expect(registry.tools.get('scene3d.add')).toMatchObject({
      category: 'edit',
      requiresConfirmation: true,
      supportsDryRun: true,
      scope: { isReversible: true },
    });
    expect(typeof registry.executeScene3DTool).toBe('function');
  });
});
