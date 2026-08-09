/**
 * Audio Studio: local-worker-first architecture surface plus Fairlight-lite mixer.
 */

import { useMemo, useState } from 'react';
import type { AudioCommand, AudioState } from '@joy-media/commands';
import { applyAudioCommand } from '@joy-media/commands';
import {
  AudioIcon,
  AudioWorkerIcon,
  CheckIcon,
  CloudIcon,
  DeviceProcessorIcon,
  DownloadIcon,
  FadeInIcon,
  FadeOutIcon,
  GainIcon,
  MasterBusIcon,
  MuteIcon,
  PanIcon,
  PlayIcon,
  SlidersIcon,
  SoloIcon,
  SpeakerOnIcon,
  StorageFolderIcon,
} from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl, panelTabSvgIcon } from './panel-tab-icons.js';
import {
  AUDIO_ATOMIC_CAPABILITIES,
  AUDIO_MODEL_CATALOG,
  AUDIO_WORKFLOW_PRESETS,
  DEFAULT_MODEL_CACHE_PATH,
  buildAudioWorkflowGraph,
  getAudioCapability,
  summarizeLocalAudioResources,
  type AudioAtomicCapability,
  type AudioExecutionTarget,
  type AudioModelSpec,
} from './audio-studio-runtime.js';

const TABS: readonly PanelTabSpec[] = [
  { id: 'studio', label: 'Studio' },
  { id: 'models', label: 'Models' },
  { id: 'master', label: 'Master' },
  { id: 'clips', label: 'Clips' },
];

type CapabilityFilter = 'all' | AudioExecutionTarget;

const CAPABILITY_FILTERS: readonly {
  readonly id: CapabilityFilter;
  readonly label: string;
}[] = [
  { id: 'all', label: 'All' },
  { id: 'local-worker', label: 'Local Worker' },
  { id: 'browser-dsp', label: 'Browser DSP' },
  { id: 'vps-orchestrated', label: 'Cloud Brain' },
];

interface AudioPanelProps {
  readonly clipIds: readonly string[];
  readonly audioState: AudioState;
  readonly onAudioChange: (next: AudioState, label: string) => void;
}

function targetLabel(target: AudioAtomicCapability['target']): string {
  switch (target) {
    case 'local-worker':
      return 'Local Worker';
    case 'browser-dsp':
      return 'Browser DSP';
    case 'vps-orchestrated':
      return 'Cloud Brain';
  }
}

function installLabel(state: AudioModelSpec['installState']): string {
  switch (state) {
    case 'installed':
      return 'Installed';
    case 'available':
      return 'Download';
    case 'update':
      return 'Update';
  }
}

function ResourcePill({ value, label }: { readonly value: string; readonly label: string }) {
  return (
    <span className="audio-resource-pill">
      <strong>{value}</strong>
      {label}
    </span>
  );
}

function CapabilityTile({ capability }: { readonly capability: AudioAtomicCapability }) {
  const model =
    capability.modelId === undefined
      ? undefined
      : AUDIO_MODEL_CATALOG.find((item) => item.id === capability.modelId);
  return (
    <li className="audio-capability-tile" data-target={capability.target}>
      <div className="audio-capability-topline">
        <strong>{capability.label}</strong>
        <span>{targetLabel(capability.target)}</span>
      </div>
      <div className="audio-capability-id">{capability.id}</div>
      <div className="audio-capability-provider">{capability.provider}</div>
      <div className="audio-capability-foot">
        <ResourcePill value={`${capability.resources.ramGb}G`} label="RAM" />
        <ResourcePill value={`${capability.resources.vramGb}G`} label="VRAM" />
        {model !== undefined && <span className="audio-model-chip">{model.name}</span>}
      </div>
    </li>
  );
}

function ModelRow({ model }: { readonly model: AudioModelSpec }) {
  const installed = model.installState === 'installed';
  return (
    <li className="audio-model-row">
      <div className="audio-model-main">
        <strong>{model.name}</strong>
        <span>{model.provider}</span>
      </div>
      <div className="audio-model-meta">
        <span>{model.version}</span>
        <span>{model.sizeGb.toFixed(1)} GB</span>
        <span>{model.ramGb}G RAM</span>
        <span>{model.vramGb}G VRAM</span>
        <span>{model.gpu}</span>
      </div>
      <div className="audio-model-caps">
        {model.capabilities.map((capabilityId) => (
          <span key={capabilityId}>{getAudioCapability(capabilityId).label}</span>
        ))}
      </div>
      <div className="audio-model-path" title={model.localPath}>
        {model.localPath}
      </div>
      <button
        type="button"
        className="icon-button audio-model-action"
        aria-label={`${installLabel(model.installState)} ${model.name}`}
        title={installLabel(model.installState)}
        data-guide={installLabel(model.installState)}
        disabled={!installed}
      >
        {installed ? <CheckIcon /> : <DownloadIcon />}
      </button>
    </li>
  );
}

