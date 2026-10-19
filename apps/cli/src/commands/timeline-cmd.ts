import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { CliFlags } from '../cli.js';
import { deriveAssetId, registerAssetSource } from '../utils/asset-sources.js';
import { FlagValidationError, NUMERIC_RANGES } from '../utils/flags.js';
import { c, logSuccess } from '../utils/logger.js';
import { isMediaFileName, probeMedia } from '../utils/media-probe.js';
import { isTitleManagedClip } from '../services/prepared-title.js';
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

/** The parts of a project that timeline edits read and write. */
interface TimelineProject {
  assets?: Record<string, unknown>;
  audio?: unknown;
  captionDocuments?: Record<string, unknown>;
  rootCompositionId?: string;
  compositions?: Record<string, unknown>;
  pluginData?: unknown;
}

interface TimelineTrack {
  id: string;
  name?: string;
  family?: string;
  kind?: string;
  order?: number;
  enabled?: boolean;
  locked?: boolean;
  clips: TimelineClip[];
}

type Subcommand =
  | 'add-clip'
  | 'split'
  | 'trim'
  | 'remove-clip'
  | 'add-track'
  | 'move'
  | 'set-audio'
  | 'add-transition'
  | 'add-caption';
type ClipFlag =
  | 'text'
  | 'language'
  | 'direction'
  | 'track'
  | 'clip'
  | 'asset'
  | 'start'
  | 'duration'
  | 'end'
  | 'at'
  | 'family'
  | 'name'
  | 'gain'
  | 'mute'
  | 'unmute'
  | 'fadeIn'
  | 'fadeOut'
  | 'left'
  | 'right'
  | 'type';

