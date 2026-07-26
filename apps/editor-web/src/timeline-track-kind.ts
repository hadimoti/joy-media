import type { Clip, Track } from '@joy-media/project-schema';

export type TimelineTrackKind = 'video' | 'audio' | 'script';

const AUDIO_TOKEN = /(?:^|[^a-z0-9])(voice|audio|vo|sfx|music|aiff|wav|mp3|m4a)(?:$|[^a-z0-9])/i;
const SCRIPT_TOKEN =
  /(?:^|[^a-z0-9])(script|caption|captions|subtitle|subtitles|transcript|srt|vtt|text)(?:$|[^a-z0-9])/i;

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
export function timelineTrackKind(track: Pick<Track, 'id' | 'clips'>): TimelineTrackKind {
  if (SCRIPT_TOKEN.test(track.id)) return 'script';
  if (AUDIO_TOKEN.test(track.id)) return 'audio';
  if (track.clips.length === 0) return 'video';

  const identities = track.clips.map(clipIdentity);
  if (identities.every((identity) => SCRIPT_TOKEN.test(identity))) return 'script';
  if (identities.every((identity) => AUDIO_TOKEN.test(identity))) return 'audio';
  return 'video';
}
