import { captionCuesAt, layoutTemplatedCaptionNodes } from '@joy-media/captions-core';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import type {
  JoyProjectV1,
  CompositionV1,
  SpikeProject,
  TimeUs,
  TransitionV1,
  VideoClip,
  VisualObjectV1,
} from '@joy-media/project-schema';
import type { RenderNode, TextNode } from '@joy-media/render-ir';
import { sourceTimeForTransitionSample } from '@joy-media/timeline-engine';
import {
  buildRenderFrameIR,
  clipTimesFromTracks,
  isTransitionActive,
  type BuildRenderFrameOptions,
  type ResolvedObject,
} from '@joy-media/visual-object-renderer';
import type {
  DeterministicFinding,
  OpaqueAssetDescriptor,
  PlanRenderFrameInput,
  PlannedAssetRequirement,
  PlannedAudioSample,
  PlannedCaptureRequirement,
  PlannedVideoSample,
  RenderFramePlan,
} from './types.js';

export const CAPTION_BURN_IN_KEY = 'joy.captions.burnIn' as const;

export function planRenderFrame(input: PlanRenderFrameInput): RenderFramePlan {
  const { bundle, timeUs } = input;
  assertFrameTime(timeUs);
  const visualComposition = requireVisualComposition(bundle.visualProject, bundle.compositionId);
  const width = input.viewport?.width ?? visualComposition.width;
  const height = input.viewport?.height ?? visualComposition.height;
  const objectsById = bundle.visualProject.visualObjects as Readonly<
    Record<string, VisualObjectV1>
  >;
  const findings: DeterministicFinding[] = [];
  const resolved: ResolvedObject[] = Object.values(bundle.visualProject.visualObjects).map(
    (object) => {
      const evaluated = evaluateCameraExpressionTransform(
        object.id,
        visualComposition.activeCameraId,
        objectsById,
        timeUs,
        height,
      );
      for (const diagnostic of evaluated.diagnostics) {
        findings.push({
          code: 'expression-fallback',
          severity: 'warning',
          refId: object.id,
          message: `${diagnostic.objectId}.${diagnostic.property}: ${diagnostic.message}`,
        });
      }
      return {
        object,
        transform: evaluated.transform,
        expressionDiagnostics: evaluated.diagnostics.map((diagnostic) => ({
          channel: diagnostic.property,
          message: diagnostic.message,
        })),
      };
    },
  );

  const renderOptions = renderFrameOptions(
    bundle.visualProject,
    visualComposition,
    input.imageSizesByObjectId,
  );
  const baseFrame = buildRenderFrameIR(
    visualComposition.id,
    timeUs,
    width,
    height,
    resolved,
    renderOptions,
  );
  const captionNodes = captionBurnInNodes(
    bundle.visualProject,
    visualComposition,
    timeUs,
    width,
    height,
  );
  const frame =
    captionNodes.length === 0
      ? baseFrame
      : { ...baseFrame, nodes: appendCaptionNodes(baseFrame.nodes, captionNodes) };

  const transition = activeTransitionAt(bundle.visualProject, visualComposition, timeUs);
  const videoSamples = plannedVideoSamples(bundle.timelineProject, timeUs, transition);
  const audioSamples = plannedAudioSamples(bundle.timelineProject, bundle.visualProject, timeUs);
  const captureRequirements = plannedCaptureRequirements(
    bundle.visualProject,
    timeUs,
    videoSamples,
    captionNodes,
  );
  const requiredAssets = plannedAssetRequirements(
    bundle.assets,
    bundle.visualProject,
    videoSamples,
    audioSamples,
  );
  findings.push(...mediaFindings(requiredAssets));
  if (captionNodes.length > 0) {
    findings.push({
      code: 'caption-burn-in',
      severity: 'info',
      message: `Burned in ${captionNodes.length} caption node(s)`,
    });
  }

  return {
    frame,
    requiredAssets,
    videoSamples,
    audioSamples,
    captureRequirements,
    findings,
    outputPreset: bundle.outputPreset,
    seed: bundle.seed,
  };
}

function renderFrameOptions(
  project: JoyProjectV1,
  composition: CompositionV1,
  imageSizesByObjectId?: Readonly<
    Record<string, { readonly width: number; readonly height: number }>
  >,
): BuildRenderFrameOptions {
  return {
    effectsByObjectId: buildEffectsMap(project),
    ...(project.colorGrade !== undefined ? { colorGrade: project.colorGrade } : {}),
    ...(project.transitions !== undefined ? { transitions: project.transitions } : {}),
    clipTimes: clipTimesFromTracks(composition.tracks),
    ...(imageSizesByObjectId !== undefined ? { imageSizesByObjectId } : {}),
  };
}

