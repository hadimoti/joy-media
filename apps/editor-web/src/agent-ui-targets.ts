import type { FeatureToolId } from './feature-architecture.js';
import type { PanelId } from './workspace.js';
import type { JoyAgentEntityKind, JoyAgentTarget } from './agent-presence.js';

export type JoyAgentToolName =
  | 'read_project'
  | 'read_selection'
  | 'read_timeline'
  | 'read_timeline_track'
  | 'read_inspector'
  | 'read_assets'
  | 'read_brief'
  | 'read_scene_3d'
  | 'create_media'
  | 'create_text'
  | 'create_captions'
  | 'create_audio'
  | 'create_templates'
  | 'enhance_motion'
  | 'enhance_transitions'
  | 'enhance_effects'
  | 'enhance_filters'
  | 'enhance_color'
  | 'enhance_adjust'
  | 'inspect_visual'
  | 'inspect_enhance'
  | 'inspect_mask'
  | 'inspect_adjust'
  | 'inspect_effects'
  | 'inspect_audio'
  | 'inspect_speed'
  | 'joy_code_composer'
  | 'creative_brief'
  | 'scene_3d'
  | 'propose_timeline'
  | 'propose_track'
  | 'propose_document'
  | 'propose_asset'
  | 'propose_brief'
  | 'propose_scene_3d'
  | 'preview_changes'
  | 'submit_plan'
  | (string & {});

export interface AgentTargetSnapshot {
  readonly clipIds?: ReadonlySet<string> | readonly string[];
  readonly trackIds?: ReadonlySet<string> | readonly string[];
  readonly assetIds?: ReadonlySet<string> | readonly string[];
  readonly propertyKeys?: ReadonlySet<string> | readonly string[];
  readonly briefIds?: ReadonlySet<string> | readonly string[];
  readonly sceneIds?: ReadonlySet<string> | readonly string[];
}

export interface AgentToolTargetRequest {
  readonly tool: string;
  readonly entityIds?: readonly string[];
  /** Deliberately ignored: model input must never choose its own UI route. */
  readonly panelId?: unknown;
  readonly sectionId?: unknown;
  readonly selector?: unknown;
  readonly className?: unknown;
}

export interface AgentUiTargetMap {
  readonly panelId: PanelId;
  readonly sectionId?: string;
  readonly kind?: JoyAgentEntityKind;
  readonly featureTool?: FeatureToolId;
}

const TOOL_TARGETS: Readonly<Record<string, AgentUiTargetMap>> = {
  read_project: { panelId: 'agent', sectionId: 'composer' },
  read_selection: { panelId: 'inspector', sectionId: 'visual', kind: 'property' },
  read_timeline: { panelId: 'timeline', sectionId: 'timeline', kind: 'clip' },
  read_timeline_track: { panelId: 'timeline', sectionId: 'timeline', kind: 'track' },
  read_inspector: { panelId: 'inspector', sectionId: 'visual' },
  read_assets: { panelId: 'media', sectionId: 'media', kind: 'asset', featureTool: 'media' },
  read_brief: { panelId: 'agent', sectionId: 'brief' },
  read_scene_3d: { panelId: 'agent', sectionId: '3d' },
  create_media: { panelId: 'media', sectionId: 'media', featureTool: 'media' },
  create_text: { panelId: 'media', sectionId: 'text', featureTool: 'text' },
  create_captions: { panelId: 'media', sectionId: 'captions', featureTool: 'captions' },
  create_audio: { panelId: 'media', sectionId: 'audio', featureTool: 'audio' },
  create_templates: { panelId: 'media', sectionId: 'templates', featureTool: 'templates' },
  enhance_motion: { panelId: 'effects', sectionId: 'motion', featureTool: 'motion' },
  enhance_transitions: { panelId: 'effects', sectionId: 'transitions', featureTool: 'transitions' },
  enhance_effects: { panelId: 'effects', sectionId: 'effects', featureTool: 'effects' },
  enhance_filters: { panelId: 'effects', sectionId: 'filters', featureTool: 'filters' },
  enhance_color: { panelId: 'effects', sectionId: 'color', featureTool: 'color' },
  enhance_adjust: { panelId: 'effects', sectionId: 'adjust', featureTool: 'adjust' },
  inspect_visual: { panelId: 'inspector', sectionId: 'visual', kind: 'property' },
  inspect_enhance: { panelId: 'inspector', sectionId: 'enhance', kind: 'property' },
  inspect_mask: { panelId: 'inspector', sectionId: 'mask', kind: 'property' },
  inspect_adjust: { panelId: 'inspector', sectionId: 'adjust', kind: 'property' },
  inspect_effects: { panelId: 'inspector', sectionId: 'effects', kind: 'property' },
  inspect_audio: { panelId: 'inspector', sectionId: 'audio', kind: 'property' },
  inspect_speed: { panelId: 'inspector', sectionId: 'speed', kind: 'property' },
  joy_code_composer: { panelId: 'agent', sectionId: 'composer' },
  creative_brief: { panelId: 'agent', sectionId: 'brief' },
  scene_3d: { panelId: 'agent', sectionId: '3d' },
  propose_timeline: { panelId: 'timeline', sectionId: 'timeline', kind: 'clip' },
  propose_track: { panelId: 'timeline', sectionId: 'timeline', kind: 'track' },
  propose_document: { panelId: 'inspector', sectionId: 'visual', kind: 'property' },
  propose_asset: { panelId: 'media', sectionId: 'media', kind: 'asset', featureTool: 'media' },
  propose_brief: { panelId: 'agent', sectionId: 'brief' },
  propose_scene_3d: { panelId: 'agent', sectionId: '3d' },
  preview_changes: { panelId: 'monitor', sectionId: 'preview' },
  submit_plan: { panelId: 'agent', sectionId: 'composer' },
};

