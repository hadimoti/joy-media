import { useMemo, useState } from 'react';
import { rippleDelete, toggleTrackFlag, virtualTracks } from '@joy-media/timeline-engine';
import type { CommandTransaction } from '@joy-media/commands';
import type { SpikeProject } from '@joy-media/project-schema';
import type { TimelineTrackView } from '@joy-media/timeline-engine';

export function TimelinePanel({
  project,
  playheadUs,
  playing,
  selectedIds,
  onTogglePlayback,
  onSeek,
  onToggleSelection,
  onDispatch,
}: {
  readonly project: SpikeProject;
  readonly playheadUs: number;
  readonly playing: boolean;
  readonly selectedIds: readonly string[];
  readonly onTogglePlayback: () => void;
  readonly onSeek: (timeUs: number) => void;
  readonly onToggleSelection: (id: string) => void;
  readonly onDispatch: (transaction: CommandTransaction) => void;
}) {
  const [trackFlags, setTrackFlags] = useState<readonly TimelineTrackView[]>([]);
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) throw new Error('timeline root composition is unavailable');
  const tracks = composition.tracks.map((track, index) => {
    const saved = trackFlags.find((item) => item.id === track.id);
    return (
      saved ?? {
        id: track.id,
        heightPx: 36,
        locked: false,
        muted: !track.enabled,
        solo: false,
        order: index,
      }
    );
  });
  const visible = useMemo(() => virtualTracks(tracks, 0, 180), [tracks]);
  const toggle = (id: string, flag: 'locked' | 'muted' | 'solo') =>
    setTrackFlags(() => {
      const next = tracks.map((track) => (track.id === id ? toggleTrackFlag(track, flag) : track));
      return next.map(({ id: trackId, heightPx, locked, muted, solo }) => ({
        id: trackId,
        heightPx,
        locked,
        muted,
        solo,
      }));
    });
  const selected = selectedIds
    .map((id) =>
      composition.tracks
        .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
        .find((item) => item.clip.id === id),
    )
    .find((item) => item !== undefined);
  const selectedEndUs =
    selected === undefined ? undefined : selected.clip.startUs + selected.clip.durationUs;
  const canSplit =
    selected !== undefined &&
    playheadUs > selected.clip.startUs &&
    playheadUs < (selectedEndUs ?? 0);

  return (
    <article className="timeline-panel">
      <div className="timeline-toolbar">
        <button onClick={onTogglePlayback}>{playing ? 'Pause' : 'Play proxy'}</button>
        <button onClick={() => onSeek(Math.max(0, playheadUs - 1_000_000))}>−1s</button>
        <output>{(playheadUs / 1_000_000).toFixed(2)} s</output>
        <button onClick={() => onSeek(Math.min(composition.durationUs, playheadUs + 1_000_000))}>
          +1s
        </button>
        <input
          aria-label="Playhead"
          type="range"
          min={0}
          max={composition.durationUs}
          step={100_000}
          value={playheadUs}
          onChange={(event) => onSeek(event.currentTarget.valueAsNumber)}
        />
      </div>
      {selected !== undefined && (
        <div className="timeline-toolbar" aria-label="Selected clip actions">
          <strong>{selected.clip.id}</strong>
          <button
            disabled={!canSplit}
            onClick={() =>
              onDispatch({
                label: `Split ${selected.clip.id}`,
                commands: [
                  {
                    type: 'timeline.splitClip',
                    payload: {
                      compositionId: composition.id,
                      trackId: selected.track.id,
                      clipId: selected.clip.id,
                      atUs: playheadUs,
                      newClipId: `${selected.clip.id}-split-${playheadUs}`,
                    },
                  },
                ],
              })
            }
          >
            Split at playhead
          </button>
          <button
            disabled={selected.clip.durationUs <= 1_000_000}
            onClick={() =>
              onDispatch({
                label: `Trim ${selected.clip.id}`,
                commands: [
                  {
                    type: 'timeline.trimClipEnd',
                    payload: {
                      compositionId: composition.id,
                      trackId: selected.track.id,
                      clipId: selected.clip.id,
                      newEndUs: selectedEndUs! - 1_000_000,
                    },
                  },
                ],
              })
            }
          >
            Trim end −1s
          </button>
          <button
            onClick={() =>
              onDispatch(
                rippleDelete(
                  composition.id,
                  selected.track.id,
                  selected.track.clips.map((clip) => ({
                    id: clip.id,
                    startUs: clip.startUs,
                    durationUs: clip.durationUs,
                  })),
                  selected.clip.id,
                ),
              )
            }
          >
            Ripple delete
          </button>
        </div>
      )}
      {visible.map((track) => {
        const source = composition.tracks.find((item) => item.id === track.id);
        if (source === undefined) return null;
        return (
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
            <span className="timeline-lane">
              {source.clips.map((clip) => (
                <button
                  className="timeline-clip"
                  key={clip.id}
                  aria-pressed={selectedIds.includes(clip.id)}
                  onClick={() => onToggleSelection(clip.id)}
                >
                  {clip.id}
                </button>
              ))}
            </span>
          </div>
        );
      })}
    </article>
  );
}
