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
      const name = typeof input.name === 'string' ? input.name.trim() : undefined;
      const source = typeof input.source === 'string' ? input.source.trim() : undefined;

      if (!clipId && !name && !source) {
        return { success: false, error: 'must provide clipId, name, or source' };
      }

      const clips = context.query?.clips;
      if (clips === undefined) return { success: false, error: 'clip index is unavailable' };
      const normalizedName = name?.trim().toLocaleLowerCase();
      const normalizedSource = source?.trim().toLocaleLowerCase();
      const matches = clips.filter(
        (clip) =>
          (clipId === undefined || clip.id === clipId) &&
          (normalizedName === undefined ||
            (clip.name ?? '').toLocaleLowerCase().includes(normalizedName)) &&
          (normalizedSource === undefined ||
            (clip.source ?? '').toLocaleLowerCase().includes(normalizedSource)),
      );
      return {
        success: true,
        stableIds: matches.map((clip) => clip.id),
        data: { clips: matches.map(clipToJson) },
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

      const clips = context.query?.clips;
      if (clips === undefined) return { success: false, error: 'clip index is unavailable' };
      const matches = clips.filter((clip) => {
        const clipEndUs = clip.startUs + clip.durationUs;
        return startUs === endUs
          ? clip.startUs <= startUs && clipEndUs > startUs
          : clip.startUs < endUs && clipEndUs > startUs;
      });
      return {
        success: true,
        stableIds: matches.map((clip) => clip.id),
        data: { clips: matches.map(clipToJson) },
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

      const query = typeof input.query === 'string' ? input.query.trim() : undefined;

      if (!query) {
        return { success: false, error: 'must provide query string' };
      }

      if (!context.captions) {
        return { success: false, error: 'no captions in project' };
      }

      const normalizedQuery = query.trim().toLocaleLowerCase();
      const matches = (context.query?.captionSegments ?? []).filter((segment) =>
        segment.text.toLocaleLowerCase().includes(normalizedQuery),
      );
      return {
        success: true,
        stableIds: matches.map((segment) => segment.id),
        data: {
          segments: matches.map((segment) => ({
            id: segment.id,
            documentId: segment.documentId,
            language: segment.language,
            text: segment.text,
            startUs: segment.startUs,
            endUs: segment.endUs,
          })),
        },
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

      const regions = context.query?.audioRegions;
      if (regions === undefined) {
        return { success: false, error: 'audio analysis regions are unavailable' };
      }
      const matches = regions.filter((region) => region.type === type);
      return {
        success: true,
        stableIds: matches.map((region) => region.id),
        data: {
          regions: matches.map((region) => ({
            id: region.id,
            type: region.type,
            startUs: region.startUs,
            endUs: region.endUs,
            ...(region.clipId !== undefined ? { clipId: region.clipId } : {}),
          })),
        },
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

      const entity = context.query?.entities.find((candidate) => candidate.id === entityId);
      if (entity === undefined) return { success: false, error: `entity "${entityId}" not found` };
      return {
        success: true,
        stableIds: [entityId],
        data: {
          entity: { id: entity.id, kind: entity.kind, properties: entity.properties },
        },
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

      const changeType = typeof input.changeType === 'string' ? input.changeType.trim() : undefined;

      if (!changeType) {
        return { success: false, error: 'must provide changeType' };
      }

      const normalized = changeType.trim().toLocaleLowerCase();
      const isRender = /(render|export|transcode|encode)/u.test(normalized);
      const isGeneration = /(generate|synth|transcrib|denoise|isolate)/u.test(normalized);
      const estimatedWorkerTimeMs = isRender
        ? Math.max(1_000, Math.ceil(context.project.durationUs / 1_000))
        : Math.max(25, context.project.clipCount * (isGeneration ? 250 : 5));
      return {
        success: true,
        data: {
          changeType,
          affectedClipCount: context.project.clipCount,
          timelineDurationUs: context.project.durationUs,
          estimatedWorkerTimeMs,
          localOnly: isGeneration ? context.providers.localOnly : true,
          confidence: isRender ? 'medium' : isGeneration ? 'low' : 'high',
        },
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
        data: {
          totalDurationUs: context.timeline.totalDurationUs,
          compositions: context.timeline.compositions.map((composition) => ({
            id: composition.id,
            name: composition.name,
            width: composition.width,
            height: composition.height,
            frameRate: composition.frameRate,
            durationUs: composition.durationUs,
            trackCount: composition.trackCount,
          })),
        },
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
        data: {
          localOnly: context.providers.localOnly,
          providers: context.providers.availableProviders.map((provider) => ({
            id: provider.id,
            displayName: provider.displayName,
            execution: provider.execution,
            capabilities: provider.capabilities,
            dataLeavesDevice: provider.dataLeavesDevice,
          })),
        },
      };
    },
  };
}

export function createGetBrandConstraintsTool(): QueryTool {
  return {
    name: 'getBrandConstraints',
    description: 'Get brand/template constraints if any',
    execute: (context, _input) => {
      return {
        success: true,
        stableIds: [],
        data: { constraints: context.constraints },
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clipToJson(clip: NonNullable<EditorContext['query']>['clips'][number]): JsonValue {
  return {
    id: clip.id,
    compositionId: clip.compositionId,
    trackId: clip.trackId,
    kind: clip.kind,
    startUs: clip.startUs,
    durationUs: clip.durationUs,
    ...(clip.source !== undefined ? { source: clip.source } : {}),
    ...(clip.name !== undefined ? { name: clip.name } : {}),
  };
}
