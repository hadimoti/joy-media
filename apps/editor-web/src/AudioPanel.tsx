/**
 * Fairlight-lite mixer: gain/pan/mute/solo/fade per clip + master bus.
 */

import type { AudioCommand, AudioState } from '@joy-media/commands';
import { applyAudioCommand } from '@joy-media/commands';
import { MuteIcon, SoloIcon } from './icons.js';

interface AudioPanelProps {
  readonly clipIds: readonly string[];
  readonly audioState: AudioState;
  readonly onAudioChange: (next: AudioState, label: string) => void;
}

export function AudioPanel({ clipIds, audioState, onAudioChange }: AudioPanelProps) {
  const dispatch = (command: AudioCommand, label: string) => {
    try {
      const { state } = applyAudioCommand(audioState, command);
      onAudioChange(state, label);
    } catch (error) {
      console.warn('audio command rejected', error);
    }
  };

  const master = audioState.buses.find((bus) => bus.id === 'master') ?? audioState.buses[0];

  return (
    <article className="audio-panel">
      <h3>Mixer</h3>
      <p className="empty-hint">Gain and mute apply to preview/export mix when wired per clip.</p>
      {master !== undefined && (
        <div className="audio-strip">
          <strong>{master.name}</strong>
          <label>
            Gain
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={master.gain}
              onChange={(event) =>
                dispatch(
                  {
                    type: 'audioBus.setGain',
                    payload: { busId: master.id, gain: event.currentTarget.valueAsNumber },
                  },
                  `Master gain ${event.currentTarget.valueAsNumber.toFixed(2)}`,
                )
              }
            />
            <span>{master.gain.toFixed(2)}</span>
          </label>
        </div>
      )}
      {clipIds.map((clipId) => {
        const clip = audioState.clips[clipId] ?? {
          gain: 1,
          pan: 0,
          mute: false,
          solo: false,
        };
        return (
          <div className="audio-strip" key={clipId}>
            <strong title={clipId}>{clipId}</strong>
            <div className="audio-strip-flags">
              <button
                type="button"
                className="icon-button"
                aria-pressed={clip.mute}
                aria-label={`Mute ${clipId}`}
                onClick={() =>
                  dispatch(
                    { type: 'audioClip.setMute', payload: { clipId, mute: !clip.mute } },
                    `Mute ${clipId}`,
                  )
                }
              >
                <MuteIcon />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-pressed={clip.solo}
                aria-label={`Solo ${clipId}`}
                onClick={() =>
                  dispatch(
                    { type: 'audioClip.setSolo', payload: { clipId, solo: !clip.solo } },
                    `Solo ${clipId}`,
                  )
                }
              >
                <SoloIcon />
              </button>
            </div>
            <label>
              Gain
              <input
                type="range"
                min={0}
                max={2}
                step={0.01}
                value={clip.gain}
                onChange={(event) =>
                  dispatch(
                    {
                      type: 'audioClip.setGain',
                      payload: { clipId, gain: event.currentTarget.valueAsNumber },
                    },
                    `Gain ${clipId}`,
                  )
                }
              />
            </label>
            <label>
              Pan
              <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={clip.pan}
                onChange={(event) =>
                  dispatch(
                    {
                      type: 'audioClip.setPan',
                      payload: { clipId, pan: event.currentTarget.valueAsNumber },
                    },
                    `Pan ${clipId}`,
                  )
                }
              />
            </label>
            <label>
              Fade in (ms)
              <input
                type="number"
                min={0}
                step={50}
                value={Math.round((clip.fadeInUs ?? 0) / 1000)}
                onChange={(event) =>
                  dispatch(
                    {
                      type: 'audioClip.setFade',
                      payload: {
                        clipId,
                        fadeInUs: Math.max(0, event.currentTarget.valueAsNumber) * 1000,
                        fadeInUsWasSet: true,
                      },
                    },
                    `Fade in ${clipId}`,
                  )
                }
              />
            </label>
            <label>
              Fade out (ms)
              <input
                type="number"
                min={0}
                step={50}
                value={Math.round((clip.fadeOutUs ?? 0) / 1000)}
                onChange={(event) =>
                  dispatch(
                    {
                      type: 'audioClip.setFade',
                      payload: {
                        clipId,
                        fadeOutUs: Math.max(0, event.currentTarget.valueAsNumber) * 1000,
                        fadeOutUsWasSet: true,
                      },
                    },
                    `Fade out ${clipId}`,
                  )
                }
              />
            </label>
            <div className="audio-meter" aria-hidden="true">
              <span style={{ width: `${Math.min(100, clip.gain * 50)}%` }} />
            </div>
          </div>
        );
      })}
      {clipIds.length === 0 && <p className="empty-hint">No clips on the timeline yet.</p>}
    </article>
  );
}
