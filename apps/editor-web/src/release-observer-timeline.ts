import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { EditorSession } from './editor-session.js';

export interface TimelineIntegrityProbeResult {
  readonly operations: number;
  readonly countSequence: readonly number[];
  readonly uniqueIds: boolean;
  readonly orphanReferences: number;
  readonly canonicalModelEqualAfterReload: boolean;
}

declare global {
  interface Window {
    /** Set only by the loopback release observer's Playwright context. */
    __JOY_RELEASE_OBSERVER__?: boolean;
    __JOY_RELEASE_TIMELINE_PROBE__?: () => TimelineIntegrityProbeResult;
  }
}

const PROBE_OPERATIONS = 100;
const PROBE_DURATION_US = 60_000_000;
const PROBE_CLIP_DURATION_US = 1_000_000;

/**
 * Exercises the real EditorSession command/persistence path without touching
 * the user's session. The source project supplies schema-compatible seeds;
 * all writes go to a private in-memory store.
 */
export function runReleaseObserverTimelineProbe(
  sourceTimeline: SpikeProject,
  sourceVisual: JoyProjectV1,
): TimelineIntegrityProbeResult {
  const timeline = probeTimelineSeed(sourceTimeline);
  const storage = memoryStorage();
  const session = new EditorSession(storage, timeline, structuredClone(sourceVisual));
  const target = { compositionId: timeline.rootCompositionId, trackId: 'release-observer-track' };
  const countSequence = [clipCount(session.timelineProject)];

  session.dispatchTimeline({
    label: 'Release observer duplicate A',
    commands: [
      {
        type: 'timeline.duplicateClip',
        payload: {
          ...target,
          clipId: 'release-observer-a',
          newClipId: 'release-observer-c',
          newStartUs: 2_000_000,
        },
      },
    ],
  });
  session.dispatchTimeline({
    label: 'Release observer duplicate B',
    commands: [
      {
        type: 'timeline.duplicateClip',
        payload: {
          ...target,
          clipId: 'release-observer-b',
          newClipId: 'release-observer-d',
          newStartUs: 3_000_000,
        },
      },
    ],
  });
  countSequence.push(clipCount(session.timelineProject));
  session.dispatchTimeline({
    label: 'Release observer remove',
    commands: [
      { type: 'timeline.removeClip', payload: { ...target, clipId: 'release-observer-c' } },
    ],
  });
  countSequence.push(clipCount(session.timelineProject));
  session.dispatchTimeline({
    label: 'Release observer duplicate C',
    commands: [
      {
        type: 'timeline.duplicateClip',
        payload: {
          ...target,
          clipId: 'release-observer-d',
          newClipId: 'release-observer-e',
          newStartUs: 4_000_000,
        },
      },
    ],
  });
  countSequence.push(clipCount(session.timelineProject));

  const remaining = PROBE_OPERATIONS - 4;
  for (let index = 0; index < remaining; index += 1) {
    session.dispatchTimeline({
      label: `Release observer invariant ${index + 1}`,
      commands: [
        {
          type: 'property.setTrackEnabled',
          payload: { ...target, enabled: index % 2 === 0 },
        },
      ],
    });
  }
  const finalModel = structuredClone(session.timelineProject);
  session.undo();
  session.redo();
  const undoRedoExact = JSON.stringify(session.timelineProject) === JSON.stringify(finalModel);
  const reopened = new EditorSession(storage, timeline, structuredClone(sourceVisual));
  const canonicalModelEqualAfterReload =
    undoRedoExact && JSON.stringify(reopened.timelineProject) === JSON.stringify(finalModel);
  const clips = allClips(reopened.timelineProject);
  const ids = clips.map((clip) => clip.id);
  return {
    operations: PROBE_OPERATIONS,
    countSequence,
    uniqueIds: new Set(ids).size === ids.length,
    orphanReferences: clips.filter(
      (clip) =>
        clip.kind === 'composition' &&
        reopened.timelineProject.compositions[clip.compositionId] === undefined,
    ).length,
    canonicalModelEqualAfterReload,
  };
}

function probeTimelineSeed(source: SpikeProject): SpikeProject {
  const composition = source.compositions[source.rootCompositionId];
  if (composition === undefined) throw new Error('release observer requires a root composition');
  const track: SpikeProject['compositions'][string]['tracks'][number] = {
    id: 'release-observer-track',
    kind: 'video',
    name: 'Release observer',
    order: 0,
    enabled: true,
    muted: false,
    locked: false,
    clips: [
      probeClip('release-observer-a', 0),
      probeClip('release-observer-b', PROBE_CLIP_DURATION_US),
    ],
  };
  return {
    ...structuredClone(source),
    id: 'release-observer-timeline',
    compositions: {
      [source.rootCompositionId]: {
        ...structuredClone(composition),
        durationUs: PROBE_DURATION_US,
        tracks: [track],
      },
    },
  };
}

function probeClip(
  id: string,
  startUs: number,
): SpikeProject['compositions'][string]['tracks'][number]['clips'][number] {
  return {
    id,
    kind: 'video',
    assetId: `asset-${id}`,
    startUs,
    durationUs: PROBE_CLIP_DURATION_US,
    sourceInUs: 0,
    playbackRate: 1,
    reversed: false,
  };
}

function allClips(project: SpikeProject) {
  return Object.values(project.compositions).flatMap((composition) =>
    composition.tracks.flatMap((track) => track.clips),
  );
}

function clipCount(project: SpikeProject): number {
  return allClips(project).length;
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}