function buildEffectsMap(
  project: JoyProjectV1,
): Readonly<Record<string, NonNullable<VisualObjectV1['effects']>>> {
  const result: Record<string, NonNullable<VisualObjectV1['effects']>> = {};
  for (const object of Object.values(project.visualObjects)) {
    if (object.effects !== undefined && object.effects.length > 0)
      result[object.id] = object.effects;
  }
  return result;
}

function captionBurnInNodes(
  project: JoyProjectV1,
  composition: CompositionV1,
  timeUs: TimeUs,
  viewportWidth: number,
  viewportHeight: number,
): readonly TextNode[] {
  if (project.pluginData[CAPTION_BURN_IN_KEY] !== true) return [];
  const cues = captionCuesAt(composition, project.captionDocuments, timeUs);
  return layoutTemplatedCaptionNodes(cues, {
    viewportWidth,
    viewportHeight,
  }) as readonly TextNode[];
}

function appendCaptionNodes(
  nodes: readonly RenderNode[],
  captions: readonly TextNode[],
): readonly RenderNode[] {
  return [
    ...nodes,
    ...captions.map((node, index) => ({
      ...node,
      zIndex: Math.max(node.zIndex, 900 + index),
    })),
  ];
}

function plannedVideoSamples(
  project: SpikeProject,
  timeUs: TimeUs,
  transition: TransitionV1 | undefined,
): readonly PlannedVideoSample[] {
  const samples: PlannedVideoSample[] = [];
  const primary =
    activeVideoClipAt(project, timeUs) ??
    (transition !== undefined ? findVideoClipById(project, transition.leftClipId) : undefined);
  if (primary !== undefined) pushVideoSample(samples, primary, timeUs, transition, 'primary');
  if (transition !== undefined) {
    const left = findVideoClipById(project, transition.leftClipId);
    const right = findVideoClipById(project, transition.rightClipId);
    if (left !== undefined) pushVideoSample(samples, left, timeUs, transition, 'transition-left');
    if (right !== undefined)
      pushVideoSample(samples, right, timeUs, transition, 'transition-right');
  }
  return samples;
}

function pushVideoSample(
  samples: PlannedVideoSample[],
  clip: VideoClip,
  timeUs: TimeUs,
  transition: TransitionV1 | undefined,
  role: PlannedVideoSample['role'],
): void {
  if (samples.some((sample) => sample.clipId === clip.id && sample.role === role)) return;
  samples.push({
    clipId: clip.id,
    assetId: clip.assetId,
    sourceTimeUs: sourceTimeForTransitionSample(clip, timeUs, transition),
    role,
  });
}

function plannedAudioSamples(
  timelineProject: SpikeProject,
  visualProject: JoyProjectV1,
  timeUs: TimeUs,
): readonly PlannedAudioSample[] {
  const audio = visualProject.audio;
  if (audio === undefined) return [];
  return videoClipsAt(timelineProject, timeUs)
    .map((clip) => {
      const config = audio.clips[clip.id];
      if (config === undefined || config.mute) return undefined;
      return {
        clipId: clip.id,
        assetId: clip.assetId,
        sourceTimeUs: sourceTimeForTransitionSample(clip, timeUs),
        gain: config.gain,
        pan: config.pan,
      };
    })
    .filter((sample): sample is PlannedAudioSample => sample !== undefined);
}

function plannedCaptureRequirements(
  project: JoyProjectV1,
  timeUs: TimeUs,
  videoSamples: readonly PlannedVideoSample[],
  captionNodes: readonly TextNode[],
): readonly PlannedCaptureRequirement[] {
  const requirements: PlannedCaptureRequirement[] = videoSamples.map((sample) => ({
    id: `video:${sample.clipId}:${sample.role}`,
    kind: 'video-frame',
    clipId: sample.clipId,
    assetId: sample.assetId,
    sourceTimeUs: sample.sourceTimeUs,
  }));
  for (const object of Object.values(project.visualObjects)) {
    if (object.kind === 'image' && object.assetId !== undefined) {
      requirements.push({
        id: `still:${object.id}`,
        kind: 'still-bitmap',
        objectId: object.id,
        assetId: object.assetId,
      });
    }
    if (object.kind === 'html-scene' && object.scenePackageId !== undefined) {
      requirements.push({
        id: `html-scene:${object.id}`,
        kind: 'html-scene',
        objectId: object.id,
        assetId: `html-scene:${object.scenePackageId}`,
        sourceTimeUs: timeUs,
      });
    }
    if (object.kind === 'motion-scene' && object.motionSceneId !== undefined) {
      requirements.push({
        id: `motion-scene:${object.id}`,
        kind: 'motion-scene',
        objectId: object.id,
        assetId: `motion-scene:${object.motionSceneId}`,
        sourceTimeUs: timeUs,
      });
    }
  }
  if (captionNodes.length > 0) {
    requirements.push({ id: 'caption-burn-in', kind: 'caption-burn-in' });
  }
  return requirements;
}

