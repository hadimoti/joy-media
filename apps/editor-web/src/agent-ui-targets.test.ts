import { describe, expect, it } from 'vitest';
import {
  inferJoyAgentTaskKind,
  mapAgentToolToSurface,
  mapAgentToolToTargets,
  targetForJoyAgentTask,
  trustedFeatureToolForRequest,
} from './agent-ui-targets.js';

describe('JOY agent trusted UI target map', () => {
  const snapshot = {
    clipIds: new Set(['clip-a']),
    trackIds: new Set(['track-v1']),
    assetIds: new Set(['asset-a']),
    propertyKeys: new Set(['opacity']),
    briefIds: new Set(['brief-a']),
    sceneIds: new Set(['scene-a']),
  };

  it('maps create/enhance tools to durable panels and nested sections', () => {
    expect(mapAgentToolToTargets({ tool: 'create_text' }, snapshot)).toEqual([
      { panelId: 'media', sectionId: 'text' },
    ]);
    expect(mapAgentToolToTargets({ tool: 'enhance_transitions' }, snapshot)).toEqual([
      { panelId: 'effects', sectionId: 'transitions' },
    ]);
    expect(trustedFeatureToolForRequest({ tool: 'enhance_color' })).toBe('color');
  });

  it('keeps valid entity IDs and drops IDs outside the trusted snapshot', () => {
    expect(
      mapAgentToolToTargets(
        { tool: 'propose_timeline', entityIds: ['clip-a', 'clip-forged'] },
        snapshot,
      ),
    ).toEqual([
      {
        panelId: 'timeline',
        sectionId: 'timeline',
        entity: { kind: 'clip', id: 'clip-a' },
      },
    ]);
    expect(
      mapAgentToolToTargets({ tool: 'read_timeline', entityIds: ['clip-a'] }, snapshot),
    ).toEqual([
      {
        panelId: 'timeline',
        sectionId: 'timeline',
        entity: { kind: 'clip', id: 'clip-a' },
      },
    ]);
  });

  it('ignores provider-supplied routing fields and falls back unknown tools to Joy Code', () => {
    expect(
      mapAgentToolToSurface({
        tool: 'unknown_provider_tool',
        panelId: 'plugins',
        sectionId: 'secret-panel',
        selector: '[data-secret]',
        className: 'dangerous',
      }),
    ).toEqual([{ panelId: 'agent', sectionId: 'composer' }]);
  });

  it('maps the exact inspector, brief, 3D, monitor, and submit targets', () => {
    expect(mapAgentToolToTargets({ tool: 'inspect_mask' }, snapshot)).toEqual([
      { panelId: 'inspector', sectionId: 'mask' },
    ]);
    expect(mapAgentToolToTargets({ tool: 'creative_brief' }, snapshot)).toEqual([
      { panelId: 'agent', sectionId: 'brief' },
    ]);
    expect(mapAgentToolToTargets({ tool: 'scene_3d' }, snapshot)).toEqual([
      { panelId: 'agent', sectionId: '3d' },
    ]);
    expect(mapAgentToolToTargets({ tool: 'preview_changes' }, snapshot)).toEqual([
      { panelId: 'monitor', sectionId: 'preview' },
    ]);
    expect(mapAgentToolToTargets({ tool: 'submit_plan' }, snapshot)).toEqual([
      { panelId: 'agent', sectionId: 'composer' },
    ]);
  });

  it('routes free-form task kinds to the active product section', () => {
    expect(targetForJoyAgentTask('color')).toEqual({ panelId: 'effects', sectionId: 'color' });
    expect(targetForJoyAgentTask('captions')).toEqual({ panelId: 'media', sectionId: 'captions' });
    expect(inferJoyAgentTaskKind('add a warm cinematic grade')).toBe('color');
    expect(inferJoyAgentTaskKind('make the lower third glow')).toBe('effects');
    expect(inferJoyAgentTaskKind('write subtitles from the speech')).toBe('captions');
    expect(inferJoyAgentTaskKind('trim the intro and tighten the cut')).toBe('joy-code');
  });
});
