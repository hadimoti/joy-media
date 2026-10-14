import { randomBytes } from 'node:crypto';
import type { CliFlags } from '../cli.js';
import { FlagValidationError, NUMERIC_RANGES } from '../utils/flags.js';
import { c, logSuccess } from '../utils/logger.js';
import {
  CommandFailure,
  emitJson,
  loadProject,
  locateProject,
  reportFailure,
  saveProject,
  usageFailure,
  withExclusiveLock,
} from '../utils/project-loader.js';

export interface TimelineCommandFlags {
  project?: string | undefined;
  track?: string | undefined;
  clip?: string | undefined;
  asset?: string | undefined;
  start?: number | undefined;
  duration?: number | undefined;
  end?: number | undefined;
  at?: number | undefined;
  sqlitePath?: string | undefined;
}

interface TimelineClip {
  id: string;
  startUs: number;
  durationUs: number;
  [key: string]: unknown;
}

interface TimelineTrack {
  id: string;
  name?: string;
  clips: TimelineClip[];
}

type Subcommand = 'add-clip' | 'split' | 'trim' | 'remove-clip';
type ClipFlag = 'track' | 'clip' | 'asset' | 'start' | 'duration' | 'end' | 'at';

/** The only flags each subcommand understands. Anything else is a mistake, not a hint. */
const ACCEPTED_FLAGS: Record<Subcommand, readonly ClipFlag[]> = {
  'add-clip': ['track', 'start', 'duration', 'asset'],
  split: ['clip', 'at', 'track'],
  trim: ['clip', 'start', 'end', 'duration', 'track'],
  'remove-clip': ['clip', 'track'],
};

const SUBCOMMANDS = Object.keys(ACCEPTED_FLAGS) as Subcommand[];

/** What one operation did to the (cloned) project, and how to describe it. */
interface Outcome {
  readonly changed: boolean;
  readonly human: (revision: number) => string;
  readonly doc: (revision: number) => Record<string, unknown>;
}

/**
 * `joy-media timeline <add-clip|split|trim|remove-clip> --project <id|file.json> ...`.
 *
 * Exit codes: 0 done; 1 the edit could not be applied to this project (unknown
 * project/track/clip, split point outside the clip, overlap, concurrent change);
 * 2 the command line is wrong. A failed command never writes anything. With
 * `--json` stdout is exactly one JSON document (errors:
 * `{"type":"error","code","message"}`).
 */
export async function handleTimelineCommand(args: string[], flags: CliFlags): Promise<number> {
  const json = Boolean(flags.json);
  try {
    validateRange(flags.start, NUMERIC_RANGES.start, 'start');
    validateRange(flags.duration, NUMERIC_RANGES.duration, 'duration');
    validateRange(flags.end, NUMERIC_RANGES.end, 'end');
    validateRange(flags.at, NUMERIC_RANGES.at, 'at');

    const sub = args[0];
    if (sub === undefined) {
      throw usageFailure(`Missing timeline subcommand. Available: ${SUBCOMMANDS.join(', ')}.`);
    }
    if (!SUBCOMMANDS.includes(sub as Subcommand)) {
      throw usageFailure(
        `Unknown timeline subcommand: ${sub}. Available: ${SUBCOMMANDS.join(', ')}.`,
      );
    }
    if (args.length > 1) {
      throw usageFailure(`Unexpected extra argument "${args[1]}". Pass options as --flags.`);
    }
    if (!flags.project) {
      throw usageFailure('Please specify target project via --project <id|file.json>');
    }
    const subcommand = sub as Subcommand;
    checkFlags(subcommand, flags);

    const project = flags.project;
    const location = locateProject(project, flags.sqlitePath);

    // One process at a time per project store: read-modify-write must not interleave
    // with another `timeline` call (an agent fanning out edits), or edits get lost.
    const { revision, outcome, projectId } = withExclusiveLock(location.path, () => {
      const info = loadProject(project, flags.sqlitePath);
      const edited = structuredClone(info.project);
      const root = edited.compositions[edited.rootCompositionId];
      if (!root || !Array.isArray(root.tracks)) {
        throw new CommandFailure('PROJECT_FILE_INVALID', 'Project has no root composition.');
      }
      const tracks = root.tracks as unknown as TimelineTrack[];

      const result = apply(subcommand, tracks, flags);
      const saved = result.changed
        ? saveProject(edited, {
            source: info.source,
            path: info.path,
            revision: info.revision,
          })
        : info.revision;
      return { revision: saved, outcome: result, projectId: edited.id };
    });

    if (json) {
      emitJson({ projectId, revision, changed: outcome.changed, ...outcome.doc(revision) });
    } else {
      logSuccess(outcome.human(revision));
    }
    return 0;
  } catch (err) {
    return reportFailure(err, json, 'timeline');
  }
}

