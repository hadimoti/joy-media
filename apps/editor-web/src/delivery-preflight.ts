import type { SpikeProject } from '@joy-media/project-schema';
import {
  preflightCompositionPlanV2,
  type CompositionPlanV2,
} from '../../../packages/render-planner/src/v2.js';

/**
 * Pure delivery readiness checks shared by browser export and verified
 * delivery. A button may only be enabled when the timeline, its source media,
 * and the requested delivery adapter all have explicit evidence.
 */

export type DeliveryChannel = 'quick-browser-export' | 'verified-delivery';

export type DeliveryMediaState = 'ready' | 'pending' | 'unavailable' | 'revoked' | 'missing';

/**
 * The delivery gate consumes resolver evidence, not catalog metadata. Keep
 * this conversion at the boundary so a malformed "ready" result cannot
 * accidentally enable delivery without a concrete playable source.
 */
export function deliveryMediaStateFromEvidence(evidence: {
  readonly state: DeliveryMediaState;
  readonly url?: string;
  readonly mimeType?: string;
}): DeliveryMediaState {
  if (evidence.state !== 'ready') return evidence.state;
  return typeof evidence.url === 'string' &&
    evidence.url.trim().length > 0 &&
    typeof evidence.mimeType === 'string' &&
    evidence.mimeType.trim().length > 0
    ? 'ready'
    : 'unavailable';
}

export type DeliveryCapability = 'browser-mp4' | 'worker-render-export';

export interface DeliveryTimelineClip {
  readonly id: string;
  readonly assetId: string;
  readonly durationUs: number;
  readonly startUs?: number;
  readonly sourceInUs?: number;
  readonly playbackRate?: number;
  readonly kind?: 'video' | 'audio' | 'composition' | 'caption' | string;
}

/** Project-to-gate projection shared by App and delivery integration tests. */
export function deliveryTimelineClipsFromProject(
  project: SpikeProject,
): readonly DeliveryTimelineClip[] {
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) return [];
  return composition.tracks.flatMap((track) =>
    track.clips.flatMap((clip): readonly DeliveryTimelineClip[] => {
      if (clip.kind === 'video')
        return [
          {
            id: clip.id,
            assetId: clip.assetId,
            durationUs: clip.durationUs,
            startUs: clip.startUs,
            sourceInUs: clip.sourceInUs,
            kind: 'video' as const,
            ...(clip.playbackRate === undefined ? {} : { playbackRate: clip.playbackRate }),
          },
        ];
      if (clip.kind === 'audio')
        return [
          {
            id: clip.id,
            assetId: clip.assetId,
            durationUs: clip.durationUs,
            kind: 'audio' as const,
            ...(clip.playbackRate === undefined ? {} : { playbackRate: clip.playbackRate }),
          },
        ];
      return [];
    }),
  );
}

/** The intentionally narrow envelope accepted by render-host's verified export. */
export interface VerifiedRenderEnvelope {
  readonly visualObjectCount?: number;
  readonly transitionCount?: number;
  /** Number of transitions that passed the normalized V2 dissolve contract. */
  readonly supportedTransitionCount?: number;
  readonly captionBurnIn?: boolean;
  /** Signed V2 payload; required when captionBurnIn is enabled. */
  readonly captionBurnInPayload?: unknown;
  readonly audioEffectCount?: number;
  readonly audioBusCount?: number;
  readonly audioFadeCount?: number;
  readonly unsupportedClipCount?: number;
  readonly nonContiguous?: boolean;
  readonly nonOneXPlaybackCount?: number;
  readonly unsupportedAssetCount?: number;
  /** Planner-normalized V2 intent, when available. The planner is authoritative for visual layers/captions. */
  readonly verifiedRenderPlan?: CompositionPlanV2;
  /** Error returned while normalizing the current visual project. */
  readonly verifiedRenderPlanError?: string;
}

export interface DeliveryPreflightInput {
  readonly channel: DeliveryChannel;
  readonly clips: readonly DeliveryTimelineClip[];
  readonly mediaStates: ReadonlyMap<string, DeliveryMediaState>;
  readonly capabilities: readonly DeliveryCapability[];
  /** Only consulted for verified delivery; quick browser export remains permissive. */
  readonly verifiedRenderEnvelope?: VerifiedRenderEnvelope;
}

export type DeliveryPreflightCode =
  | 'no-renderable-media'
  | 'media-not-ready'
  | 'capability-unavailable'
  | 'unsupported-render-envelope';

export interface DeliveryPreflightResult {
  readonly channel: DeliveryChannel;
  readonly allowed: boolean;
  readonly code?: DeliveryPreflightCode;
  readonly reason?: string;
}

const CAPABILITY_BY_CHANNEL: Readonly<Record<DeliveryChannel, DeliveryCapability>> = {
  'quick-browser-export': 'browser-mp4',
  'verified-delivery': 'worker-render-export',
};

