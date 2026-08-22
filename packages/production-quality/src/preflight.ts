import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import {
  finding,
  type DeliveryPromiseV1,
  type RenderReportV1,
  type QualityFindingV1,
} from './types.js';

const CAPTION_BURN_IN_KEY = 'joy.captions.burnIn';

export type PlannedAssetKind =
  'video' | 'audio' | 'image' | 'other' | 'html-scene' | 'motion-scene';

export interface QualityOpaqueAssetDescriptor {
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

export interface QualityRenderBundleV1 {
  readonly version: 1;
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly compositionId: string;
  readonly outputPreset: string;
  readonly seed: string;
  readonly assets: Readonly<Record<string, QualityOpaqueAssetDescriptor>>;
}

export interface PreflightInputV1 {
  readonly bundle: QualityRenderBundleV1;
  readonly promise: DeliveryPromiseV1;
}

export function preflightDelivery(input: PreflightInputV1): RenderReportV1 {
  const findings: QualityFindingV1[] = [];
  const visual = input.bundle.visualProject;
  const timeline = input.bundle.timelineProject;
  const composition = visual.compositions[input.bundle.compositionId];
  const timelineComposition = timeline.compositions[timeline.rootCompositionId];

  findings.push(...validateAssets(input.bundle.assets));
  findings.push(...validateTimelineRanges(timeline));
  findings.push(...validateVisualRangesAndOverlaps(visual));
  findings.push(...validateBindings(input.bundle));
  findings.push(...validateCaptions(visual, input.promise));
  findings.push(...validateAudio(visual, input.promise));
  if (composition === undefined) {
    findings.push(finding('composition', 'fail', 'root composition is missing'));
  } else {
    findings.push(
      dimensionsMatch(composition.width, composition.height, input.promise)
        ? finding('dimensions', 'pass', 'composition dimensions match delivery promise')
        : finding('dimensions', 'fail', 'composition dimensions do not match delivery promise', {
            evidence: {
              width: composition.width,
              height: composition.height,
              promisedWidth: input.promise.video.width,
              promisedHeight: input.promise.video.height,
            },
          }),
    );
  }
  if (timelineComposition !== undefined && timelineComposition.durationUs <= 0) {
    findings.push(finding('duration', 'fail', 'timeline duration must be positive'));
  }
  findings.push(...validateWorkflow(input.promise));
  findings.push(...validateApproval(input.promise));
  findings.push(...validateDeterminism(visual, input.promise));

  return {
    version: 1,
    promiseId: input.promise.id,
    checkedAt: '1970-01-01T00:00:00.000Z',
    facts: { container: input.promise.container },
    findings,
  };
}

function validateAssets(
  assets: Readonly<Record<string, QualityOpaqueAssetDescriptor>>,
): readonly QualityFindingV1[] {
  const findings: QualityFindingV1[] = [];
  for (const descriptor of Object.values(assets)) {
    if (descriptor.availability === 'missing' || descriptor.availability === 'unavailable') {
      findings.push(
        finding('asset-availability', 'fail', `asset ${descriptor.id} is not ready`, {
          refId: descriptor.id,
        }),
      );
    }
  }
  if (findings.length === 0)
    findings.push(finding('asset-availability', 'pass', 'all assets are ready'));
  return findings;
}

function validateTimelineRanges(project: SpikeProject): readonly QualityFindingV1[] {
  const findings: QualityFindingV1[] = [];
  for (const [compositionId, composition] of Object.entries(project.compositions)) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        if (
          !Number.isSafeInteger(clip.startUs) ||
          !Number.isSafeInteger(clip.durationUs) ||
          clip.durationUs <= 0
        ) {
          findings.push(
            finding('clip-ranges', 'fail', 'clip range is invalid', {
              refId: clip.id,
              evidence: { compositionId, startUs: clip.startUs, durationUs: clip.durationUs },
            }),
          );
        }
      }
      findings.push(...overlapFindings(track.clips, track.id));
    }
  }
  if (!findings.some((item) => item.code === 'clip-ranges'))
    findings.push(finding('clip-ranges', 'pass', 'clip ranges are valid'));
  return findings;
}

