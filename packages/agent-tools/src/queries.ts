import type { EditorContext } from './context.js';
import type { JsonValue, ToolResult } from './types.js';

export interface QueryTool {
  readonly name: string;
  readonly description: string;
  execute(context: EditorContext, input: JsonValue): ToolResult;
}

export function createFindClipTool(): QueryTool {
  return {
    name: 'findClip',
    description: 'Find clip by ID, name, or source',
    execute: (context, input) => {
      if (!isRecord(input)) {
        return { success: false, error: 'input must be an object' };
      }

      const clipId = typeof input.clipId === 'string' ? input.clipId : undefined;
      const name = typeof input.name === 'string' ? input.name : undefined;
      const source = typeof input.source === 'string' ? input.source : undefined;

      if (!clipId && !name && !source) {
        return { success: false, error: 'must provide clipId, name, or source' };
      }

      return {
        success: true,
        stableIds: [],
        warnings: ['not implemented: requires project state access'],
      };
    },
  };
}

export function createFindActiveClipsTool(): QueryTool {
  return {
    name: 'findActiveClips',
    description: 'Find clips active in a time range',
    execute: (context, input) => {
      if (!isRecord(input)) {
        return { success: false, error: 'input must be an object' };
      }

      const startUs = typeof input.startUs === 'number' ? input.startUs : undefined;
      const endUs = typeof input.endUs === 'number' ? input.endUs : undefined;

      if (startUs === undefined || endUs === undefined) {
        return { success: false, error: 'must provide startUs and endUs' };
      }

      if (startUs < 0 || endUs < startUs) {
        return { success: false, error: 'invalid time range' };
      }

      return {
        success: true,
        stableIds: [],
        warnings: ['not implemented: requires project state access'],
      };
    },
  };
}

export function createSearchTranscriptTool(): QueryTool {
  return {
    name: 'searchTranscript',
    description: 'Search caption/transcript text',
    execute: (context, input) => {
      if (!isRecord(input)) {
        return { success: false, error: 'input must be an object' };
      }

      const query = typeof input.query === 'string' ? input.query : undefined;

      if (!query) {
        return { success: false, error: 'must provide query string' };
      }

      if (!context.captions) {
        return { success: false, error: 'no captions in project' };
      }

      return {
        success: true,
        stableIds: [],
        warnings: ['not implemented: requires project state access'],
      };
    },
  };
}

export function createGetAudioRegionsTool(): QueryTool {
  return {
    name: 'getAudioRegions',
    description: 'Get silence/speech regions',
    execute: (context, input) => {
      if (!isRecord(input)) {
        return { success: false, error: 'input must be an object' };
      }

      const type = typeof input.type === 'string' ? input.type : undefined;

      if (type !== 'silence' && type !== 'speech') {
        return { success: false, error: 'must provide type: "silence" or "speech"' };
      }

      return {
        success: true,
        stableIds: [],
        warnings: ['not implemented: requires audio analysis'],
      };
    },
  };
}

export function createInspectPropertiesTool(): QueryTool {
  return {
    name: 'inspectProperties',
    description: 'Inspect selected object properties',
    execute: (context, input) => {
      if (!isRecord(input)) {
        return { success: false, error: 'input must be an object' };
      }

      const entityId = typeof input.entityId === 'string' ? input.entityId : undefined;

      if (!entityId) {
        return { success: false, error: 'must provide entityId' };
      }

      return {
        success: true,
        stableIds: [entityId],
        warnings: ['not implemented: requires project state access'],
      };
    },
  };
}

export function createFindMissingAssetsTool(): QueryTool {
  return {
    name: 'findMissingAssets',
    description: 'Identify missing/broken asset references',
    execute: (context, _input) => {
      return {
        success: true,
        stableIds: context.project.missingAssets,
      };
    },
  };
}

export function createEstimateImpactTool(): QueryTool {
  return {
    name: 'estimateImpact',
    description: 'Estimate render/generation impact of a proposed change',
    execute: (context, input) => {
      if (!isRecord(input)) {
        return { success: false, error: 'input must be an object' };
      }

      const changeType = typeof input.changeType === 'string' ? input.changeType : undefined;

      if (!changeType) {
        return { success: false, error: 'must provide changeType' };
      }

      return {
        success: true,
        warnings: ['not implemented: requires impact analysis'],
      };
    },
  };
}

export function createGetTimelineSummaryTool(): QueryTool {
  return {
    name: 'getTimelineSummary',
    description: 'Get concise timeline topology',
    execute: (context, _input) => {
      return {
        success: true,
        stableIds: context.timeline.compositions.map((c) => c.id),
      };
    },
  };
}

export function createGetProviderCapabilitiesTool(): QueryTool {
  return {
    name: 'getProviderCapabilities',
    description: 'List available provider capabilities',
    execute: (context, _input) => {
      return {
        success: true,
        stableIds: context.providers.availableProviders.map((p) => p.id),
      };
    },
  };
}

export function createGetBrandConstraintsTool(): QueryTool {
  return {
    name: 'getBrandConstraints',
    description: 'Get brand/template constraints if any',
    execute: (_context, _input) => {
      return {
        success: true,
        stableIds: [],
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