export function AudioPanel({ clipIds, audioState, onAudioChange }: AudioPanelProps) {
  const [tab, setTab] = useState('studio');
  const [workflowId, setWorkflowId] = useState(AUDIO_WORKFLOW_PRESETS[0]!.id);
  const [device, setDevice] = useState<'gpu' | 'cpu'>('gpu');
  const [modelCachePath, setModelCachePath] = useState(DEFAULT_MODEL_CACHE_PATH);
  const [capabilityFilter, setCapabilityFilter] = useState<CapabilityFilter>('all');
  const dispatch = (command: AudioCommand, label: string) => {
    try {
      const { state } = applyAudioCommand(audioState, command);
      onAudioChange(state, label);
    } catch (error) {
      console.warn('audio command rejected', error);
    }
  };

  const selectedWorkflow =
    AUDIO_WORKFLOW_PRESETS.find((preset) => preset.id === workflowId) ?? AUDIO_WORKFLOW_PRESETS[0]!;
  const workflowGraph = useMemo(
    () => buildAudioWorkflowGraph(selectedWorkflow.id),
    [selectedWorkflow.id],
  );
  const workflowResources = useMemo(
    () => summarizeLocalAudioResources(selectedWorkflow.steps),
    [selectedWorkflow.steps],
  );
  const visibleCapabilities = useMemo(
    () =>
      capabilityFilter === 'all'
        ? AUDIO_ATOMIC_CAPABILITIES
        : AUDIO_ATOMIC_CAPABILITIES.filter(({ target }) => target === capabilityFilter),
    [capabilityFilter],
  );
  const master = audioState.buses.find((bus) => bus.id === 'master') ?? audioState.buses[0];
  const noClips = clipIds.length === 0;
  const clipsInactive = tab === 'clips' && noClips;
  const localWorkerReady = false;
  const runReadinessId = `audio-${selectedWorkflow.id}-run-readiness`;

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
      {tab === 'studio' && (
        <div className="audio-studio-stack">
          <section className="audio-runtime-section" aria-label="Audio runtime status">
            <div className="audio-runtime-grid">
              <div className="audio-runtime-cell" data-state="pairing">
                <span className="icon-tool" aria-hidden="true">
                  <AudioWorkerIcon />
                </span>
                <strong>Local Worker</strong>
                <span>Pairing</span>
              </div>
              <div className="audio-runtime-cell" data-state="online">
                <span className="icon-tool" aria-hidden="true">
                  <CloudIcon />
                </span>
                <strong>Cloud Brain</strong>
                <span>Online</span>
              </div>
              <label className="audio-runtime-cell audio-runtime-control">
                <span className="icon-tool" aria-hidden="true">
                  <DeviceProcessorIcon />
                </span>
                <strong>Device</strong>
                <select
                  value={device}
                  aria-label="Audio worker device"
                  onChange={(event) =>
                    setDevice(event.currentTarget.value === 'cpu' ? 'cpu' : 'gpu')
                  }
                >
                  <option value="gpu">GPU</option>
                  <option value="cpu">CPU</option>
                </select>
              </label>
            </div>
            <details className="audio-runtime-settings">
              <summary>
                <StorageFolderIcon />
                <strong>Runtime settings</strong>
                <span>Local model cache</span>
              </summary>
              <label className="audio-runtime-path">
                <span className="audio-runtime-path-label">
                  <StorageFolderIcon />
                  Model Cache
                </span>
                <input
                  type="text"
                  value={modelCachePath}
                  aria-label="Audio model cache path"
                  onChange={(event) => setModelCachePath(event.currentTarget.value)}
                />
              </label>
            </details>
          </section>

          <section className="audio-workflow-section" aria-label="Audio AI workflows">
            <div className="audio-section-heading">
              <span className="icon-tool" aria-hidden="true">
                <PlayIcon />
              </span>
              <div>
                <strong>Choose a workflow</strong>
                <span>Start with a focused audio preset</span>
              </div>
            </div>
            <div
              className="audio-workflow-pickers"
              role="group"
              aria-label="Audio workflow presets"
            >
              {AUDIO_WORKFLOW_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="audio-workflow-button"
                  aria-pressed={preset.id === selectedWorkflow.id}
                  title={preset.command}
                  onClick={() => setWorkflowId(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="audio-workflow-card">
              <div className="audio-workflow-card-heading">
                <div>
                  <strong>{selectedWorkflow.label}</strong>
                  <span>{selectedWorkflow.steps.length} steps · local estimate</span>
                </div>
                <p className="audio-workflow-command">“{selectedWorkflow.command}”</p>
              </div>
              <ol
                className="audio-workflow-steps"
                aria-label={`${selectedWorkflow.label} workflow path`}
              >
                {workflowGraph.nodes.map((node, index) => (
                  <li key={node.id}>
                    <span className="audio-workflow-step-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span>{node.label}</span>
                  </li>
                ))}
              </ol>
              <div className="audio-workflow-footer">
                <div className="audio-workflow-resources" aria-label="Workflow resource estimate">
                  <ResourcePill value={`${workflowResources.ramGb}G`} label="RAM" />
                  <ResourcePill value={`${workflowResources.vramGb}G`} label="VRAM" />
                  <ResourcePill value={`${workflowResources.diskGb}G`} label="Disk" />
                  <ResourcePill value={String(workflowResources.modelCount)} label="models" />
                </div>
                <div className="audio-run-action">
                  <span className="audio-run-readiness" id={runReadinessId}>
                    Pair local worker to run
                  </span>
                  <button
                    type="button"
                    className="audio-run-button"
                    aria-label={`Run ${selectedWorkflow.label} locally`}
                    aria-describedby={runReadinessId}
                    title={localWorkerReady ? 'Run on local worker' : 'Pair local worker to run'}
                    disabled={!localWorkerReady}
                  >
                    Run locally
                  </button>
                </div>
              </div>
            </div>
          </section>

          <details className="audio-capability-library">
            <summary>
              <span className="icon-tool" aria-hidden="true">
                <SlidersIcon />
              </span>
              <strong>Capability Library</strong>
              <span>{AUDIO_ATOMIC_CAPABILITIES.length} capabilities</span>
              <small>Browse the building blocks behind each workflow</small>
            </summary>
            <div className="audio-capability-section" aria-label="Audio capabilities">
              <div
                className="audio-capability-filters"
                role="group"
                aria-label="Filter capabilities by target"
              >
                {CAPABILITY_FILTERS.map((filter) => {
                  const count =
                    filter.id === 'all'
                      ? AUDIO_ATOMIC_CAPABILITIES.length
                      : AUDIO_ATOMIC_CAPABILITIES.filter(({ target }) => target === filter.id)
                          .length;
                  return (
                    <button
                      key={filter.id}
                      type="button"
                      className="audio-capability-filter"
                      aria-label={`${filter.label}: ${count} ${count === 1 ? 'capability' : 'capabilities'}`}
                      aria-pressed={capabilityFilter === filter.id}
                      onClick={() => setCapabilityFilter(filter.id)}
                    >
                      {filter.label}
                      <span aria-hidden="true">{count}</span>
                    </button>
                  );
                })}
              </div>
              <ul className="audio-capability-grid">
                {visibleCapabilities.map((capability) => (
                  <CapabilityTile key={capability.id} capability={capability} />
                ))}
              </ul>
            </div>
          </details>
        </div>
      )}

      {tab === 'models' && (
        <div className="audio-model-manager">
          <section className="audio-model-summary" aria-label="Audio model manager">
            <div>
              <span className="icon-tool" aria-hidden="true">
                <AudioIcon />
              </span>
              <strong>Audio Models</strong>
            </div>
            <ResourcePill value={String(AUDIO_MODEL_CATALOG.length)} label="models" />
            <ResourcePill value={modelCachePath} label="cache" />
          </section>
          <ul className="audio-model-list">
            {AUDIO_MODEL_CATALOG.map((model) => (
              <ModelRow key={model.id} model={model} />
            ))}
          </ul>
        </div>
      )}

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
        (noClips ? ['-'] : clipIds).map((clipId) => {
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
                  {clipId.length > 14 ? `${clipId.slice(0, 12)}...` : clipId}
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