function validateVisualRangesAndOverlaps(project: JoyProjectV1): readonly QualityFindingV1[] {
  const findings: QualityFindingV1[] = [];
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        if (
          !Number.isSafeInteger(clip.startUs) ||
          !Number.isSafeInteger(clip.durationUs) ||
          clip.durationUs <= 0
        ) {
          findings.push(
            finding('clip-ranges', 'fail', 'visual clip range is invalid', { refId: clip.id }),
          );
        }
      }
      findings.push(...overlapFindings(track.clips, track.id));
    }
  }
  return findings;
}

function overlapFindings(
  clips: readonly { readonly id: string; readonly startUs: number; readonly durationUs: number }[],
  trackId: string,
): readonly QualityFindingV1[] {
  const sorted = [...clips].sort((left, right) => left.startUs - right.startUs);
  const findings: QualityFindingV1[] = [];
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.startUs + Math.max(0, previous.durationUs) > current.startUs) {
      findings.push(
        finding('clip-overlap', 'fail', 'enabled clips overlap on one track', {
          refId: trackId,
          evidence: { left: previous.id, right: current.id },
        }),
      );
    }
  }
  return findings;
}

function validateBindings(bundle: QualityRenderBundleV1): readonly QualityFindingV1[] {
  const findings: QualityFindingV1[] = [];
  const project = bundle.visualProject;
  for (const assetId of referencedAssetIds(project)) {
    if (project.assets[assetId] === undefined || bundle.assets[assetId] === undefined) {
      findings.push(
        finding('asset-binding', 'fail', `asset binding ${assetId} is unresolved`, {
          refId: assetId,
        }),
      );
    }
  }
  for (const object of Object.values(project.visualObjects)) {
    if (object.kind === 'html-scene') {
      const id = `html-scene:${object.scenePackageId ?? ''}`;
      if (bundle.assets[id] === undefined) {
        findings.push(
          finding('asset-binding', 'fail', `HTML scene ${id} is unresolved`, { refId: object.id }),
        );
      }
    }
    if (object.kind === 'motion-scene') {
      const id = `motion-scene:${object.motionSceneId ?? ''}`;
      if (bundle.assets[id] === undefined) {
        findings.push(
          finding('asset-binding', 'fail', `Motion scene ${id} is unresolved`, {
            refId: object.id,
          }),
        );
      }
    }
  }
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        if (
          clip.kind === 'caption' &&
          project.captionDocuments[clip.captionDocumentId] === undefined
        ) {
          findings.push(
            finding('caption-binding', 'fail', 'caption clip references a missing document', {
              refId: clip.id,
            }),
          );
        }
      }
    }
  }
  if (!findings.some((item) => item.code === 'asset-binding'))
    findings.push(finding('asset-binding', 'pass', 'asset bindings are resolved'));
  if (!findings.some((item) => item.code === 'caption-binding'))
    findings.push(finding('caption-binding', 'pass', 'caption bindings are resolved'));
  return findings;
}

function referencedAssetIds(project: JoyProjectV1): readonly string[] {
  const ids = new Set<string>();
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) if (clip.kind === 'video') ids.add(clip.assetId);
    }
  }
  for (const object of Object.values(project.visualObjects))
    if (object.assetId !== undefined) ids.add(object.assetId);
  return [...ids];
}

