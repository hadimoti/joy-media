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
}

export interface DeliveryPreflightInput {
  readonly channel: DeliveryChannel;
  readonly clips: readonly DeliveryTimelineClip[];
  readonly mediaStates: ReadonlyMap<string, DeliveryMediaState>;
  readonly capabilities: readonly DeliveryCapability[];
}

export type DeliveryPreflightCode =
  'no-renderable-media' | 'media-not-ready' | 'capability-unavailable';

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
        ? `Media for “${first.assetId}” is missing.`
        : state === 'pending'
          ? `Media for “${first.assetId}” is still preparing.`
          : state === 'revoked'
            ? `Media access for “${first.assetId}” was revoked.`
            : `Media for “${first.assetId}” is not playable.`;
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

  return { ...base, allowed: true };
}
