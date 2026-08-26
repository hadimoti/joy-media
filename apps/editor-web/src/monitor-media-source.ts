import type { AudioClip, VideoClip } from '@joy-media/project-schema';
import type {
  PlayableAssetDescriptor,
  PlayableAssetDerivativeRequest,
  PlayableAssetRequest,
  PlayableAssetResolution,
} from './asset-resolver.js';
import { playableAssetDescriptorFromBrowserAsset } from './asset-card-preview.js';

export interface MonitorPlayableAsset {
  readonly id: string;
  readonly projectId?: string;
  readonly kind: 'video' | 'audio' | 'image' | 'model' | 'other';
  readonly sha256?: string;
  readonly bytes?: number;
  readonly descriptor?: { readonly mimeType?: string };
  readonly displayName?: string;
}

export interface MonitorPlayableDerivative {
  readonly id: string;
  readonly kind: 'thumbnail' | 'proxy';
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: { readonly mimeType: string };
  readonly availability: PlayableAssetDerivativeRequest['availability'];
  readonly verifiedAt?: number;
}

export type MonitorMediaAction =
  | { readonly kind: 'wait'; readonly label: string }
  | { readonly kind: 'reconnect'; readonly label: string }
  | { readonly kind: 'sign-in'; readonly label: string };

export type MonitorMediaSource =
  | {
      readonly state: 'ready';
      readonly clipId: string;
      readonly assetId: string;
      readonly url: string;
      readonly mimeType: string;
      readonly release: () => void;
    }
  | {
      readonly state: 'pending' | 'unavailable' | 'revoked';
      readonly clipId: string;
      readonly assetId: string;
      readonly message: string;
      readonly action: MonitorMediaAction;
    };

export interface MonitorMediaSourceResolver {
  resolve(request: PlayableAssetRequest): Promise<PlayableAssetResolution>;
}

export async function resolveMonitorMediaSource(options: {
  readonly projectId: string;
  readonly clip: VideoClip | AudioClip;
  readonly asset: MonitorPlayableAsset | undefined;
  readonly derivatives?: readonly MonitorPlayableDerivative[];
  readonly resolver: MonitorMediaSourceResolver;
}): Promise<MonitorMediaSource> {
  const { projectId, clip, asset, derivatives = [], resolver } = options;
  const descriptor = playableAssetDescriptorFromBrowserAsset(asset);
  if (descriptor === undefined) {
    return unavailable(clip, 'Reconnect or import the original media for this clip.');
  }

  const resolution = await resolver.resolve({
    projectId: asset?.projectId || projectId,
    asset: descriptor,
    ...(proxyDerivative(derivatives) === undefined
      ? {}
      : { derivative: proxyDerivative(derivatives)! }),
  });

  if (resolution.state === 'ready') {
    return {
      state: 'ready',
      clipId: clip.id,
      assetId: clip.assetId,
      url: resolution.url,
      mimeType: resolution.mimeType,
      release: resolution.release,
    };
  }
  if (resolution.state === 'pending') {
    return {
      state: 'pending',
      clipId: clip.id,
      assetId: clip.assetId,
      message: `Preparing private preview media for ${asset?.displayName ?? clip.assetId}.`,
      action: { kind: 'wait', label: 'Wait for preview' },
    };
  }
  if (resolution.state === 'revoked') {
    return {
      state: 'revoked',
      clipId: clip.id,
      assetId: clip.assetId,
      message: `Media access was revoked for ${asset?.displayName ?? clip.assetId}.`,
      action: { kind: 'sign-in', label: 'Sign in again' },
    };
  }
  return unavailable(
    clip,
    `No playable media is available for ${asset?.displayName ?? clip.assetId}.`,
  );
}

export class MonitorMediaElementBinding {
  private current:
    { readonly clipId: string; readonly url: string; readonly release: () => void } | undefined;