/** The only flags each subcommand understands. Anything else is a mistake, not a hint. */
const ACCEPTED_FLAGS: Record<Subcommand, readonly ClipFlag[]> = {
  'add-clip': ['track', 'start', 'duration', 'asset'],
  split: ['clip', 'at', 'track'],
  trim: ['clip', 'start', 'end', 'duration', 'track'],
  'remove-clip': ['clip', 'track'],
  'add-track': ['family', 'name'],
  move: ['clip', 'start', 'track'],
  'set-audio': ['clip', 'gain', 'mute', 'unmute', 'fadeIn', 'fadeOut'],
  'add-transition': ['left', 'right', 'duration', 'type'],
  'add-caption': ['track', 'start', 'duration', 'text', 'language', 'direction'],
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

      const media = subcommand === 'add-clip' ? registerRealMedia(edited, flags) : undefined;
      const result = apply(subcommand, tracks, media?.flags ?? flags, edited);
      // Registered before the save: a failed registry write then leaves no clip behind, and
      // an unreferenced registry entry is harmless. A rejected edit never reaches this line.
      if (result.changed) media?.register();
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

/**
 * `add-clip --asset <file>` with a real media file: register the file as an asset (so the project
 * knows its kind and length), remember where it lives on this machine (so `render` can find it),
 * and default the clip length to the whole file. A plain label such as `intro` is left alone.
 */
interface RegisteredMedia {
  readonly flags: CliFlags;
  /** Records where the file lives on this machine; call only after the project is saved. */
  readonly register: () => void;
}

function registerRealMedia(
  project: { assets?: Record<string, unknown> },
  flags: CliFlags,
): RegisteredMedia {
  const noRegistration = { flags, register: (): void => undefined };
  if (!flags.asset) return noRegistration;
  // An asset id the project already knows is a reference, not a path on this machine.
  if (project.assets?.[flags.asset] !== undefined) return noRegistration;
  const absolute = resolve(flags.asset);
  let size: number | undefined;
  try {
    const stats = statSync(absolute);
    if (stats.isFile()) size = stats.size;
  } catch {
    size = undefined;
  }
  if (size === undefined) {
    if (looksLikeMediaPath(flags.asset)) {
      throw new CommandFailure(
        'MEDIA_NOT_FOUND',
        `No media file at "${absolute}". Check the path, or pass a plain label (for example "intro") if you meant a name rather than a file.`,
      );
    }
    return noRegistration;
  }
  const info = probeMedia(absolute);
  if (!info) {
    throw new CommandFailure(
      'MEDIA_UNREADABLE',
      `"${flags.asset}" is not media ffprobe can read. Install ffmpeg (or set JOY_MEDIA_FFPROBE), or pass a plain label instead of a file path.`,
    );
  }
  const assetId = deriveAssetId(absolute);
  const assets = (project.assets ??= {});
  assets[assetId] = {
    id: assetId,
    kind: info.isImage ? 'image' : info.hasVideo ? 'video' : 'audio',
    displayName: basename(absolute),
    bytes: size,
    descriptor: {
      mimeType: info.mimeType,
      ...(info.durationUs > 0 ? { durationUs: info.durationUs } : {}),
      ...(info.width !== undefined ? { width: info.width } : {}),
      ...(info.height !== undefined ? { height: info.height } : {}),
    },
  };
  const wholeFile = info.isImage || info.durationUs <= 0 ? undefined : info.durationUs / 1_000_000;
  return {
    flags: { ...flags, asset: assetId, duration: flags.duration ?? wholeFile },
    register: () => registerAssetSource(assetId, absolute),
  };
}

function checkFlags(sub: Subcommand, flags: CliFlags): void {
  if (flags.allowExtend && sub !== 'add-clip') {
    throw usageFailure(
      `timeline ${sub} does not accept --allow-extend. It only applies to add-clip.`,
    );
  }
  const given: Record<ClipFlag, unknown> = {
    track: flags.track,
    clip: flags.clip,
    asset: flags.asset,
    start: flags.start,
    duration: flags.duration,
    end: flags.end,
    at: flags.at,
    family: flags.family,
    name: flags.name,
    gain: flags.gain,
    mute: flags.mute ? true : undefined,
    unmute: flags.unmute ? true : undefined,
    fadeIn: flags.fadeIn,
    fadeOut: flags.fadeOut,
    left: flags.left,
    right: flags.right,
    type: flags.type,
    text: flags.text,
    language: flags.language,
    direction: flags.direction,
  };
  const accepted = ACCEPTED_FLAGS[sub];
  for (const [name, value] of Object.entries(given)) {
    if (value !== undefined && !accepted.includes(name as ClipFlag)) {
      throw usageFailure(
        `timeline ${sub} does not accept --${name}. It takes: ${accepted.map((f) => `--${f}`).join(', ')}.`,
      );
    }
  }

  if (sub === 'move' && flags.clip === undefined) {
    throw usageFailure(
      'Usage: joy-media timeline move --project <id> --clip <clipId> [--start <seconds>] [--track <id>]',
    );
  }
  if (sub === 'set-audio') {
    if (flags.clip === undefined) {
      throw usageFailure(
        'Usage: joy-media timeline set-audio --project <id> --clip <clipId> [--gain <n>] [--mute|--unmute] [--fade-in <s>] [--fade-out <s>]',
      );
    }
    if (flags.mute && flags.unmute) {
      throw usageFailure('Use either --mute or --unmute, not both.');
    }
    const settings = [flags.gain, flags.fadeIn, flags.fadeOut, flags.mute, flags.unmute];
    if (settings.every((value) => value === undefined || value === false)) {
      throw usageFailure(
        'Nothing to set: give at least one of --gain, --mute, --unmute, --fade-in, --fade-out.',
      );
    }
  }
  if (
    sub === 'add-transition' &&
    (flags.left === undefined || flags.right === undefined || flags.duration === undefined)
  ) {
    throw usageFailure(
      'Usage: joy-media timeline add-transition --project <id> --left <clipId> --right <clipId> --duration <seconds>',
    );
  }
  if (
    sub === 'add-caption' &&
    (flags.track === undefined || flags.duration === undefined || flags.text === undefined)
  ) {
    throw usageFailure(
      'Usage: joy-media timeline add-caption --project <id> --track <captionTrackId> --start <s> --duration <s> --text "..."',
    );
  }
  if (sub === 'add-track' && flags.family === undefined) {
    throw usageFailure(
      'Usage: joy-media timeline add-track --project <id> --family <visual|audio> [--name <text>]',
    );
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

function apply(
  sub: Subcommand,
  tracks: TimelineTrack[],
  flags: CliFlags,
  project: TimelineProject,
): Outcome {
  switch (sub) {
    case 'add-clip':
      return addClip(tracks, flags, project.assets);
    case 'set-audio':
      return setClipAudio(tracks, flags, project);
    case 'split':
      return splitClip(tracks, flags, project);
    case 'trim':
      return trimClip(tracks, flags, project);
    case 'remove-clip':
      return removeClip(tracks, flags, project);
    case 'add-track':
      return addTrack(tracks, flags);
    case 'move':
      return moveClip(tracks, flags, project);
    case 'add-transition':
      return addTransition(tracks, flags, project);
    case 'add-caption':
      return addCaption(tracks, flags, project);
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

function refuseTitleManagedClip(project: TimelineProject, clipId: string): void {
  if (isTitleManagedClip(project, clipId)) {
    throw new CommandFailure(
      'TITLE_MANAGED_CLIP',
      `Clip "${clipId}" is managed by a title instance; edit it with plan prepare and apply.`,
    );
  }
}

function uniqueClipId(tracks: TimelineTrack[]): string {
  const used = new Set(tracks.flatMap((t) => t.clips.map((k) => k.id)));
  for (;;) {
    const id = `clip-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    if (!used.has(id)) return id;
  }
}

/** A value is a file path when it has a separator or a known media extension; otherwise a label. */
function looksLikeMediaPath(value: string): boolean {
  return /[\\/]/.test(value) || isMediaFileName(value);
}

interface AssetMedia {
  readonly kind: 'image' | 'video' | 'audio';
  readonly durationUs: number | undefined;
}

/** Kind and length of a registered real media asset; undefined for a plain label. */
function assetMedia(asset: unknown): AssetMedia | undefined {
  if (asset === null || typeof asset !== 'object') return undefined;
  const record = asset as { kind?: unknown; descriptor?: { durationUs?: unknown } };
  if (record.kind !== 'image' && record.kind !== 'video' && record.kind !== 'audio') {
    return undefined;
  }
  const durationUs = record.descriptor?.durationUs;
  return {
    kind: record.kind,
    durationUs: typeof durationUs === 'number' && durationUs > 0 ? durationUs : undefined,
  };
}

/** Slack between a clip and its source; the same tolerance render allows. */
const SOURCE_TOLERANCE_US = 50_000;

function assertMediaFits(
  track: TimelineTrack,
  media: AssetMedia,
  label: string,
  durationUs: number,
  allowExtend: boolean,
): void {
  // Same rule as the semantic snapshot: an explicit family wins, else the legacy kind decides.
  const family = track.family ?? (track.kind === 'audio' ? 'audio' : 'visual');
  const visual = family !== 'audio';
  if (visual && media.kind === 'audio') {
    throw new CommandFailure(
      'TRACK_KIND_MISMATCH',
      `"${label}" is audio only, but track "${trackLabel(track)}" is a visual track. Use an audio track (for example track-a1), or a video or image file.`,
    );
  }
  if (!visual && media.kind !== 'audio') {
    throw new CommandFailure(
      'TRACK_KIND_MISMATCH',
      `"${label}" has picture, but track "${trackLabel(track)}" is an audio track. Use a visual track, or an audio-only file.`,
    );
  }
  if (media.kind === 'image' || media.durationUs === undefined || allowExtend) return;
  if (durationUs > media.durationUs + SOURCE_TOLERANCE_US) {
    const sourceSeconds = (media.durationUs / 1_000_000).toFixed(2);
    throw new CommandFailure(
      'CLIP_EXCEEDS_SOURCE',
      `The clip would be ${fmt(durationUs)} long, but "${label}" is only ${sourceSeconds}s. Use --duration ${sourceSeconds} or less, or pass --allow-extend to let the rest render empty.`,
    );
  }
}

function addClip(
  tracks: TimelineTrack[],
  flags: CliFlags,
  assets: Record<string, unknown> | undefined,
): Outcome {
  const trackId = flags.track ?? tracks[0]?.id;
  if (!trackId) throw new CommandFailure('TRACK_NOT_FOUND', 'No tracks available in project.');
  const track = requireTrack(tracks, trackId);
  assertTrackEnabled(track);

  const startUs = toUs(flags.start ?? 0);
  const durationUs = toUs(flags.duration ?? 3);
  const assetId = flags.asset ?? 'asset-default';
  const media = assetMedia(assets?.[assetId]);
  if (media) assertMediaFits(track, media, assetId, durationUs, flags.allowExtend === true);
  assertNoOverlap(track, startUs, durationUs);

  const clip: TimelineClip = {
    id: uniqueClipId(tracks),
    kind: 'video',
    assetId,
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

/** Source position at a moved timeline point: the same frame the timeline already shows there. */
function advanceSource(clip: TimelineClip, deltaUs: number): TimelineClip {
  if (clip.kind === 'composition' && typeof clip.childOffsetUs === 'number') {
    const childOffsetUs = clip.childOffsetUs + deltaUs;
    if (childOffsetUs < 0) {
      throw new CommandFailure(
        'SOURCE_UNDERFLOW',
        `Moving "${clip.id}" there would move the child in-point below 0.`,
      );
    }
    return { ...clip, childOffsetUs };
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

function splitClip(tracks: TimelineTrack[], flags: CliFlags, project: TimelineProject): Outcome {
  const clipId = flags.clip!;
  assertNotInTransition(project, clipId);
  const { track, index, clip } = locateClip(tracks, clipId, flags.track);
  if (clip.kind === 'caption') {
    throw new CommandFailure(
      'CAPTION_CLIP_SPLIT',
      `Caption clip "${clipId}" cannot be split: its cue times run from the clip's start. Add a new caption for the second part.`,
    );
  }

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
  // The second part keeps the clip's gain, mute and fades; they are keyed by clip id.
  const audioClips = (project.audio as { clips?: Record<string, unknown> } | undefined)?.clips;
  if (audioClips && audioClips[clip.id] !== undefined) {
    audioClips[second.id] = { ...(audioClips[clip.id] as Record<string, unknown>) };
  }

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

function trimClip(tracks: TimelineTrack[], flags: CliFlags, project: TimelineProject): Outcome {
  const clipId = flags.clip!;
  refuseTitleManagedClip(project, clipId);
  assertNotInTransition(project, clipId);
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
  Object.assign(clip, advanceSource(clip, Math.max(0, newStartUs - clip.startUs)));
  clip.startUs = newStartUs;
  clip.durationUs = newDurationUs;

  return {
    changed: true,
    human: (rev) => `Trimmed clip ${c(clipId, 'bold')} (saved rev ${rev}).`,
    doc: () => ({ trackId: track.id, clip: describeClip(clip) }),
  };
}

type TrackFamily = 'visual' | 'audio' | 'caption';

function isTrackFamily(value: string | undefined): value is TrackFamily {
  return value === 'visual' || value === 'audio' || value === 'caption';
}

function familyOf(track: TimelineTrack): string {
  if (track.family !== undefined) return track.family;
  return track.kind === 'audio' ? 'audio' : track.kind === 'caption' ? 'caption' : 'visual';
}

/** Append an empty track of the given family, with the next free id and top layer. */
function addTrack(tracks: TimelineTrack[], flags: CliFlags): Outcome {
  const family = flags.family;
  if (!isTrackFamily(family)) {
    throw usageFailure(`--family must be visual, audio or caption, not "${family ?? ''}".`);
  }
  const prefix = family === 'audio' ? 'a' : family === 'caption' ? 'c' : 'v';
  const label = family === 'audio' ? 'Audio' : family === 'caption' ? 'Caption' : 'Video';
  let n = tracks.filter((t) => familyOf(t) === family).length + 1;
  while (tracks.some((t) => t.id === `track-${prefix}${n}`)) n += 1;
  const id = `track-${prefix}${n}`;
  const order = tracks.reduce((top, t) => Math.max(top, t.order ?? -1), -1) + 1;
  tracks.push({
    id,
    kind: family === 'audio' ? 'audio' : family === 'caption' ? 'caption' : 'video',
    // Caption tracks carry no family: the schema limits the family field to visual and audio.
    ...(family === 'caption' ? {} : { family }),
    name: flags.name ?? `${label} ${n}`,
    order,
    enabled: true,
    locked: false,
    clips: [],
  });
  return {
    changed: true,
    human: (rev) => `Added ${family} track ${c(id, 'bold')} (saved rev ${rev}).`,
    doc: () => ({ trackId: id, family }),
  };
}

/** A disabled track is not rendered, so a clip placed on it would silently vanish from the output. */
function assertTrackEnabled(track: TimelineTrack): void {
  if (track.enabled === false) {
    throw new CommandFailure(
      'TRACK_DISABLED',
      `Track "${trackLabel(track)}" is disabled, so its clips would not render. Enable it first.`,
    );
  }
}

/**
 * Move a clip in time, and optionally to another track. The clip keeps its source and length.
 * Its media must still suit the destination track's family, and it must not overlap.
 */
function moveClip(tracks: TimelineTrack[], flags: CliFlags, project: TimelineProject): Outcome {
  const clipId = flags.clip!;
  refuseTitleManagedClip(project, clipId);
  assertNotInTransition(project, clipId);
  // --track is the destination here, so the clip is looked up on every track.
  const found = locateClip(tracks, clipId, undefined);
  const target = requireTrack(tracks, flags.track ?? found.track.id);
  const { clip } = found;
  // Without --start the clip keeps its time, so moving it to another track is one flag.
  const startUs = flags.start !== undefined ? toUs(flags.start) : clip.startUs;

  if (target !== found.track) {
    // A clip stays with its kind of track (family, and kind for caption/object tracks), whatever
    // media it references, so a cross-kind move can never leave a project that will not load.
    if (familyOf(target) !== familyOf(found.track) || !sameKindOfTrack(target, found.track)) {
      throw new CommandFailure(
        'TRACK_KIND_MISMATCH',
        `Clip "${clipId}" is on a ${familyOf(found.track)} track and cannot move to ${familyOf(target)} track "${trackLabel(target)}". Move it to a track of the same kind.`,
      );
    }
    assertTrackEnabled(target);
  }
  const assetId = String(clip['assetId'] ?? 'asset-default');
  const media = assetMedia(project.assets?.[assetId]);
  if (media) assertMediaFits(target, media, assetId, clip.durationUs, true);
  assertNoOverlap(target, startUs, clip.durationUs, clipId);

  if (target === found.track && startUs === clip.startUs) {
    return {
      changed: false,
      human: () => `Clip ${c(clipId, 'bold')} is already at ${fmt(startUs)}; nothing to change.`,
      doc: () => ({ trackId: target.id, clip: describeClip(clip) }),
    };
  }

  found.track.clips.splice(found.index, 1);
  clip.startUs = startUs;
  target.clips.push(clip);
  return {
    changed: true,
    human: (rev) =>
      `Moved clip ${c(clipId, 'bold')} to ${fmt(startUs)} on track ${c(trackLabel(target), 'cyan')} (saved rev ${rev}).`,
    doc: () => ({ trackId: target.id, clip: describeClip(clip) }),
  };
}

/** Gain, mute and fades for one clip, kept in the project's audio record. Unset fields keep their value. */
function setClipAudio(tracks: TimelineTrack[], flags: CliFlags, project: TimelineProject): Outcome {
  const clipId = flags.clip!;
  const { clip } = locateClip(tracks, clipId, undefined);
  const audio = (project.audio ??= { clips: {}, buses: [], effects: [] }) as {
    clips?: Record<string, Record<string, unknown>>;
  };
  const clips = (audio.clips ??= {});
  const defaults = { gain: 1, pan: 0, mute: false, solo: false };
  const current: Record<string, unknown> = { ...defaults, ...clips[clipId] };
  const next: Record<string, unknown> = { ...current };
  if (flags.gain !== undefined) next['gain'] = flags.gain;
  if (flags.mute) next['mute'] = true;
  if (flags.unmute) next['mute'] = false;
  if (flags.fadeIn !== undefined) next['fadeInUs'] = toUs(flags.fadeIn);
  if (flags.fadeOut !== undefined) next['fadeOutUs'] = toUs(flags.fadeOut);
  const fadeInUs = Number(next['fadeInUs'] ?? 0);
  const fadeOutUs = Number(next['fadeOutUs'] ?? 0);
  if (fadeInUs + fadeOutUs > clip.durationUs) {
    throw usageFailure(
      `The fades (${fmt(fadeInUs)} in, ${fmt(fadeOutUs)} out) are longer than clip "${clipId}" (${fmt(clip.durationUs)}).`,
    );
  }
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) clips[clipId] = next;
  return {
    changed,
    human: (rev) =>
      changed
        ? `Set audio for clip ${c(clipId, 'bold')} (saved rev ${rev}).`
        : `Clip ${c(clipId, 'bold')} already has these audio settings; nothing to change.`,
    doc: () => ({
      clipId,
      audio: {
        gain: next['gain'],
        mute: next['mute'],
        fadeInUs,
        fadeOutUs,
      },
    }),
  };
}

/** Add a caption: its text is spread evenly over the clip, word by word, as one segment. */
function addCaption(tracks: TimelineTrack[], flags: CliFlags, project: TimelineProject): Outcome {
  const track = requireTrack(tracks, flags.track!);
  if (track.kind !== 'caption') {
    throw new CommandFailure(
      'TRACK_KIND_MISMATCH',
      `Captions go on a caption track, and "${trackLabel(track)}" is not one. Add one with add-track --family caption.`,
    );
  }
  const words = (flags.text ?? '')
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) throw usageFailure('The caption text is empty.');
  const direction = flags.direction ?? 'auto';
  if (direction !== 'ltr' && direction !== 'rtl' && direction !== 'auto') {
    throw usageFailure(`--direction must be ltr, rtl or auto, not "${direction}".`);
  }
  const language = flags.language ?? 'en';
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(language)) {
    throw usageFailure(`--language must be a language tag such as en or fa-IR, not "${language}".`);
  }
  const startUs = toUs(flags.start ?? 0);
  const durationUs = toUs(flags.duration!);
  if (durationUs < words.length * 1000) {
    throw usageFailure(
      `The caption has ${words.length} words, which needs at least ${words.length} ms; give it a longer --duration.`,
    );
  }
  assertNoOverlap(track, startUs, durationUs);

  const docs = (project.captionDocuments ??= {});
  let number = Object.keys(docs).length + 1;
  while (docs[`caption-${number}`] !== undefined) number += 1;
  const documentId = `caption-${number}`;
  const wordTable: Record<string, unknown> = {};
  const wordIds = words.map((text, i) => {
    const id = `w${i + 1}`;
    wordTable[id] = {
      id,
      text,
      startUs: Math.round((i * durationUs) / words.length),
      endUs: Math.round(((i + 1) * durationUs) / words.length),
    };
    return id;
  });
  docs[documentId] = {
    id: documentId,
    language,
    direction,
    speakers: [],
    words: wordTable,
    segments: [{ id: 's1', startUs: 0, endUs: durationUs, wordIds }],
  };

  const clip = {
    id: uniqueClipId(tracks),
    kind: 'caption',
    startUs,
    durationUs,
    captionDocumentId: documentId,
  } as unknown as TimelineClip;
  track.clips.push(clip);
  return {
    changed: true,
    human: (rev) =>
      `Added caption ${c(clip.id, 'bold')} to track ${c(trackLabel(track), 'cyan')} (saved rev ${rev}).`,
    doc: () => ({ trackId: track.id, clip: describeClip(clip), captionDocumentId: documentId }),
  };
}

function removeClip(tracks: TimelineTrack[], flags: CliFlags, project: TimelineProject): Outcome {
  const clipId = flags.clip!;
  refuseTitleManagedClip(project, clipId);
  const { track, index, clip } = locateClip(tracks, clipId, flags.track);
  track.clips.splice(index, 1);
  // A transition needs both of its clips, so removing one removes the transitions it is part of.
  const holder = rootTransitionsHolder(project);
  const all = transitionsOf(project);
  const dropped = all.filter((t) => t['leftClipId'] === clipId || t['rightClipId'] === clipId);
  if (holder && dropped.length > 0) {
    holder.transitions = all.filter((t) => !dropped.includes(t));
  }

  return {
    changed: true,
    human: (rev) =>
      `Removed clip ${c(clipId, 'bold')} (saved rev ${rev}).` +
      (dropped.length > 0 ? ` Its ${dropped.length} transition(s) were removed too.` : ''),
    doc: () => ({
      trackId: track.id,
      removed: describeClip(clip),
      removedTransitions: dropped.map((t) => String(t['id'])),
    }),
  };
}

/** The root composition holds the transitions list. Timeline edits keep it in step with the clips. */
function rootTransitionsHolder(project: TimelineProject): { transitions?: unknown } | undefined {
  const id = project.rootCompositionId;
  if (id === undefined) return undefined;
  return project.compositions?.[id] as { transitions?: unknown } | undefined;
}

function transitionsOf(project: TimelineProject): Array<Record<string, unknown>> {
  const list = rootTransitionsHolder(project)?.transitions;
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
}

/** A clip inside a transition keeps its time, length and source, or the transition is left dangling. */
function assertNotInTransition(project: TimelineProject, clipId: string): void {
  const holding = transitionsOf(project).filter(
    (t) => t['leftClipId'] === clipId || t['rightClipId'] === clipId,
  );
  if (holding.length > 0) {
    throw new CommandFailure(
      'TRANSITION_IN_USE',
      `Clip "${clipId}" is part of transition ${holding.map((t) => String(t['id'])).join(', ')}. ` +
        'Remove the clip with remove-clip (which removes its transitions), or leave it as it is.',
    );
  }
}

/**
 * A dissolve blends across the junction: half its length comes from media past the outgoing
 * clip's end and half from media before the incoming clip's start. Each side must have that media.
 */
function assertDissolveHandle(
  clip: TimelineClip,
  halfUs: number,
  side: 'before' | 'after',
  assets: Record<string, unknown> | undefined,
): void {
  const assetId = String(clip['assetId'] ?? 'asset-default');
  const media = assetMedia(assets?.[assetId]);
  if (!media) {
    throw new CommandFailure(
      'TRANSITION_INVALID',
      `Clip "${clip.id}" has no media file, so a dissolve cannot take frames past its edge. Add it with a real file.`,
    );
  }
  if (media.kind === 'audio') {
    throw new CommandFailure(
      'TRANSITION_INVALID',
      `Clip "${clip.id}" is audio only, so it has no picture to dissolve.`,
    );
  }
  if (media.kind === 'image') return;
  const sourceInUs = Number(clip['sourceInUs'] ?? 0);
  if (side === 'before' && sourceInUs < halfUs) {
    throw new CommandFailure(
      'TRANSITION_INVALID',
      `Clip "${clip.id}" starts ${fmt(sourceInUs)} into its media, but the dissolve needs ${fmt(halfUs)} before its start. Trim the clip's start so it has that much media before it.`,
    );
  }
  if (side === 'after') {
    const sourceEndUs = sourceInUs + clip.durationUs + halfUs;
    if (media.durationUs !== undefined && sourceEndUs > media.durationUs + SOURCE_TOLERANCE_US) {
      throw new CommandFailure(
        'TRANSITION_INVALID',
        `The dissolve needs ${fmt(halfUs)} of media after clip "${clip.id}", but its file ends first (${fmt(media.durationUs)}). Shorten the clip or the dissolve.`,
      );
    }
  }
}

/** Audio and video tracks may exchange clips within a family; caption and object tracks keep their own kind. */
function sameKindOfTrack(a: TimelineTrack, b: TimelineTrack): boolean {
  const pictureOrSound = (t: TimelineTrack): boolean =>
    t.kind === undefined || t.kind === 'video' || t.kind === 'audio';
  return a.kind === b.kind || (pictureOrSound(a) && pictureOrSound(b));
}

/** Blend two touching clips on one track: `--left` ends where `--right` starts. */
function addTransition(
  tracks: TimelineTrack[],
  flags: CliFlags,
  project: TimelineProject,
): Outcome {
  const left = locateClip(tracks, flags.left!, undefined);
  const right = locateClip(tracks, flags.right!, undefined);
  if (left.track !== right.track) {
    throw new CommandFailure(
      'TRANSITION_INVALID',
      'Both clips of a transition must be on the same track.',
    );
  }
  if (familyOf(left.track) !== 'visual') {
    throw new CommandFailure(
      'TRANSITION_INVALID',
      `Dissolves join picture clips, and track "${trackLabel(left.track)}" is an audio track.`,
    );
  }
  const type = flags.type ?? 'dissolve';
  if (type !== 'dissolve') {
    throw usageFailure(`Only dissolve transitions are supported (--type dissolve), not "${type}".`);
  }
  const durationUs = toUs(flags.duration!);
  const endOfLeft = left.clip.startUs + left.clip.durationUs;
  if (endOfLeft !== right.clip.startUs) {
    throw new CommandFailure(
      'TRANSITION_INVALID',
      `The clips must touch: "${left.clip.id}" ends at ${fmt(endOfLeft)} and "${right.clip.id}" starts at ${fmt(right.clip.startUs)}.`,
    );
  }
  const shorter = Math.min(left.clip.durationUs, right.clip.durationUs);
  if (durationUs > shorter / 2) {
    throw new CommandFailure(
      'TRANSITION_INVALID',
      `A dissolve may be at most half of the shorter clip, ${fmt(shorter / 2)}; ${fmt(durationUs)} was asked for.`,
    );
  }
  assertDissolveHandle(left.clip, durationUs / 2, 'after', project.assets);
  assertDissolveHandle(right.clip, durationUs / 2, 'before', project.assets);
  const taken = transitionsOf(project).find(
    (t) => t['leftClipId'] === left.clip.id || t['rightClipId'] === right.clip.id,
  );
  if (taken) {
    throw new CommandFailure(
      'TRANSITION_INVALID',
      `Transition ${String(taken['id'])} already uses one of these clips. A clip can join at most one dissolve on each side.`,
    );
  }
  const holder = rootTransitionsHolder(project);
  if (!holder) throw new CommandFailure('PROJECT_FILE_INVALID', 'Project has no root composition.');
  const id = `transition-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  holder.transitions = [
    ...transitionsOf(project),
    {
      id,
      trackId: left.track.id,
      leftClipId: left.clip.id,
      rightClipId: right.clip.id,
      type: 'dissolve',
      durationUs,
    },
  ];
  return {
    changed: true,
    human: (rev) =>
      `Added a ${fmt(durationUs)} dissolve from ${c(left.clip.id, 'bold')} to ${c(right.clip.id, 'bold')} (saved rev ${rev}).`,
    doc: () => ({
      transitionId: id,
      leftClipId: left.clip.id,
      rightClipId: right.clip.id,
      durationUs,
    }),
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