function plannedAssetRequirements(
  assets: Readonly<Record<string, OpaqueAssetDescriptor>>,
  project: JoyProjectV1,
  videoSamples: readonly PlannedVideoSample[],
  audioSamples: readonly PlannedAudioSample[],
): readonly PlannedAssetRequirement[] {
  const requirements: PlannedAssetRequirement[] = [];
  const push = (
    assetId: string,
    kind: PlannedAssetRequirement['kind'],
    reason: PlannedAssetRequirement['reason'],
  ) => {
    if (
      requirements.some(
        (requirement) => requirement.assetId === assetId && requirement.reason === reason,
      )
    )
      return;
    const descriptor = assets[assetId];
    requirements.push({
      assetId,
      kind,
      reason,
      ...(descriptor !== undefined ? { descriptor } : {}),
    });
  };
  for (const sample of videoSamples) {
    const kind = assets[sample.assetId]?.kind ?? 'video';
    push(
      sample.assetId,
      kind,
      kind === 'motion-scene'
        ? 'motion-scene'
        : kind === 'html-scene'
          ? 'html-scene'
          : 'video-sample',
    );
  }
  for (const sample of audioSamples) push(sample.assetId, 'audio', 'audio-sample');
  for (const object of Object.values(project.visualObjects)) {
    if (object.kind === 'image' && object.assetId !== undefined) {
      push(object.assetId, 'image', 'still-bitmap');
    }
    if (object.kind === 'html-scene' && object.scenePackageId !== undefined) {
      push(`html-scene:${object.scenePackageId}`, 'html-scene', 'html-scene');
    }
    if (object.kind === 'motion-scene' && object.motionSceneId !== undefined) {
      push(`motion-scene:${object.motionSceneId}`, 'motion-scene', 'motion-scene');
    }
  }
  return requirements;
}

function mediaFindings(
  requirements: readonly PlannedAssetRequirement[],
): readonly DeterministicFinding[] {
  return requirements.flatMap((requirement): readonly DeterministicFinding[] => {
    const descriptor = requirement.descriptor;
    if (descriptor === undefined) {
      return [
        {
          code: 'missing-media',
          severity: 'error',
          refId: requirement.assetId,
          message: `Missing opaque ${requirement.kind} descriptor for ${requirement.reason}`,
        } satisfies DeterministicFinding,
      ];
    }
    if (descriptor.availability === 'missing' || descriptor.availability === 'unavailable') {
      return [
        {
          code: 'unavailable-media',
          severity: 'error',
          refId: requirement.assetId,
          message: `${descriptor.kind} descriptor "${descriptor.id}" is ${descriptor.availability}`,
        } satisfies DeterministicFinding,
      ];
    }
    return [];
  });
}

function requireVisualComposition(project: JoyProjectV1, compositionId: string): CompositionV1 {
  const composition = project.compositions[compositionId];
  if (composition === undefined) throw new Error(`unknown visual composition "${compositionId}"`);
  return composition;
}

function activeTransitionAt(
  project: JoyProjectV1,
  composition: CompositionV1,
  timeUs: TimeUs,
): TransitionV1 | undefined {
  if (project.transitions === undefined) return undefined;
  const clipTimes = clipTimesFromTracks(composition.tracks);
  return project.transitions.find((transition) =>
    isTransitionActive(transition, timeUs, clipTimes),
  );
}

function activeVideoClipAt(project: SpikeProject, timeUs: TimeUs): VideoClip | undefined {
  return videoClipsAt(project, timeUs)[0];
}

function videoClipsAt(project: SpikeProject, timeUs: TimeUs): readonly VideoClip[] {
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) return [];
  return composition.tracks
    .flatMap((track) => track.clips)
    .filter(
      (clip): clip is VideoClip =>
        clip.kind === 'video' && timeUs >= clip.startUs && timeUs < clip.startUs + clip.durationUs,
    );
}

function findVideoClipById(project: SpikeProject, clipId: string): VideoClip | undefined {
  const composition = project.compositions[project.rootCompositionId];
  const clip = composition?.tracks
    .flatMap((track) => track.clips)
    .find((item) => item.id === clipId);
  return clip?.kind === 'video' ? clip : undefined;
}

function assertFrameTime(timeUs: TimeUs): void {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
    throw new RangeError(`timeUs must be a non-negative safe integer, got ${timeUs}`);
  }
}
