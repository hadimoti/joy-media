import type { RenderFrameIR } from '@joy-media/render-ir';
import type {
  AssetRecordV1,
  ExportPresetId,
  JoyProjectV1,
  SpikeProject,
  TimeUs,
} from '@joy-media/project-schema';

export type PlannedAssetKind = AssetRecordV1['kind'] | 'html-scene' | 'motion-scene';

export interface OpaqueAssetDescriptor {
  readonly id: string;
  readonly kind: PlannedAssetKind;
  readonly displayName?: string;
  readonly opaqueRef: string;
  readonly integrity?: {
    readonly sha256?: string;
    readonly totalBytes?: number;
    readonly mimeType?: string;
  };
  readonly availability?: 'ready' | 'missing' | 'unavailable';
}

export interface RenderBundleV1 {
  readonly version: 1;
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly compositionId: string;
  readonly outputPreset: ExportPresetId | 'preview';
  readonly seed: string;
  readonly assets: Readonly<Record<string, OpaqueAssetDescriptor>>;
}

export interface PlanRenderFrameInput {
  readonly bundle: RenderBundleV1;
  readonly timeUs: TimeUs;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly imageSizesByObjectId?: Readonly<
    Record<string, { readonly width: number; readonly height: number }>
  >;
}

export interface PlannedAssetRequirement {
  readonly assetId: string;
  readonly kind: PlannedAssetKind;
  readonly reason: 'video-sample' | 'still-bitmap' | 'html-scene' | 'motion-scene' | 'audio-sample';
  readonly descriptor?: OpaqueAssetDescriptor;
}

export interface PlannedVideoSample {
  readonly clipId: string;
  readonly assetId: string;
  readonly sourceTimeUs: number;
  readonly role: 'primary' | 'transition-left' | 'transition-right';
}

export interface PlannedAudioSample {
  readonly clipId: string;
  readonly assetId: string;
  readonly sourceTimeUs: number;
  readonly gain: number;
  readonly pan: number;
}

export interface PlannedCaptureRequirement {
  readonly id: string;
  readonly kind: 'video-frame' | 'still-bitmap' | 'html-scene' | 'motion-scene' | 'caption-burn-in';
  readonly assetId?: string;
  readonly clipId?: string;
  readonly objectId?: string;
  readonly sourceTimeUs?: number;
}

export interface DeterministicFinding {
  readonly code: 'missing-media' | 'unavailable-media' | 'expression-fallback' | 'caption-burn-in';
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly refId?: string;
}

export interface RenderFramePlan {
  readonly frame: RenderFrameIR;
  readonly requiredAssets: readonly PlannedAssetRequirement[];
  readonly videoSamples: readonly PlannedVideoSample[];
  readonly audioSamples: readonly PlannedAudioSample[];
  readonly captureRequirements: readonly PlannedCaptureRequirement[];
  readonly findings: readonly DeterministicFinding[];
  readonly outputPreset: ExportPresetId | 'preview';
  readonly seed: string;
}
