import type { SpikeProject } from './model.js';
import { validateSpikeProject } from './model.js';
import {
  emptyLookInstancesDocument,
  validateLookInstancesDocument,
} from './look-instances-document.js';
import type { LookInstancesDocument } from './look-instances-document.js';
import { validateJoyProjectV1 } from './v1.js';
import type { JoyProjectV1 } from './v1.js';
import type { ClipV1 } from './v1.js';
import type { NormalizedUniversalTimelineItem } from './universal-timeline.js';
import { normalizeUniversalTimeline } from './universal-timeline.js';
import { validateJoyProjectV3 } from './v3.js';
import type { JoyProjectV3 } from './v3.js';

export class DesktopProjectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopProjectionError';
  }
}

function assertValid(diagnostics: readonly { code: string; path: string }[], code: string): void {
  if (diagnostics.length)
    throw new DesktopProjectionError(
      code,
      diagnostics.map((d) => `${d.code} at ${d.path}`).join('; '),
    );
}

export function projectV3ToDesktopVisual(project: JoyProjectV3): JoyProjectV1 {
  const value = project as unknown as Record<string, unknown>;
  const unmappedFields = [
    ['artifacts', 'DESKTOP_PROJECTION_UNMAPPED_ARTIFACTS'],
    ['artifactVersions', 'DESKTOP_PROJECTION_UNMAPPED_ARTIFACT_VERSIONS'],
    ['workflow', 'DESKTOP_PROJECTION_UNMAPPED_WORKFLOW'],
    ['lookInstances', 'DESKTOP_PROJECTION_UNMAPPED_LOOK_INSTANCES'],
  ] as const;
  for (const [key, code] of unmappedFields) {
    const field = value[key];
    if (field !== undefined && isNonEmptyRecord(field))
      throw new DesktopProjectionError(code, `${key} content is not mapped to the desktop format`);
  }
  assertValid(validateJoyProjectV3(project), 'DESKTOP_PROJECTION_INVALID_INPUT');
  const {
    artifacts: _artifacts,
    artifactVersions: _versions,
    workflow: _workflow,
    lookInstances: _looks,
    ...body
  } = value;
  const visual = structuredClone({ ...body, schemaVersion: 1 }) as unknown as JoyProjectV1;
  assertValid(validateJoyProjectV1(visual), 'DESKTOP_PROJECTION_INVALID_OUTPUT');
  return visual;
}

/** Schema-0 desktop timeline wrapper keeps source identity and bindings explicit. */
export interface DesktopTimelineSchema0 {
  readonly schemaVersion: 0;
  readonly project: SpikeProject;
  readonly universalTimeline: {
    readonly schemaVersion: NonNullable<JoyProjectV3['universalTimeline']>['schemaVersion'];
    readonly items: readonly NormalizedUniversalTimelineItem[];
  };
  readonly audioBindings: readonly NormalizedUniversalTimelineItem[];
  readonly captionBindings: readonly NormalizedUniversalTimelineItem[];
  readonly clipBindings: readonly {
    readonly compositionId: string;
    readonly trackId: string;
    readonly clip: ClipV1;
    readonly sourceBinding?: NormalizedUniversalTimelineItem;
  }[];
  readonly visualTrackKinds: Readonly<Record<string, string>>;
}

export function projectV3ToDesktopDocuments(project: JoyProjectV3): {
  visual: JoyProjectV1;
  timeline: DesktopTimelineSchema0;
  lookInstances: LookInstancesDocument;
} {
  const visual = projectV3ToDesktopVisual(project);
  const comps: Record<string, SpikeProject['compositions'][string]> = {};
  const visualTrackKinds: Record<string, string> = {};
  const normalizedTimeline = normalizeUniversalTimeline(visual);
  const timelineItems = structuredClone(normalizedTimeline.items);
  const clipBindings = Object.values(visual.compositions).flatMap((composition) =>
    composition.tracks.flatMap((track) =>
      track.clips.map((clip) => {
        const sourceBinding = timelineItems.find((item) => item.id === clip.id);
        return {
          compositionId: composition.id,
          trackId: track.id,
          clip: structuredClone(clip),
          ...(sourceBinding === undefined ? {} : { sourceBinding }),
        };
      }),
    ),
  );
  for (const composition of Object.values(visual.compositions)) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        const clipFields = clip as unknown as Record<string, unknown>;
        if (clip.kind === 'video' && clipFields.timeRemap !== undefined)
          throw new DesktopProjectionError(
            'DESKTOP_PROJECTION_UNMAPPED_CLIP_TIME_REMAP',
            `Clip ${clip.id} uses timeRemap, which has no schema-0 equivalent`,
          );
      }
    }
    comps[composition.id] = {
      id: composition.id,
      name: composition.name,
      width: composition.width,
      height: composition.height,
      frameRate: composition.frameRate,
      durationUs: composition.durationUs,
      tracks: composition.tracks
        .filter((track) => track.kind === 'video')
        .map((track) => {
          visualTrackKinds[track.id] = track.kind;
          return {
            id: track.id,
            kind: 'video' as const,
            ...(track.family === undefined ? {} : { family: track.family }),
            name: track.name,
            order: track.order,
            enabled: track.enabled,
            clips: track.clips
              .filter((clip) => clip.kind === 'video' || clip.kind === 'composition')
              .map((clip) =>
                clip.kind === 'video'
                  ? {
                      id: clip.id,
                      kind: 'video' as const,
                      startUs: clip.startUs,
                      durationUs: clip.durationUs,
                      assetId: clip.assetId,
                      sourceInUs: clip.sourceInUs,
                      ...(clip.playbackRate === undefined
                        ? {}
                        : { playbackRate: clip.playbackRate }),
                      ...(clip.reversed === undefined ? {} : { reversed: clip.reversed }),
                    }
                  : {
                      id: clip.id,
                      kind: 'composition' as const,
                      startUs: clip.startUs,
                      durationUs: clip.durationUs,
                      compositionId: clip.compositionId,
                      childOffsetUs: clip.childOffsetUs,
                    },
              ),
          };
        }),
    };
  }
  const timeline: DesktopTimelineSchema0 = {
    schemaVersion: 0,
    project: structuredClone({
      schemaVersion: 0,
      id: visual.id,
      rootCompositionId: visual.rootCompositionId,
      compositions: comps,
    }),
    universalTimeline: structuredClone({
      schemaVersion: normalizedTimeline.document.schemaVersion,
      items: timelineItems,
    }),
    audioBindings: timelineItems.filter((item) => item.elementKind === 'audio'),
    captionBindings: timelineItems.filter((item) => item.elementKind === 'caption'),
    clipBindings,
    visualTrackKinds,
  };
  assertValid(validateSpikeProject(timeline.project), 'DESKTOP_PROJECTION_INVALID_TIMELINE');
  const lookInstances = emptyLookInstancesDocument(`${visual.id}-looks`);
  assertValid(validateLookInstancesDocument(lookInstances), 'DESKTOP_PROJECTION_INVALID_LOOKS');
  return { visual, timeline, lookInstances };
}

function isNonEmptyRecord(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}