function validIds(
  ids: readonly string[] | undefined,
  allowed: ReadonlySet<string> | readonly string[] | undefined,
): readonly string[] {
  if (ids === undefined || allowed === undefined) return [];
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  return ids.filter((id) => set.has(id));
}

function snapshotIds(
  tool: string,
  snapshot: AgentTargetSnapshot,
): ReadonlySet<string> | readonly string[] | undefined {
  if (tool.includes('timeline_track') || tool === 'propose_track') return snapshot.trackIds;
  if (tool.includes('timeline') || tool.includes('document')) return snapshot.clipIds;
  if (tool.includes('asset') || tool.includes('media')) return snapshot.assetIds;
  if (tool.includes('scene')) return snapshot.sceneIds;
  if (tool.includes('brief')) return snapshot.briefIds;
  if (tool.includes('inspect') || tool.includes('selection')) return snapshot.propertyKeys;
  return undefined;
}

/**
 * Maps a model tool name to an allow-listed panel/section and validates entity
 * IDs against the current editor snapshot. Model-provided routing fields are
 * intentionally not consulted.
 */
export function mapAgentToolToTargets(
  request: AgentToolTargetRequest,
  snapshot: AgentTargetSnapshot = {},
): readonly JoyAgentTarget[] {
  const target = TOOL_TARGETS[request.tool] ?? { panelId: 'agent', sectionId: 'composer' };
  const allowed = snapshotIds(request.tool, snapshot);
  const ids = validIds(request.entityIds, allowed);
  if (ids.length === 0 || target.kind === undefined) {
    return [
      {
        panelId: target.panelId,
        ...(target.sectionId === undefined ? {} : { sectionId: target.sectionId }),
      },
    ];
  }
  const kind = target.kind;
  return ids.map((id) => ({
    panelId: target.panelId,
    ...(target.sectionId === undefined ? {} : { sectionId: target.sectionId }),
    entity: { kind, id },
  }));
}

export function mapAgentToolToSurface(
  request: AgentToolTargetRequest,
  snapshot: AgentTargetSnapshot = {},
): readonly JoyAgentTarget[] {
  return mapAgentToolToTargets(request, snapshot);
}

export function trustedFeatureToolForRequest(request: AgentToolTargetRequest): FeatureToolId | undefined {
  return TOOL_TARGETS[request.tool]?.featureTool;
}

export function agentTargetMap(): Readonly<Record<string, AgentUiTargetMap>> {
  return TOOL_TARGETS;
}