/** Return an actionable, stable result suitable for disabled-button copy. */
export function deliveryPreflight(input: DeliveryPreflightInput): DeliveryPreflightResult {
  const { channel, clips, mediaStates } = input;
  const base = { channel } as const;
  const renderableClips = clips.filter(
    (clip) => clip.assetId.trim().length > 0 && clip.durationUs > 0,
  );
  if (renderableClips.length === 0) {
    return {
      ...base,
      allowed: false,
      code: 'no-renderable-media',
      reason: 'Add a video clip with a positive duration to the timeline before delivering.',
    };
  }

  const unresolved = renderableClips.filter((clip) => mediaStates.get(clip.id) !== 'ready');
  if (unresolved.length > 0) {
    const first = unresolved[0]!;
    const state = mediaStates.get(first.id);
    const detail =
      state === undefined || state === 'missing'
        ? 'Source media is missing.'
        : state === 'pending'
          ? 'Source media is still preparing.'
          : state === 'revoked'
            ? 'Source media access was revoked.'
            : 'Source media is not playable.';
    return {
      ...base,
      allowed: false,
      code: 'media-not-ready',
      reason: `${detail} Reconnect or import the original media, then try again.`,
    };
  }

  const requiredCapability = CAPABILITY_BY_CHANNEL[channel];
  if (!input.capabilities.includes(requiredCapability)) {
    return {
      ...base,
      allowed: false,
      code: 'capability-unavailable',
      reason:
        channel === 'quick-browser-export'
          ? 'Browser MP4 recording is unavailable in this browser.'
          : 'No connected Worker advertises render export. Pair a Worker with render.export and try again.',
    };
  }

  if (channel === 'verified-delivery') {
    const videoClips = renderableClips.filter(
      (clip) => clip.kind === undefined || clip.kind === 'video',
    );
    if (videoClips.length === 0) {
      return {
        ...base,
        allowed: false,
        code: 'unsupported-render-envelope',
        reason: 'Verified delivery requires at least one video clip.',
      };
    }
    if (
      renderableClips.some(
        (clip) => clip.kind !== undefined && clip.kind !== 'video' && clip.kind !== 'audio',
      )
    ) {
      return {
        ...base,
        allowed: false,
        code: 'unsupported-render-envelope',
        reason: 'Use only video and audio clips for verified delivery.',
      };
    }
    const envelope = input.verifiedRenderEnvelope;
    const hasNormalizedV2Plan = envelope?.verifiedRenderPlan !== undefined;
    if (
      renderableClips.some(
        (clip) =>
          clip.kind === 'audio' &&
          clip.playbackRate !== undefined &&
          (!Number.isFinite(clip.playbackRate) ||
            clip.playbackRate < 0.1 ||
            clip.playbackRate > 8 ||
            (!hasNormalizedV2Plan && clip.playbackRate !== 1)),
      )
    ) {
      return {
        ...base,
        allowed: false,
        code: 'unsupported-render-envelope',
        reason: hasNormalizedV2Plan
          ? 'Standalone audio playback speed must be within the supported 0.1×–8× range.'
          : 'Standalone audio clips must use 1× speed before using verified delivery.',
      };
    }
    if (
      renderableClips.some(
        (clip) =>
          (clip.kind === undefined || clip.kind === 'video') &&
          clip.playbackRate !== undefined &&
          (!Number.isFinite(clip.playbackRate) || clip.playbackRate < 0.1 || clip.playbackRate > 8),
      )
    ) {
      return {
        ...base,
        allowed: false,
        code: 'unsupported-render-envelope',
        reason: 'Video playback speed must be within the supported 0.1×–8× range.',
      };
    }
    if (
      !hasNormalizedV2Plan &&
      renderableClips.some((clip) => clip.playbackRate !== undefined && clip.playbackRate !== 1)
    ) {
      return {
        ...base,
        allowed: false,
        code: 'unsupported-render-envelope',
        reason: 'Set every video clip to 1× speed before using verified delivery.',
      };
    }
    const unsupportedReason = verifiedEnvelopeReason(envelope);
    if (unsupportedReason !== undefined) {
      return {
        ...base,
        allowed: false,
        code: 'unsupported-render-envelope',
        reason: unsupportedReason,
      };
    }
    const transitionCount = envelope?.transitionCount ?? 0;
    if (
      transitionCount > 0 &&
      renderableClips.filter((clip) => clip.kind === undefined || clip.kind === 'video').length !==
        2
    ) {
      return {
        ...base,
        allowed: false,
        code: 'unsupported-render-envelope',
        reason: 'Verified dissolve transitions require exactly two renderable video clips.',
      };
    }
  }

  return { ...base, allowed: true };
}

