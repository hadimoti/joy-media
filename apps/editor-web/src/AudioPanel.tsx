/**
 * Fairlight-lite mixer: gain/pan/mute/solo/fade — icon rows with hover guides.
 */

import { useState } from 'react';
import type { AudioCommand, AudioState } from '@joy-media/commands';
import { applyAudioCommand } from '@joy-media/commands';
import {
  FadeInIcon,
  FadeOutIcon,
  GainIcon,
  MasterBusIcon,
  MuteIcon,
  PanIcon,
  SoloIcon,
  SpeakerOnIcon,
} from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl, panelTabSvgIcon } from './panel-tab-icons.js';

const TABS: readonly PanelTabSpec[] = [
  { id: 'master', label: 'Master' },
  { id: 'clips', label: 'Clips' },
];

interface AudioPanelProps {
  readonly clipIds: readonly string[];
  readonly audioState: AudioState;
  readonly onAudioChange: (next: AudioState, label: string) => void;
}

export function AudioPanel({ clipIds, audioState, onAudioChange }: AudioPanelProps) {
  const [tab, setTab] = useState('master');
  const dispatch = (command: AudioCommand, label: string) => {
    try {
      const { state } = applyAudioCommand(audioState, command);
      onAudioChange(state, label);
    } catch (error) {
      console.warn('audio command rejected', error);
    }
  };

  const master = audioState.buses.find((bus) => bus.id === 'master') ?? audioState.buses[0];
  // §3c: the Clips tab keeps its shape when the timeline is empty — the strips
  // render disabled rather than being replaced by a sentence.
  const noClips = clipIds.length === 0;
  const clipsInactive = tab === 'clips' && noClips;

  return (
    <PanelShell
      title="Audio"
      iconUrl={panelTabIconUrl('audio')}
      icon={(() => {
        const Svg = panelTabSvgIcon('audio');
        return Svg === undefined ? undefined : <Svg />;
      })()}
      className="audio-panel"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      inactive={clipsInactive}
      {...(clipsInactive ? { note: 'Place clips on the timeline to mix audio.' } : {})}
    >
      {tab === 'master' && master !== undefined && (
        <div className="audio-strip">
          <div className="control-row">
            <span className="icon-tool" data-guide="Master bus" aria-hidden="true">
              <MasterBusIcon />
            </span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={master.gain}
              aria-label="Master gain"
              title="Master gain"
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
            <span className="value">{master.gain.toFixed(2)}</span>
          </div>
        </div>
      )}
      {tab === 'clips' &&
        // One placeholder strip when there is nothing to mix, so the panel
        // still shows what it does (§3c.3) instead of collapsing to a hint.
        (noClips ? ['—'] : clipIds).map((clipId) => {
          const clip = audioState.clips[clipId] ?? {
            gain: 1,
            pan: 0,
            mute: false,
            solo: false,
          };
          return (
            <div className="audio-strip" key={clipId}>
              <div className="audio-strip-flags">
                <strong className="sr-only">{clipId}</strong>
                <span className="audio-clip-id" title={clipId}>
                  {clipId.length > 14 ? `${clipId.slice(0, 12)}…` : clipId}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-pressed={clip.mute}
                  aria-label={`Mute ${clipId}`}
                  data-guide="Mute"
                  disabled={noClips}
                  onClick={() =>
                    dispatch(
                      { type: 'audioClip.setMute', payload: { clipId, mute: !clip.mute } },
                      `Mute ${clipId}`,
                    )
                  }
                >
                  {clip.mute ? <MuteIcon /> : <SpeakerOnIcon />}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-pressed={clip.solo}
                  aria-label={`Solo ${clipId}`}
                  data-guide="Solo"
                  disabled={noClips}
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
              <div className="control-row">
                <span className="icon-tool" data-guide="Gain" aria-hidden="true">
                  <GainIcon />
                </span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={clip.gain}
                  aria-label={`Gain ${clipId}`}
                  title="Gain"
                  disabled={noClips}
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
                <span className="value">{clip.gain.toFixed(2)}</span>
              </div>
              <div className="control-row">
                <span className="icon-tool" data-guide="Pan" aria-hidden="true">
                  <PanIcon />
                </span>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={clip.pan}
                  aria-label={`Pan ${clipId}`}
                  title="Pan"
                  disabled={noClips}
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
                <span className="value">{clip.pan.toFixed(2)}</span>
              </div>
              <div className="control-row">
                <span className="icon-tool" data-guide="Fade in" aria-hidden="true">
                  <FadeInIcon />
                </span>
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={Math.round((clip.fadeInUs ?? 0) / 1000)}
                  aria-label={`Fade in ${clipId} (ms)`}
                  title="Fade in (ms)"
                  disabled={noClips}
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
                <span className="value">ms</span>
              </div>
              <div className="control-row">
                <span className="icon-tool" data-guide="Fade out" aria-hidden="true">
                  <FadeOutIcon />
                </span>
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={Math.round((clip.fadeOutUs ?? 0) / 1000)}
                  aria-label={`Fade out ${clipId} (ms)`}
                  title="Fade out (ms)"
                  disabled={noClips}
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
                <span className="value">ms</span>
              </div>
              <div className="audio-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, clip.gain * 50)}%` }} />
              </div>
            </div>
          );
        })}
    </PanelShell>
  );
}