function checkFlags(sub: Subcommand, flags: CliFlags): void {
  const given: Record<ClipFlag, unknown> = {
    track: flags.track,
    clip: flags.clip,
    asset: flags.asset,
    start: flags.start,
    duration: flags.duration,
    end: flags.end,
    at: flags.at,
  };
  const accepted = ACCEPTED_FLAGS[sub];
  for (const [name, value] of Object.entries(given)) {
    if (value !== undefined && !accepted.includes(name as ClipFlag)) {
      throw usageFailure(
        `timeline ${sub} does not accept --${name}. It takes: ${accepted.map((f) => `--${f}`).join(', ')}.`,
      );
    }
  }

  if (sub === 'split' && (flags.clip === undefined || flags.at === undefined)) {
    throw usageFailure(
      'Usage: joy-media timeline split --project <id> --clip <clipId> --at <seconds>',
    );
  }
  if (sub === 'trim') {
    if (flags.clip === undefined) {
      throw usageFailure(
        'Usage: joy-media timeline trim --project <id> --clip <clipId> [--start <sec>] [--end <sec>]',
      );
    }
    if (flags.start === undefined && flags.end === undefined && flags.duration === undefined) {
      throw usageFailure(
        'Nothing to trim: give at least one of --start, --end or --duration. ' +
          'Usage: joy-media timeline trim --project <id> --clip <clipId> [--start <sec>] [--end <sec>]',
      );
    }
    if (flags.end !== undefined && flags.duration !== undefined) {
      throw usageFailure('Use either --end or --duration with trim, not both.');
    }
    if (flags.start !== undefined && flags.end !== undefined && flags.end <= flags.start) {
      throw usageFailure(
        `Invalid trim range: --end (${flags.end}s) must be greater than --start (${flags.start}s).`,
      );
    }
  }
  if (sub === 'remove-clip' && flags.clip === undefined) {
    throw usageFailure('Usage: joy-media timeline remove-clip --project <id> --clip <clipId>');
  }
}

