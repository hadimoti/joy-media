/**
 * Resolve + decode the active composition's audio for a Living Looks audio bake
 * (R2 / GAP 2).
 *
 * `selectCompositionAudioClip` is a pure pick from the universal timeline;
 * `loadCompositionAudioForLook` orchestrates the browser side (resolve asset
 * URL → fetch → `decodeAudioData`) with those two effects injected so it stays
 * testable. The decoded PCM + clip placement feed `bakeLookFromAudio`.
 */

import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { DecodedCompositionAudio, LookAudioClipPlacement } from './living-look-audio.js';

export interface CompositionAudioClip {
  readonly clipId: string;
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly sourceInUs: number;
}

/**
 * The first audio-backed timeline item in the root composition (earliest start,
 * then track order). `undefined` when the composition has no audio to analyse.
 */
export function selectCompositionAudioClip(visual: JoyProjectV1): CompositionAudioClip | undefined {
  const rootId = visual.rootCompositionId;
  const items = (visual.universalTimeline?.items ?? [])
    .filter(
      (item) =>
        item.compositionId === rootId &&
        item.elementKind === 'audio' &&
        item.source.kind === 'asset' &&
        visual.assets[item.source.id]?.kind === 'audio',
    )
    .sort((a, b) => a.startUs - b.startUs || a.withinTrackOrder - b.withinTrackOrder);
  const chosen = items[0];
  if (chosen === undefined || chosen.source.kind !== 'asset') return undefined;
  return {
    clipId: chosen.id,
    assetId: chosen.source.id,
    startUs: chosen.startUs,
    durationUs: chosen.durationUs,
    sourceInUs: chosen.sourceInUs ?? 0,
  };
}

/** Minimal AudioContext surface — only what a bake decode needs. */
export interface LookAudioDecodeContext {
  decodeAudioData(data: ArrayBuffer): Promise<{
    readonly sampleRate: number;
    readonly numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
  }>;
}

export interface LoadCompositionAudioDeps {
  readonly visual: JoyProjectV1;
  /** Resolve one asset id to a fetchable object/URL. */
  readonly resolveAssetUrl: (assetId: string) => Promise<string>;
  readonly fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  readonly createAudioContext: () => LookAudioDecodeContext & {
    close?: () => Promise<void> | void;
  };
}

export type LoadCompositionAudioResult =
  | {
      readonly kind: 'ready';
      readonly audio: DecodedCompositionAudio;
      readonly clip: LookAudioClipPlacement;
    }
  | { readonly kind: 'no-audio' }
  | { readonly kind: 'error'; readonly message: string };

const defaultFetchBytes = async (url: string): Promise<ArrayBuffer> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`audio fetch failed (${response.status})`);
  return response.arrayBuffer();
};

export async function loadCompositionAudioForLook(
  deps: LoadCompositionAudioDeps,
): Promise<LoadCompositionAudioResult> {
  const clip = selectCompositionAudioClip(deps.visual);
  if (clip === undefined) return { kind: 'no-audio' };

  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
  let context: (LookAudioDecodeContext & { close?: () => Promise<void> | void }) | undefined;
  try {
    const url = await deps.resolveAssetUrl(clip.assetId);
    const bytes = await fetchBytes(url);
    context = deps.createAudioContext();
    const decoded = await context.decodeAudioData(bytes);
    if (decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2) {
      return { kind: 'error', message: 'Audio must be mono or stereo to bake motion from it.' };
    }
    const channels = Array.from(
      { length: decoded.numberOfChannels },
      (_, channel) => new Float32Array(decoded.getChannelData(channel)),
    );
    return {
      kind: 'ready',
      audio: {
        sampleRate: decoded.sampleRate,
        channels,
        // The decoded buffer starts at the clip's source in-point.
        sourceOffsetUs: clip.sourceInUs,
      },
      clip: {
        compositionStartUs: clip.startUs,
        compositionDurationUs: clip.durationUs,
        sourceAnchorUs: clip.sourceInUs,
        // R2 assumes normal-speed audio clips; a per-clip speed control is a
        // separate feature. A stale bake from before a speed edit is caught by
        // the operator re-baking (and by the deterministic timing derivation).
        sourcePerComposition: { numerator: 1, denominator: 1 },
      },
    };
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message.slice(0, 200) : 'audio decode failed',
    };
  } finally {
    try {
      await context?.close?.();
    } catch {
      // closing a one-shot decode context is best effort.
    }
  }
}