function validateCaptions(
  project: JoyProjectV1,
  promise: DeliveryPromiseV1,
): readonly QualityFindingV1[] {
  const hasCaptionClips = Object.values(project.compositions).some((composition) =>
    composition.tracks.some((track) => track.clips.some((clip) => clip.kind === 'caption')),
  );
  const burnInPromised = project.pluginData[CAPTION_BURN_IN_KEY] === true;
  if (hasCaptionClips && promise.captions.mode === 'none') {
    return [finding('caption-promise', 'fail', 'caption clips require a caption delivery promise')];
  }
  if (promise.captions.required && promise.captions.mode === 'burned-in' && !burnInPromised) {
    return [finding('caption-promise', 'fail', 'burned-in captions are required but not enabled')];
  }
  return [finding('caption-promise', 'pass', 'caption delivery promise is satisfied')];
}

function validateAudio(
  project: JoyProjectV1,
  promise: DeliveryPromiseV1,
): readonly QualityFindingV1[] {
  if (!promise.audio.required) return [finding('audio-presence', 'pass', 'audio is optional')];
  const hasAudioTrack = Object.values(project.compositions).some((composition) =>
    composition.tracks.some((track) => track.kind === 'audio' && track.clips.length > 0),
  );
  const hasMixerClip =
    project.audio !== undefined &&
    Object.values(project.audio.clips).some((clip) => !clip.mute && clip.gain > 0);
  return hasAudioTrack || hasMixerClip
    ? [finding('audio-presence', 'pass', 'audio is present')]
    : [finding('audio-presence', 'fail', 'audio is required but no audible source is present')];
}

function dimensionsMatch(width: number, height: number, promise: DeliveryPromiseV1): boolean {
  return (
    !promise.video.required || (width === promise.video.width && height === promise.video.height)
  );
}

function validateWorkflow(promise: DeliveryPromiseV1): readonly QualityFindingV1[] {
  const workflow = promise.workflow;
  if (workflow === undefined)
    return [finding('workflow-inputs', 'pass', 'no workflow inputs are required')];
  const resolved = new Set(workflow.resolvedInputIds);
  const missing = workflow.requiredInputIds.filter((id) => !resolved.has(id));
  return missing.length === 0
    ? [finding('workflow-inputs', 'pass', 'workflow inputs are resolved')]
    : [
        finding('workflow-inputs', 'fail', 'workflow inputs are unresolved', {
          evidence: { missing: missing.join(',') },
        }),
      ];
}

function validateApproval(promise: DeliveryPromiseV1): readonly QualityFindingV1[] {
  const approval = promise.approval;
  if (approval === undefined || !approval.required)
    return [finding('approval', 'pass', 'approval is not required')];
  return approval.approved && approval.approvalRef !== undefined
    ? [finding('approval', 'pass', 'required approval is present')]
    : [finding('approval', 'fail', 'required approval is missing')];
}

function validateDeterminism(
  project: JoyProjectV1,
  promise: DeliveryPromiseV1,
): readonly QualityFindingV1[] {
  const deterministic = promise.deterministic;
  if (
    deterministic.requireDeterministicEffects &&
    deterministic.allowedEffectIds !== undefined &&
    deterministic.allowedEffectIds.length === 0
  ) {
    return [
      finding('deterministic-policy', 'fail', 'deterministic effect policy has no allowed effects'),
    ];
  }
  if (!deterministic.requireDeterministicEffects)
    return [finding('deterministic-effects', 'pass', 'deterministic effects are not required')];
  const allowed =
    deterministic.allowedEffectIds === undefined
      ? undefined
      : new Set(deterministic.allowedEffectIds);
  const findings: QualityFindingV1[] = [];
  for (const object of Object.values(project.visualObjects)) {
    for (const effect of object.effects ?? []) {
      if (effect.enabled && allowed !== undefined && !allowed.has(effect.effectId)) {
        findings.push(
          finding(
            'deterministic-effects',
            'fail',
            'effect is not allowed by deterministic delivery policy',
            { refId: effect.id },
          ),
        );
      }
    }
  }
  return findings.length === 0
    ? [finding('deterministic-effects', 'pass', 'effects satisfy deterministic policy')]
    : findings;
}