  apply(video: HTMLVideoElement, source: MonitorMediaSource): boolean {
    if (source.state !== 'ready') {
      this.dispose(video);
      return false;
    }
    if (this.current?.clipId === source.clipId && this.current.url === source.url) return false;
    this.dispose(video);
    this.current = { clipId: source.clipId, url: source.url, release: source.release };
    video.src = source.url;
    return true;
  }

  dispose(video?: HTMLVideoElement | null): void {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    if (video !== undefined && video !== null) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    current.release();
  }
}

export async function resolveReadyMonitorMediaSources<T>(
  items: readonly T[],
  resolve: (item: T) => Promise<MonitorMediaSource>,
): Promise<readonly Extract<MonitorMediaSource, { readonly state: 'ready' }>[]> {
  const settled = await Promise.allSettled(items.map((item) => resolve(item)));
  const ready: Extract<MonitorMediaSource, { readonly state: 'ready' }>[] = [];
  let failure: unknown;
  for (const result of settled) {
    if (result.status === 'rejected') {
      failure ??= result.reason;
      continue;
    }
    if (result.value.state === 'ready') ready.push(result.value);
    else failure ??= new Error(result.value.message);
  }
  if (failure !== undefined) {
    releaseMonitorMediaSources(ready);
    throw failure;
  }
  return ready;
}

export function releaseMonitorMediaSources(
  sources: readonly Extract<MonitorMediaSource, { readonly state: 'ready' }>[],
): void {
  for (const source of sources) source.release();
}

export function disposeInactiveMonitorPlayback(options: {
  readonly video?: HTMLVideoElement | null;
  readonly binding: MonitorMediaElementBinding;
  readonly clearActiveClipId: () => void;
  readonly clearPreviewFrame?: () => void;
  readonly clearStatus?: () => void;
}): void {
  options.binding.dispose(options.video);
  options.clearActiveClipId();
  options.clearPreviewFrame?.();
  options.clearStatus?.();
}

export function createReferenceFixturePlayableResolverForTests(options: {
  readonly allowFixtures?: boolean;
  readonly fixtures: Readonly<Record<string, { readonly url: string; readonly mimeType: string }>>;
}): MonitorMediaSourceResolver {
  if (options.allowFixtures !== true)
    throw new Error('Reference media requires an explicit test fixture adapter.');
  return {
    async resolve(request) {
      const fixture = options.fixtures[request.asset.assetId];
      if (fixture === undefined) return { state: 'unavailable' };
      return {
        state: 'ready',
        source: 'fixture',
        url: fixture.url,
        mimeType: fixture.mimeType,
        release: () => undefined,
      };
    },
  };
}

function proxyDerivative(
  derivatives: readonly MonitorPlayableDerivative[],
): PlayableAssetDerivativeRequest | undefined {
  const proxy = [...derivatives]
    .filter((derivative) => derivative.kind === 'proxy')
    .sort((left, right) => {
      const state = availabilityRank(right.availability) - availabilityRank(left.availability);
      return state === 0 ? (right.verifiedAt ?? 0) - (left.verifiedAt ?? 0) : state;
    })[0];
  if (proxy === undefined) return undefined;
  return {
    derivativeId: proxy.id,
    kind: proxy.kind,
    availability: proxy.availability,
    sha256: proxy.sha256,
    byteLength: proxy.bytes,
    mimeType: proxy.descriptor.mimeType,
  };
}

function availabilityRank(value: PlayableAssetDerivativeRequest['availability']): number {
  switch (value) {
    case 'available-cloud':
      return 4;
    case 'available-local':
      return 3;
    case 'pending':
      return 2;
    case 'evicted':
      return 1;
    case 'invalid':
      return 0;
  }
}

function unavailable(clip: VideoClip | AudioClip, message: string): MonitorMediaSource {
  return {
    state: 'unavailable',
    clipId: clip.id,
    assetId: clip.assetId,
    message,
    action: { kind: 'reconnect', label: 'Reconnect media' },
  };
}

export function monitorVideoClipSpecToken(clip: VideoClip): PlayableAssetDescriptor['assetId'] {
  return clip.assetId;
}