function apply(sub: Subcommand, tracks: TimelineTrack[], flags: CliFlags): Outcome {
  switch (sub) {
    case 'add-clip':
      return addClip(tracks, flags);
    case 'split':
      return splitClip(tracks, flags);
    case 'trim':
      return trimClip(tracks, flags);
    case 'remove-clip':
      return removeClip(tracks, flags);
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const toUs = (seconds: number): number => Math.round(seconds * 1_000_000);
const fmt = (us: number): string => `${us / 1_000_000}s`;

function describeClip(clip: TimelineClip): Record<string, unknown> {
  return {
    id: clip.id,
    assetId: clip.assetId ?? null,
    startUs: clip.startUs,
    durationUs: clip.durationUs,
    endUs: clip.startUs + clip.durationUs,
    sourceInUs: typeof clip.sourceInUs === 'number' ? clip.sourceInUs : null,
  };
}

function trackLabel(track: TimelineTrack): string {
  return track.name ?? track.id;
}

function requireTrack(tracks: TimelineTrack[], trackId: string): TimelineTrack {
  const track = tracks.find((t) => t.id === trackId);
  if (!track) {
    throw new CommandFailure(
      'TRACK_NOT_FOUND',
      `Track "${trackId}" not found. Tracks in this project: ${tracks.map((t) => t.id).join(', ') || '(none)'}.`,
    );
  }
  return track;
}

function findOverlap(
  track: TimelineTrack,
  startUs: number,
  durationUs: number,
  ignoreClipId?: string,
): TimelineClip | undefined {
  const endUs = startUs + durationUs;
  return track.clips.find(
    (other) =>
      other.id !== ignoreClipId &&
      startUs < other.startUs + other.durationUs &&
      other.startUs < endUs,
  );
}

function assertNoOverlap(
  track: TimelineTrack,
  startUs: number,
  durationUs: number,
  ignoreClipId?: string,
): void {
  const other = findOverlap(track, startUs, durationUs, ignoreClipId);
  if (!other) return;
  throw new CommandFailure(
    'CLIP_OVERLAP',
    `The clip would span ${fmt(startUs)} to ${fmt(startUs + durationUs)} on track "${trackLabel(track)}", ` +
      `which overlaps clip "${other.id}" (${fmt(other.startUs)} to ${fmt(other.startUs + other.durationUs)}). ` +
      `Choose another --start (for example ${fmt(other.startUs + other.durationUs)}) or another --track.`,
  );
}

/** Find a clip by id; `--track`, when given, scopes the search and must exist. */
function locateClip(
  tracks: TimelineTrack[],
  clipId: string,
  trackId: string | undefined,
): { track: TimelineTrack; index: number; clip: TimelineClip } {
  const scope = trackId === undefined ? tracks : [requireTrack(tracks, trackId)];
  for (const track of scope) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    if (index !== -1) return { track, index, clip: track.clips[index]! };
  }
  const elsewhere =
    trackId === undefined ? undefined : tracks.find((t) => t.clips.some((k) => k.id === clipId));
  if (elsewhere) {
    throw new CommandFailure(
      'CLIP_NOT_FOUND',
      `Clip "${clipId}" is not on track "${trackId}" (it is on track "${elsewhere.id}").`,
    );
  }
  const known = tracks.flatMap((t) => t.clips.map((k) => k.id));
  throw new CommandFailure(
    'CLIP_NOT_FOUND',
    `Clip "${clipId}" not found. ` +
      (known.length > 0
        ? `Clips in this project: ${known.slice(0, 10).join(', ')}${known.length > 10 ? ', ...' : ''}.`
        : 'This project has no clips yet.'),
  );
}

function uniqueClipId(tracks: TimelineTrack[]): string {
  const used = new Set(tracks.flatMap((t) => t.clips.map((k) => k.id)));
  for (;;) {
    const id = `clip-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    if (!used.has(id)) return id;
  }
}

function addClip(tracks: TimelineTrack[], flags: CliFlags): Outcome {
  const trackId = flags.track ?? tracks[0]?.id;
  if (!trackId) throw new CommandFailure('TRACK_NOT_FOUND', 'No tracks available in project.');
  const track = requireTrack(tracks, trackId);

  const startUs = toUs(flags.start ?? 0);
  const durationUs = toUs(flags.duration ?? 3);
  assertNoOverlap(track, startUs, durationUs);

  const clip: TimelineClip = {
    id: uniqueClipId(tracks),
    kind: 'video',
    assetId: flags.asset ?? 'asset-default',
    startUs,
    durationUs,
    sourceInUs: 0,
  };
  track.clips.push(clip);

  return {
    changed: true,
    human: (rev) =>
      `Added clip ${c(clip.id, 'bold')} to track ${c(trackLabel(track), 'cyan')} (saved rev ${rev}).`,
    doc: () => ({ trackId: track.id, clip: describeClip(clip) }),
  };
}

/** Source position of the second half of a split: the same frame the timeline already shows there. */
function advanceSource(clip: TimelineClip, deltaUs: number): TimelineClip {
  if (clip.kind === 'composition' && typeof clip.childOffsetUs === 'number') {
    return { ...clip, childOffsetUs: clip.childOffsetUs + deltaUs };
  }
  if (typeof clip.sourceInUs === 'number') {
    const rate = typeof clip.playbackRate === 'number' ? clip.playbackRate : 1;
    const direction = clip.reversed === true ? -1 : 1;
    const sourceInUs = clip.sourceInUs + Math.round(deltaUs * rate) * direction;
    if (sourceInUs < 0) {
      throw new CommandFailure(
        'SOURCE_UNDERFLOW',
        `Splitting "${clip.id}" there would move the source in-point below 0.`,
      );
    }
    return { ...clip, sourceInUs };
  }
  return { ...clip };
}

function splitClip(tracks: TimelineTrack[], flags: CliFlags): Outcome {
  const clipId = flags.clip!;
  const { track, index, clip } = locateClip(tracks, clipId, flags.track);

  const atUs = toUs(flags.at!);
  const endUs = clip.startUs + clip.durationUs;
  if (atUs <= clip.startUs || atUs >= endUs) {
    throw new CommandFailure(
      'RANGE_ERROR',
      `Split point ${flags.at}s is outside clip range [${clip.startUs / 1_000_000}s, ${endUs / 1_000_000}s] ` +
        '(it must fall strictly inside the clip).',
    );
  }

  // Ids stay unique even when a clip is split again: "<id>-p2", "<id>-p3", ...
  const used = new Set(tracks.flatMap((t) => t.clips.map((k) => k.id)));
  let part = 2;
  while (used.has(`${clip.id}-p${part}`)) part += 1;

  const localUs = atUs - clip.startUs;
  const second: TimelineClip = {
    ...advanceSource(clip, localUs),
    id: `${clip.id}-p${part}`,
    startUs: atUs,
    durationUs: endUs - atUs,
  };
  clip.durationUs = localUs;
  track.clips.splice(index + 1, 0, second);

  return {
    changed: true,
    human: (rev) => `Split clip ${c(clipId, 'bold')} at ${flags.at}s (saved rev ${rev}).`,
    doc: () => ({
      trackId: track.id,
      atUs,
      clips: [describeClip(clip), describeClip(second)],
    }),
  };
}

function trimClip(tracks: TimelineTrack[], flags: CliFlags): Outcome {
  const clipId = flags.clip!;
  const { track, clip } = locateClip(tracks, clipId, flags.track);

  const newStartUs = flags.start !== undefined ? toUs(flags.start) : clip.startUs;
  let newDurationUs = clip.durationUs;
  if (flags.end !== undefined) {
    const endUs = toUs(flags.end);
    if (endUs <= newStartUs) {
      throw new CommandFailure(
        'RANGE_ERROR',
        `--end (${flags.end}s) must be after the clip start (${fmt(newStartUs)}); the clip was left unchanged.`,
      );
    }
    newDurationUs = endUs - newStartUs;
  } else if (flags.duration !== undefined) {
    newDurationUs = toUs(flags.duration);
  }

  const before = describeClip(clip);
  if (newStartUs === clip.startUs && newDurationUs === clip.durationUs) {
    return {
      changed: false,
      human: () =>
        `Clip ${c(clipId, 'bold')} already spans ${fmt(clip.startUs)} to ${fmt(clip.startUs + clip.durationUs)}; nothing to change.`,
      doc: () => ({ trackId: track.id, clip: before }),
    };
  }

  assertNoOverlap(track, newStartUs, newDurationUs, clip.id);
  clip.startUs = newStartUs;
  clip.durationUs = newDurationUs;

  return {
    changed: true,
    human: (rev) => `Trimmed clip ${c(clipId, 'bold')} (saved rev ${rev}).`,
    doc: () => ({ trackId: track.id, clip: describeClip(clip) }),
  };
}

function removeClip(tracks: TimelineTrack[], flags: CliFlags): Outcome {
  const clipId = flags.clip!;
  const { track, index, clip } = locateClip(tracks, clipId, flags.track);
  track.clips.splice(index, 1);

  return {
    changed: true,
    human: (rev) => `Removed clip ${c(clipId, 'bold')} (saved rev ${rev}).`,
    doc: () => ({ trackId: track.id, removed: describeClip(clip) }),
  };
}

function validateRange(
  value: number | undefined,
  range: { min: number; max: number },
  flag: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value)) {
    throw new FlagValidationError(flag, 'value is not a finite number', value);
  }
  if (value < range.min) {
    throw new FlagValidationError(flag, `value must be >= ${range.min}`, value);
  }
  if (value > range.max) {
    throw new FlagValidationError(flag, `value must be <= ${range.max}`, value);
  }
}
