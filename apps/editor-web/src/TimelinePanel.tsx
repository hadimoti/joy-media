import { useMemo, useState } from 'react';
import { toggleTrackFlag, virtualTracks } from '@joy-media/timeline-engine';
import type { TimelineTrackView } from '@joy-media/timeline-engine';

const INITIAL_TRACKS: readonly TimelineTrackView[] = [
  { id: 'V1', heightPx: 36, locked: false, muted: false, solo: false },
  { id: 'V2', heightPx: 36, locked: false, muted: false, solo: false },
  { id: 'A1', heightPx: 36, locked: false, muted: false, solo: false },
];

export function TimelinePanel({
  playheadUs,
  onAdvance,
}: {
  readonly playheadUs: number;
  readonly onAdvance: () => void;
}) {
  const [tracks, setTracks] = useState(INITIAL_TRACKS);
  const visible = useMemo(() => virtualTracks(tracks, 0, 180), [tracks]);
  const toggle = (id: string, flag: 'locked' | 'muted' | 'solo') =>
    setTracks((current) =>
      current.map((track) => (track.id === id ? toggleTrackFlag(track, flag) : track)),
    );
  return (
    <article className="timeline-panel">
      <div className="timeline-toolbar">
        <button onClick={onAdvance}>Advance playhead</button>
        <output>{playheadUs} µs</output>
      </div>
      {visible.map((track) => (
        <div className="timeline-track" key={track.id}>
          <strong>{track.id}</strong>
          <button aria-pressed={track.locked} onClick={() => toggle(track.id, 'locked')}>
            Lock
          </button>
          <button aria-pressed={track.muted} onClick={() => toggle(track.id, 'muted')}>
            Mute
          </button>
          <button aria-pressed={track.solo} onClick={() => toggle(track.id, 'solo')}>
            Solo
          </button>
          <span className="timeline-lane" />
        </div>
      ))}
    </article>
  );
}
