import type { CommandTransaction } from '@joy-media/commands';
import type {
  EffectParamValue,
  JoyProjectV1,
  SpikeProject,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { bindClipToObject } from './sticker-bindings.js';
import {
  isAdjustmentTargetKind,
  readTimelineElementKindMap,
  timelineElementKindForClip,
  withEffectLayerTarget,
  withTimelineElementKinds,
} from './timeline-element-kind.js';

export interface AdjustmentLayerInsertion {
  readonly label: string;
  readonly clipId: string;
  readonly objectId: string;
  readonly timeline: CommandTransaction;
  readonly project: JoyProjectV1;
}

export type TreatmentLayerKind = 'effect' | 'filter' | 'adjust';

const TREATMENT_LAYER_SPEC: Readonly<
  Record<
    TreatmentLayerKind,
    {
      readonly name: string;
      readonly assetId: string;
      readonly effects: readonly {
        readonly suffix: string;
        readonly effectId: string;
        readonly params: Readonly<Record<string, EffectParamValue>>;
      }[];
    }
  >
> = {
  effect: {
    name: 'Effects',
    assetId: 'joy-effect-layer',
    effects: [{ suffix: 'glow', effectId: 'glow', params: { strength: 0.25, radius: 8 } }],
  },
  filter: {
    name: 'Filters',
    assetId: 'joy-filter-layer',
    effects: [
      {
        suffix: 'hue-saturation',
        effectId: 'hue-saturation',
        params: { hue: 0, saturation: 0 },
      },
    ],
  },
  adjust: {
    name: 'Adjust',
    assetId: 'joy-adjustment-layer',
    effects: [
      {
        suffix: 'brightness-contrast',
        effectId: 'brightness-contrast',
        params: { brightness: 0, contrast: 0 },
      },
      {
        suffix: 'hue-saturation',
        effectId: 'hue-saturation',
        params: { hue: 0, saturation: 0 },
      },
      { suffix: 'vibrance', effectId: 'vibrance', params: { amount: 0 } },
    ],
  },
};

/** Build one undoable AE-style controller layer without mutating either input. */
export function buildAdjustmentLayerInsertion({
  timeline,
  project,
  targetClipId,
  token,
}: {
  readonly timeline: SpikeProject;
  readonly project: JoyProjectV1;
  readonly targetClipId: string;
  readonly token: string;
}): AdjustmentLayerInsertion {
  return buildTreatmentLayerInsertion({ timeline, project, targetClipId, token, kind: 'adjust' });
}

/** Build one undoable, parented Effects / Filters / Adjust controller layer. */
export function buildTreatmentLayerInsertion({
  timeline,
  project,
  targetClipId,
  token,
  kind,
}: {
  readonly timeline: SpikeProject;
  readonly project: JoyProjectV1;
  readonly targetClipId: string;
  readonly token: string;
  readonly kind: TreatmentLayerKind;
}): AdjustmentLayerInsertion {
  const composition = timeline.compositions[timeline.rootCompositionId];
  if (composition === undefined) throw new Error('The main timeline is unavailable.');
  const target = composition.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === targetClipId);
  if (target === undefined) {
    throw new Error('Adjust layers can currently target media in the main timeline.');
  }
  const targetKind = timelineElementKindForClip(target, readTimelineElementKindMap(project));
  if (!isAdjustmentTargetKind(targetKind)) {
    throw new Error(
      `Select a video or picture element before adding ${TREATMENT_LAYER_SPEC[kind].name}.`,
    );
  }

  const spec = TREATMENT_LAYER_SPEC[kind];
  const clipId = `${kind}-${token}`;
  const objectId = `${kind}-controller-${token}`;
  const trackId = `${spec.name}-${token}`;
  const assetId = spec.assetId;
  const order = composition.tracks.reduce((max, track) => Math.max(max, track.order), -1) + 1;
  const label = `Add ${spec.name} layer`;
  const nextObject: VisualObjectV1 = {
    id: objectId,
    kind: 'null',
    assetId,
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
    effects: spec.effects.map((effect) => ({
      id: `${objectId}-${effect.suffix}`,
      effectId: effect.effectId,
      enabled: true,
      params: effect.params,
    })),
  };
  const withObject: JoyProjectV1 = {
    ...project,
    updatedAt: new Date().toISOString(),
    assets: {
      ...project.assets,
      [assetId]: project.assets[assetId] ?? {
        id: assetId,
        kind: 'other',
        displayName: spec.name,
      },
    },
    visualObjects: { ...project.visualObjects, [objectId]: nextObject },
  };
  const nextProject = withEffectLayerTarget(
    withTimelineElementKinds(bindClipToObject(withObject, clipId, objectId), {
      [clipId]: kind,
    }),
    objectId,
    targetClipId,
  );
  return {
    label,
    clipId,
    objectId,
    timeline: {
      label,
      commands: [
        {
          type: 'timeline.addTrack',
          payload: {
            compositionId: composition.id,
            track: {
              id: trackId,
              kind: 'video',
              order,
              enabled: true,
              clips: [],
            },
          },
        },
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: composition.id,
            trackId,
            clip: {
              id: clipId,
              kind: 'video',
              assetId,
              startUs: target.startUs,
              durationUs: target.durationUs,
              sourceInUs: 0,
            },
          },
        },
      ],
    },
    project: nextProject,
  };
}