function verifiedEnvelopeReason(envelope: VerifiedRenderEnvelope | undefined): string | undefined {
  if (envelope === undefined) {
    return 'This project is not eligible for verified delivery yet.';
  }
  if (envelope.verifiedRenderPlanError !== undefined) return envelope.verifiedRenderPlanError;
  if (envelope.verifiedRenderPlan !== undefined) {
    const planner = preflightCompositionPlanV2(envelope.verifiedRenderPlan);
    if (!planner.allowed)
      return planner.reason ?? 'This project is not eligible for verified delivery yet.';
    const unsupportedVideoRate = envelope.verifiedRenderPlan.layers.find(
      (layer) =>
        layer.kind === 'video' &&
        layer.playbackRate !== undefined &&
        (!Number.isFinite(layer.playbackRate) ||
          layer.playbackRate < 0.1 ||
          layer.playbackRate > 8),
    );
    if (unsupportedVideoRate !== undefined)
      return 'Video playback speed must be within the supported 0.1×–8× range.';
    const standaloneAudioRate = envelope.verifiedRenderPlan.audio.find(
      (layer) =>
        layer.sourceKind === 'audio-asset' &&
        layer.playbackRate !== undefined &&
        (!Number.isFinite(layer.playbackRate) ||
          layer.playbackRate < 0.1 ||
          layer.playbackRate > 8),
    );
    if (standaloneAudioRate !== undefined)
      return 'Standalone audio playback speed must be within the supported 0.1×–8× range.';
  } else if ((envelope.visualObjectCount ?? 0) > 0) {
    return 'Remove visual overlays before using verified delivery.';
  }
  const transitionCount = envelope.transitionCount ?? 0;
  if (transitionCount > 1) return 'Verified delivery supports at most one dissolve transition.';
  if (transitionCount > (envelope.supportedTransitionCount ?? 0))
    return 'Only normalized dissolve transitions are supported for verified delivery.';
  if (envelope.captionBurnIn === true)
    try {
      assertCaptionBurnInPayloadShape(envelope.captionBurnInPayload);
    } catch {
      return 'Turn off burned-in captions or provide a renderer-valid V2 payload.';
    }
  const permittedMasterLimiter = envelope.verifiedRenderPlan?.masterLimiter !== undefined;
  if (
    (envelope.audioEffectCount ?? 0) > (permittedMasterLimiter ? 1 : 0) ||
    (envelope.audioBusCount ?? 0) > 0
  )
    return 'Remove audio effects and buses before using verified delivery.';
  if ((envelope.unsupportedClipCount ?? 0) > 0)
    return 'Use only video and audio clips for verified delivery.';
  // Normalized V2 plans carry explicit clip starts and the Worker renders
  // non-overlapping holes as black/silence. Legacy envelopes have no such
  // contract and retain the conservative contiguous requirement.
  if (envelope.verifiedRenderPlan === undefined && envelope.nonContiguous === true)
    return 'Video clips must be contiguous from the start of the timeline.';
  if (envelope.verifiedRenderPlan === undefined && (envelope.nonOneXPlaybackCount ?? 0) > 0)
    return 'Set every video clip to 1× speed before using verified delivery.';
  if ((envelope.unsupportedAssetCount ?? 0) > 0)
    return 'Use file-backed video assets for verified delivery.';
  return undefined;
}

/**
 * Retain a small shape check for legacy callers that do not yet provide a
 * normalized plan. When a plan is present, the planner's digest-aware
 * validation above is authoritative and the Worker repeats it at the trust
 * boundary.
 */
function assertCaptionBurnInPayloadShape(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('caption burn-in payload must be an object');
  const payload = value as Record<string, unknown>;
  const keys = new Set(['intent', 'styleRef', 'segments', 'payloadSha256']);
  for (const key of Object.keys(payload))
    if (!keys.has(key)) throw new Error(`caption payload contains unsupported field "${key}"`);
  if (payload.intent !== 'burn-in') throw new Error('caption payload intent must be burn-in');
  if (
    payload.styleRef !== 'joy-clean' &&
    payload.styleRef !== 'joy-karaoke-pop' &&
    payload.styleRef !== 'joy-rtl-classic'
  )
    throw new Error('caption styleRef is not a supported built-in style');
  if (!Array.isArray(payload.segments))
    throw new Error('caption payload segments must be an array');
  const ids = new Set<string>();
  let previousStartUs = -1;
  let previousId = '';
  for (const [index, item] of payload.segments.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new Error(`caption segment ${index} must be an object`);
    const segment = item as Record<string, unknown>;
    const segmentKeys = new Set(['id', 'startUs', 'endUs', 'text', 'direction']);
    for (const key of Object.keys(segment))
      if (!segmentKeys.has(key))
        throw new Error(`caption segment ${index} contains unsupported field`);
    if (
      typeof segment.id !== 'string' ||
      segment.id.length === 0 ||
      ids.has(segment.id) ||
      typeof segment.startUs !== 'number' ||
      !Number.isSafeInteger(segment.startUs) ||
      segment.startUs < 0 ||
      typeof segment.endUs !== 'number' ||
      !Number.isSafeInteger(segment.endUs) ||
      segment.endUs <= segment.startUs ||
      typeof segment.text !== 'string' ||
      segment.text.length === 0 ||
      (segment.direction !== 'ltr' && segment.direction !== 'rtl')
    )
      throw new Error(`caption segment ${index} is invalid`);
    if (
      segment.startUs < previousStartUs ||
      (segment.startUs === previousStartUs && segment.id.localeCompare(previousId) < 0)
    )
      throw new Error('caption payload segments must be in canonical time/id order');
    ids.add(segment.id);
    previousStartUs = segment.startUs;
    previousId = segment.id;
  }
  if (typeof payload.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(payload.payloadSha256))
    throw new Error('caption payload digest is invalid');
}
