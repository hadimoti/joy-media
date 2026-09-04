import type { CreativeBriefV1 } from '@joy-media/agent-tools';

export interface JoyAgentContextSnapshot {
  readonly projectId: string;
  readonly revision: string;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly clips: readonly {
    readonly id: string;
    readonly trackId: string;
    readonly startUs: number;
    readonly durationUs: number;
  }[];
  readonly assets: readonly {
    readonly id: string;
    readonly kind: string;
    readonly displayName: string;
  }[];
  /** A validated, read-only brief artifact attached to the next Composer run. */
  readonly creativeBrief?: CreativeBriefV1;
  readonly omitted: readonly string[];
}

const MAX_CONTEXT_BYTES = 60_000;
const MAX_CLIPS = 128;
const MAX_ASSETS = 128;
const UNSAFE_CONTEXT_TEXT =
  /(?:https?:\/\/|ftp:\/\/|(?:[A-Za-z]:[\\/]|\\\\)[^\s]+|\/(?:Users|home|opt|tmp|var|etc)\/|(?:api[_-]?key|authorization|bearer|secret|token)\s*[:=]|sk-[A-Za-z0-9_-]{20,})/i;

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return normalized.length === 0 || UNSAFE_CONTEXT_TEXT.test(normalized) ? undefined : normalized;
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Build one immutable, byte-bounded model context; never forwards project objects. */
export function createJoyAgentContextSnapshot(input: {
  readonly projectId: string;
  readonly revision: string;
  readonly selectedClipIds?: readonly string[];
  readonly playheadUs?: number;
  readonly clips?: readonly {
    readonly id: string;
    readonly trackId: string;
    readonly startUs: number;
    readonly durationUs: number;
  }[];
  readonly assets?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly displayName: string;
  }[];
  /** Optional validated brief context; bounded before crossing into the Worker. */
  readonly creativeBrief?: CreativeBriefV1;
}): JoyAgentContextSnapshot {
  const omitted: string[] = [];
  const projectId = safeText(input.projectId, 128) ?? 'unknown-project';
  const revision = safeText(input.revision, 256) ?? 'unknown-revision';
  if (projectId === 'unknown-project' || revision === 'unknown-revision') omitted.push('identity');
  const selectedClipIds = (input.selectedClipIds ?? [])
    .slice(0, 64)
    .map((id) => safeText(id, 128))
    .filter((id): id is string => id !== undefined);
  if (selectedClipIds.length !== (input.selectedClipIds ?? []).length)
    omitted.push('selectedClipIds');
  const clips = (input.clips ?? [])
    .slice(0, MAX_CLIPS)
    .map((clip) => {
      const id = safeText(clip.id, 128);
      const trackId = safeText(clip.trackId, 128);
      if (id === undefined || trackId === undefined) return undefined;
      return {
        id,
        trackId,
        startUs: Number.isFinite(clip.startUs) ? Math.max(0, clip.startUs) : 0,
        durationUs: Number.isFinite(clip.durationUs) ? Math.max(0, clip.durationUs) : 0,
      };
    })
    .filter((clip): clip is NonNullable<typeof clip> => clip !== undefined);
  const assets = (input.assets ?? [])
    .slice(0, MAX_ASSETS)
    .map((asset) => {
      const id = safeText(asset.id, 128);
      const kind = safeText(asset.kind, 64);
      const displayName = safeText(asset.displayName, 160);
      if (id === undefined || kind === undefined || displayName === undefined) return undefined;
      return { id, kind, displayName };
    })
    .filter((asset): asset is NonNullable<typeof asset> => asset !== undefined);
  if (clips.length !== (input.clips?.length ?? 0) || (input.clips?.length ?? 0) > MAX_CLIPS)
    omitted.push('clips');
  if (assets.length !== (input.assets?.length ?? 0) || (input.assets?.length ?? 0) > MAX_ASSETS)
    omitted.push('assets');
  const creativeBrief = input.creativeBrief;
  if (creativeBrief !== undefined) {
    const bytes = byteLength(creativeBrief);
    if (bytes > 32_768 || UNSAFE_CONTEXT_TEXT.test(JSON.stringify(creativeBrief)))
      throw new RangeError('creative brief context is invalid or too large');
  }
  const snapshot = {
    projectId,
    revision,
    selectedClipIds: Object.freeze(selectedClipIds),
    playheadUs: Number.isFinite(input.playheadUs) ? Math.max(0, input.playheadUs ?? 0) : 0,
    clips: Object.freeze(clips),
    assets: Object.freeze(assets),
    ...(creativeBrief === undefined ? {} : { creativeBrief }),
    omitted: Object.freeze(omitted),
  };
  if (byteLength(snapshot) > MAX_CONTEXT_BYTES)
    throw new RangeError('JOY context snapshot is too large');
  return Object.freeze(snapshot);
}
