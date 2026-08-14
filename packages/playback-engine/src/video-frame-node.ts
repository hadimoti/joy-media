/**
 * Bridge between WP-11.2 browser decode and the renderer-neutral RenderFrameIR.
 *
 * The IR boundary stays renderer-neutral and never carries raw pixel data —
 * `VideoFrameNode.color` is a flat tint. Real decoded pixels ride on the
 * {@link DecodedFrame.bitmap} (ImageDataLike) returned by the decoder and
 * are mapped to a frame node by these helpers. The editor renderer is then
 * responsible for painting the bitmap into the Monitor canvas.
 */
import type {
  ColorGradeIR,
  EffectInstanceIR,
  RenderFrameIR,
  RenderNode,
  Transform2D,
  VideoFrameNode,
} from '@joy-media/render-ir';
import { validateRenderFrameIR } from '@joy-media/render-ir';
import type { MediaSource } from './decoder.js';
import type { DecodedFrame } from './index.js';

export interface VideoClipSpec {
  /** Stable id used as the IR node id and as the `MediaSource.assetId`. */
  readonly id: string;
  /** Original media URL or token (full resolution). */
  readonly originalToken: string;
  /** Optional lower-resolution proxy URL or token. */
  readonly proxyToken?: string;
  /** Composition-relative start in microseconds. */
  readonly startUs: number;
  /** Clip duration in microseconds. */
  readonly durationUs: number;
  /** Source-time offset of the clip's first frame. */
  readonly sourceInUs: number;
  /** Evaluated transform at the playhead (caller-resolved). */
  readonly transform: Transform2D;
  /** Final opacity at the playhead, in [0, 1]. */
  readonly opacity: number;
  /** Draw order. Higher values render later. */
  readonly zIndex: number;
  /** Optional grade resolved for this timeline clip before compositing. */
  readonly colorGrade?: ColorGradeIR;
  /** Evaluated effects applied to the decoded frame before compositing. */
  readonly effects?: readonly EffectInstanceIR[];
}

/** Build a {@link MediaSource} from an imported/proxy clip record. */
export function importedClipToMediaSource(clip: VideoClipSpec): MediaSource {
  return clip.proxyToken === undefined
    ? { assetId: clip.id, originalToken: clip.originalToken }
    : { assetId: clip.id, originalToken: clip.originalToken, proxyToken: clip.proxyToken };
}

/**
 * Project a decoded video frame onto a {@link VideoFrameNode} keyed by clip id.
 *
 * Dimensions come from the bitmap when present, falling back to the
 * decoder's `videoWidth`/`videoHeight` (which the caller is expected to
 * supply via the clip's `originalToken` metadata). The returned node carries
 * the resolved `sourceTimeUs` so the editor renderer can correlate back to
 * the underlying `ImageData`.
 */
export function videoFrameNodeFromDecoded(
  clip: VideoClipSpec,
  decoded: DecodedFrame,
  intrinsic: { readonly width: number; readonly height: number } = {
    width: 0,
    height: 0,
  },
): VideoFrameNode {
  const width = decoded.bitmap?.width ?? intrinsic.width;
  const height = decoded.bitmap?.height ?? intrinsic.height;
  return {
    kind: 'video-frame',
    id: clip.id,
    zIndex: clip.zIndex,
    opacity: clip.opacity,
    transform: clip.transform,
    width,
    height,
    sourceTimeUs: decoded.sourceTimeUs,
    color: { r: 0, g: 0, b: 0, a: 0 },
    ...(clip.colorGrade === undefined ? {} : { colorGrade: clip.colorGrade }),
    ...(clip.effects === undefined ? {} : { effects: clip.effects }),
  };
}

/** Return a new `RenderFrameIR` with the supplied node appended. */
export function withVideoFrameNode(frame: RenderFrameIR, node: VideoFrameNode): RenderFrameIR {
  const nextNodes: readonly RenderNode[] = [...frame.nodes, node];
  const next: RenderFrameIR = { ...frame, nodes: nextNodes };
  validateRenderFrameIR(next);
  return next;
}
