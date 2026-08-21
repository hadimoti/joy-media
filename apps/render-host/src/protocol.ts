import type { RenderManifest } from '@joy-media/export-core';
import type {
  PlannedAudioSample,
  PlannedCaptureRequirement,
  PlannedVideoSample,
  RenderBundleV1,
  RenderFramePlan,
} from '@joy-media/render-planner';

export const RENDER_HOST_PROTOCOL_VERSION = 1 as const;
export const RENDER_HOST_VERSION = '0.1.0' as const;

export interface RenderHostMediaResolver {
  require(opaqueRef: string): RenderHostResolvedMedia;
  describe(opaqueRef: string): { readonly opaqueRef: string };
}

export type RenderHostResolvedMedia =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'html-scene'; readonly packageId: string };

export interface RenderHostResolvedInput {
  readonly opaqueRef: string;
  readonly resolved: RenderHostResolvedMedia;
  readonly contentSha256: string;
}

export interface RenderHostResolvedVideoSample extends PlannedVideoSample {
  readonly media: RenderHostResolvedInput;
}

export interface RenderHostResolvedAudioSample extends PlannedAudioSample {
  readonly media: RenderHostResolvedInput;
}

export interface RenderHostResolvedCapture extends PlannedCaptureRequirement {
  readonly media: RenderHostResolvedInput;
}

export interface RenderHostFrameInputV1 {
  readonly plan: RenderFramePlan;
  readonly videoSamples: readonly RenderHostResolvedVideoSample[];
  readonly stillBitmaps: readonly RenderHostResolvedCapture[];
  readonly htmlScenes: readonly RenderHostResolvedCapture[];
  readonly audioSamples: readonly RenderHostResolvedAudioSample[];
}

export interface RenderHostExportRequestV1 {
  readonly protocolVersion: typeof RENDER_HOST_PROTOCOL_VERSION;
  readonly bundle: RenderBundleV1;
  readonly outputPath: string;
  readonly mediaResolver: RenderHostMediaResolver;
  readonly frameLimit?: number;
}

export interface RenderHostExportResultV1 {
  readonly manifest: RenderManifest;
  readonly frames: number;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly toolVersions: {
    readonly renderHost: string;
    readonly ffmpeg: string;
    readonly ffprobe: string;
  };
}

export interface RenderHostDriver {
  export(request: RenderHostExportRequestV1): Promise<RenderHostExportResultV1>;
}
