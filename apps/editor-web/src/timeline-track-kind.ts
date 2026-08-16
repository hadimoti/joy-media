import type { Clip, Track } from '@joy-media/project-schema';
import type { TimelineElementKind, TimelineElementKindMap } from './timeline-element-kind.js';
import { timelineElementKindForClip } from './timeline-element-kind.js';

export type TimelineTrackKind = TimelineElementKind | 'script';

const AUDIO_TOKEN = /(?:^|[^a-z0-9])(voice|audio|vo|sfx|music|aiff|wav|mp3|m4a)(?:$|[^a-z0-9])/i;
const CAPTION_TOKEN =
  /(?:^|[^a-z0-9])(cc|caption|captions|subtitle|subtitles|transcript|srt|vtt)(?:$|[^a-z0-9])/i;
const SCRIPT_TOKEN = /(?:^|[^a-z0-9])(script|prompt|agent)(?:$|[^a-z0-9])/i;
const TEXT_TOKEN = /(?:^|[^a-z0-9])(text|title|third|lower[-_ ]?third)(?:$|[^a-z0-9])/i;
const MOTION_TOKEN = /(?:^|[^a-z0-9])(motion|animate|animation|mogrt)(?:$|[^a-z0-9])/i;
const EFFECT_TOKEN = /(?:^|[^a-z0-9])(effect|effects|fx)(?:$|[^a-z0-9])/i;
const FILTER_TOKEN = /(?:^|[^a-z0-9])(filter|filters|look|lut)(?:$|[^a-z0-9])/i;
const ADJUST_TOKEN = /(?:^|[^a-z0-9])(adjust|adjustment|grade)(?:$|[^a-z0-9])/i;
const OVERLAY_TOKEN = /(?:^|[^a-z0-9])(overlay|picture|pip)(?:$|[^a-z0-9])/i;
const SCENE_3D_TOKEN = /(?:^|[^a-z0-9])(3d|three[-_ ]?d|model|scene3d)(?:$|[^a-z0-9])/i;

function clipIdentity(clip: Clip): string {
  return clip.kind === 'video'
    ? `${clip.id}\0${clip.assetId}`
    : `${clip.id}\0${clip.compositionId}`;
}

/**
 * The spike project schema still reports every timeline row as `video`.
 * Until the full track taxonomy lands, derive presentation kind from stable
 * track/clip identities and leave unknown or mixed rows as video.
 */
export function timelineTrackKind(
  track: Pick<Track, 'id' | 'clips'>,
  elementKinds: TimelineElementKindMap = {},
): TimelineTrackKind {
  const explicitKinds = track.clips.map((clip) => timelineElementKindForClip(clip, elementKinds));
  const firstExplicit = explicitKinds[0];
  if (
    firstExplicit !== undefined &&
    firstExplicit !== 'video' &&
    explicitKinds.every((kind) => kind === firstExplicit)
  ) {
    return firstExplicit;
  }
  if (ADJUST_TOKEN.test(track.id)) return 'adjust';
  if (EFFECT_TOKEN.test(track.id)) return 'effect';
  if (FILTER_TOKEN.test(track.id)) return 'filter';
  if (OVERLAY_TOKEN.test(track.id)) return 'overlay';
  if (SCENE_3D_TOKEN.test(track.id)) return 'scene3d';
  if (CAPTION_TOKEN.test(track.id)) return 'caption';
  if (MOTION_TOKEN.test(track.id)) return 'motion';
  if (TEXT_TOKEN.test(track.id)) return 'text';
  if (SCRIPT_TOKEN.test(track.id)) return 'script';
  if (AUDIO_TOKEN.test(track.id)) return 'audio';
  if (track.clips.length === 0) return 'video';

  const identities = track.clips.map(clipIdentity);
  if (identities.every((identity) => CAPTION_TOKEN.test(identity))) return 'caption';
  if (identities.every((identity) => MOTION_TOKEN.test(identity))) return 'motion';
  if (identities.every((identity) => SCRIPT_TOKEN.test(identity))) return 'script';
  if (identities.every((identity) => AUDIO_TOKEN.test(identity))) return 'audio';
  return 'video';
}

/** Compact lane code shown above the human track name (V1 / A2 / S1). */
export function timelineTrackCode(kind: TimelineTrackKind, kindIndex: number): string {
  if (kind === 'audio') return `A${kindIndex}`;
  if (kind === 'text') return `T${kindIndex}`;
  if (kind === 'caption') return `CC${kindIndex}`;
  if (kind === 'motion') return `M${kindIndex}`;
  if (kind === 'effect') return `FX${kindIndex}`;
  if (kind === 'filter') return `F${kindIndex}`;
  if (kind === 'adjust') return `ADJ${kindIndex}`;
  if (kind === 'overlay') return `O${kindIndex}`;
  if (kind === 'scene3d') return `3D${kindIndex}`;
  if (kind === 'script') return `S${kindIndex}`;
  return `V${kindIndex}`;
}

/** Human track name paired with {@link timelineTrackCode}. */
export function timelineTrackDisplayName(kind: TimelineTrackKind, kindIndex: number): string {
  if (kind === 'audio') return kindIndex === 1 ? 'Audio' : `Audio ${kindIndex}`;
  if (kind === 'text') return kindIndex === 1 ? 'Text' : `Text ${kindIndex}`;
  if (kind === 'caption') return kindIndex === 1 ? 'Captions' : `Captions ${kindIndex}`;
  if (kind === 'motion') return kindIndex === 1 ? 'Motion' : `Motion ${kindIndex}`;
  if (kind === 'effect') return kindIndex === 1 ? 'Effects' : `Effects ${kindIndex}`;
  if (kind === 'filter') return kindIndex === 1 ? 'Filters' : `Filters ${kindIndex}`;
  if (kind === 'adjust') return kindIndex === 1 ? 'Adjust' : `Adjust ${kindIndex}`;
  if (kind === 'overlay') return kindIndex === 1 ? 'Overlay' : `Overlay ${kindIndex}`;
  if (kind === 'scene3d') return kindIndex === 1 ? '3D Scene' : `3D Scene ${kindIndex}`;
  if (kind === 'script') return kindIndex === 1 ? 'Script' : `Script ${kindIndex}`;
  if (kindIndex === 1) return 'Main Video';
  if (kindIndex === 2) return 'B-roll';
  return `Video ${kindIndex}`;
}

/**
 * Universal Compatibility Mode deliberately keeps semantic kind off the track
 * header. Element kind is shown on the clip itself; the lane is a neutral
 * layer container that accepts every supported element.
 */
export function universalTrackCode(trackIndex: number): string {
  return `T${Math.max(1, trackIndex)}`;
}

export function universalTrackDisplayName(trackIndex: number, explicitName?: string): string {
  const trimmed = explicitName?.trim();
  return trimmed === undefined || trimmed.length === 0 || isLegacyKindLabel(trimmed)
    ? `Layer ${Math.max(1, trackIndex)}`
    : trimmed;
}

/**
 * Legacy projects persisted presentation labels such as "Main Video" and
 * "Captions" on tracks. They are not capabilities, so do not expose them as
 * the universal row identity after the compatibility projection is enabled.
 * User-authored names (including "Hero" or "Layer 1") remain intact.
 */
function isLegacyKindLabel(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  return /^(main video|b-?roll|video(?: \d+)?|overlay|3d scene|text|captions?|cc captions?|motion graphic|effects?|audio(?: \d+)?|voice|script(?: \d+)?)$/.test(
    normalized,
  );
}
