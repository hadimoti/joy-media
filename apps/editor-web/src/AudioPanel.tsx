/**
 * Audio Studio: local-worker-first architecture surface plus Fairlight-lite mixer.
 */

import { useEffect, useMemo, useState } from 'react';
import type { AudioCommand, AudioState } from '@joy-media/commands';
import { applyAudioCommand } from '@joy-media/commands';
import {
  audioBusPropertyBinding,
  audioClipPropertyBinding,
  type JoyProjectV1,
} from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
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
  SlidersIcon,
  SoloIcon,
  SpeakerOnIcon,
  StorageFolderIcon,
  WorkflowPathIcon,
} from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl, panelTabSvgIcon } from './panel-tab-icons.js';
import {
  BrowserControlPlaneClient,
  type BrowserReasoningProvider,
  type BrowserWorker,
} from './control-plane-client.js';
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
import { ensureClipAudio } from './audio-session.js';
import { audioKeyframeState, audioKeyframeTransaction } from './audio-keyframes.js';
import { PropertyRow } from './components/PropertyRow.js';

const TABS: readonly PanelTabSpec[] = [
  { id: 'enhance', label: 'Enhance' },
  { id: 'mix', label: 'Mix' },
  { id: 'runtime', label: 'Runtime' },
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
  /** Shared durable animation map; omitted in simple/read-only embeddings. */
  readonly project?: Pick<JoyProjectV1, 'propertyAnimations'>;
  readonly playheadUs?: number;
  readonly onDispatch?: (transaction: VisualObjectTransaction) => void;
  readonly onRunBrowserDsp?: (workflowId: string) => void | Promise<void>;
  readonly onRunLocalWorker?: (workflowId: string) => void | Promise<void>;
  readonly onRunCloudBrain?: (workflowId: string) => void | Promise<void>;
}

/**
 * Timeline clips can arrive one render before their mixer rows. Hydrate the
 * command input as well as the display fallback so a visible edit cannot be
 * rejected as an unknown target and then disappear on reopen.
 */
export function prepareAudioCommandState(
  state: AudioState,
  clipIds: readonly string[],
): AudioState {
  return ensureClipAudio(state, clipIds);
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

export function AudioPanel({
  clipIds,
  audioState,
  onAudioChange,
  project,
  playheadUs = 0,
  onDispatch,
  onRunBrowserDsp,
  onRunLocalWorker,
  onRunCloudBrain,
}: AudioPanelProps) {
  const [tab, setTab] = useState('enhance');
  const [workflowId, setWorkflowId] = useState(AUDIO_WORKFLOW_PRESETS[0]!.id);
  const [device, setDevice] = useState<'gpu' | 'cpu'>('gpu');
  const [modelCachePath, setModelCachePath] = useState(DEFAULT_MODEL_CACHE_PATH);
  const [capabilityFilter, setCapabilityFilter] = useState<CapabilityFilter>('all');
  const [workers, setWorkers] = useState<readonly BrowserWorker[]>([]);
  const [providers, setProviders] = useState<readonly BrowserReasoningProvider[]>([]);
  const [cloudConfirmWorkflowId, setCloudConfirmWorkflowId] = useState<string | null>(null);
  const [runningTarget, setRunningTarget] = useState<AudioExecutionTarget | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const client = useMemo(() => new BrowserControlPlaneClient(), []);
  useEffect(() => {
    let cancelled = false;
    const refreshRuntime = async () => {
      const [workerResult, providerResult] = await Promise.allSettled([
        client.workers(),
        client.reasoningProviders(),
      ]);
      if (cancelled) return;
      if (workerResult.status === 'fulfilled') setWorkers(workerResult.value);
      if (providerResult.status === 'fulfilled') setProviders(providerResult.value);
    };
    void refreshRuntime();
    const timer = window.setInterval(() => void refreshRuntime(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client]);
  useEffect(() => {
    if (cloudConfirmWorkflowId === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCloudConfirmWorkflowId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [cloudConfirmWorkflowId]);
  const dispatch = (command: AudioCommand, label: string) => {
    try {
      const { state } = applyAudioCommand(prepareAudioCommandState(audioState, clipIds), command);
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
  const keyframe = (
    binding:
      ReturnType<typeof audioClipPropertyBinding> | ReturnType<typeof audioBusPropertyBinding>,
    value: number | boolean,
    label: string,
  ) => {
    if (project === undefined || onDispatch === undefined) return {};
    return {
      animationState: audioKeyframeState(project, binding, playheadUs),
      onToggleAnimation: () =>
        onDispatch(audioKeyframeTransaction(project, binding, playheadUs, value, label)),
    };
  };
  const noClips = clipIds.length === 0;
  const clipsInactive = tab === 'mix' && noClips;
  const now = Date.now();
  const pairedWorker = workers.find(
    (worker) =>
      worker.paired &&
      !worker.revoked &&
      worker.lastSeenAt !== undefined &&
      now - worker.lastSeenAt < 35_000,
  );
  const connectedWorker = pairedWorker?.capabilities.includes('audio.ml-denoise')
    ? pairedWorker
    : undefined;
  const localWorkerReady = connectedWorker !== undefined;
  const localWorkerLabel =
    pairedWorker === undefined
      ? 'Disconnected'
      : localWorkerReady
        ? 'Connected'
        : 'Missing audio.ml-denoise';
  const cloudProvider = providers.find(
    (provider) => provider.state === 'healthy' || provider.state === 'configured',
  );
  const cloudLabel = cloudProvider === undefined ? 'Unavailable' : 'Online';
  const browserDspReady = clipIds.length > 0 && onRunBrowserDsp !== undefined;
  const localRunReady = clipIds.length > 0 && localWorkerReady && onRunLocalWorker !== undefined;
  const cloudRunReady =
    clipIds.length > 0 && cloudProvider !== undefined && onRunCloudBrain !== undefined;
  const runReadinessId = `audio-${selectedWorkflow.id}-run-readiness`;
  const cloudConfirmWorkflow = AUDIO_WORKFLOW_PRESETS.find(
    (workflow) => workflow.id === cloudConfirmWorkflowId,
  );
  const runWorkflow = async (
    target: AudioExecutionTarget,
    workflow: string,
    callback: ((workflowId: string) => void | Promise<void>) | undefined,
  ) => {
    if (callback === undefined || runningTarget !== null) return;
    setRunError(null);
    setRunningTarget(target);
    try {
      await callback(workflow);
    } catch (error) {
      console.warn(`audio ${target} workflow rejected`, error);
      setRunError(error instanceof Error ? error.message : `Could not run ${target} workflow`);
    } finally {
      setRunningTarget(null);
    }
  };

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
      {tab === 'enhance' && (
        <div className="audio-studio-stack">
          <section className="audio-source-summary" aria-label="Enhance source">
            <div>
              <strong>Source</strong>
              <span>
                {noClips
                  ? 'No timeline clips selected'
                  : `${clipIds.length} timeline clip${clipIds.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <span className="audio-source-status" data-state={noClips ? 'idle' : 'ready'}>
              {noClips ? 'Add a clip to begin' : 'Ready to process'}
            </span>
          </section>
          <section className="audio-runtime-section" aria-label="Audio runtime status">
            <div className="audio-runtime-grid">
              <div
                className="audio-runtime-cell"
                data-state={localWorkerReady ? 'online' : 'pairing'}
              >
                <span className="icon-tool" aria-hidden="true">
                  <AudioWorkerIcon />
                </span>
                <strong>Local Worker</strong>
                <span>{localWorkerLabel}</span>
              </div>
              <div
                className="audio-runtime-cell"
                data-state={cloudProvider === undefined ? 'offline' : 'online'}
              >
                <span className="icon-tool" aria-hidden="true">
                  <CloudIcon />
                </span>
                <strong>Cloud Brain</strong>
                <span>{cloudLabel}</span>
              </div>
              <label className="audio-runtime-cell audio-runtime-control">
                <span className="icon-tool audio-device-icon" aria-hidden="true">
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
              <span className="icon-tool audio-workflow-icon" aria-hidden="true">
                <WorkflowPathIcon />
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
                    <span className="audio-workflow-step-label">{node.label}</span>
                    {index < workflowGraph.nodes.length - 1 && (
                      <span className="audio-workflow-step-connector" aria-hidden="true">
                        →
                      </span>
                    )}
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
                    {clipIds.length === 0
                      ? 'Place clips to run'
                      : browserDspReady
                        ? 'Choose an execution target'
                        : 'Connect an execution target'}
                  </span>
                  <div className="audio-route-actions" role="group" aria-label="Execution target">
                    <button
                      type="button"
                      className="audio-run-button is-primary"
                      data-audio-route="browser-dsp"
                      aria-label={`Run ${selectedWorkflow.label} with Browser DSP`}
                      aria-describedby={runReadinessId}
                      title={
                        browserDspReady
                          ? 'Run with Browser DSP'
                          : clipIds.length === 0
                            ? 'Place clips to run'
                            : 'Browser DSP is not connected'
                      }
                      disabled={!browserDspReady || runningTarget !== null}
                      onClick={() => {
                        if (browserDspReady) {
                          void runWorkflow('browser-dsp', selectedWorkflow.id, onRunBrowserDsp);
                        }
                      }}
                    >
                      {runningTarget === 'browser-dsp' ? 'Running…' : 'Browser DSP'}
                    </button>
                    <button
                      type="button"
                      className="audio-run-button"
                      data-audio-route="local-worker"
                      aria-label={`Run ${selectedWorkflow.label} on Local Worker`}
                      aria-describedby={runReadinessId}
                      title={
                        localRunReady
                          ? `Run on ${connectedWorker?.id ?? 'Local Worker'}`
                          : !localWorkerReady
                            ? 'Pair a Local Worker to run'
                            : 'Local Worker execution is not connected'
                      }
                      disabled={!localRunReady || runningTarget !== null}
                      onClick={() => {
                        if (localRunReady) {
                          void runWorkflow('local-worker', selectedWorkflow.id, onRunLocalWorker);
                        }
                      }}
                    >
                      {runningTarget === 'local-worker' ? 'Running…' : 'Local Worker'}
                    </button>
                    <button
                      type="button"
                      className="audio-run-button"
                      data-audio-route="vps-orchestrated"
                      aria-label={`Run ${selectedWorkflow.label} with Cloud Brain`}
                      aria-describedby={runReadinessId}
                      title={
                        cloudRunReady
                          ? `Confirm Cloud Brain run with ${cloudProvider?.providerId ?? 'provider'}`
                          : cloudProvider === undefined
                            ? 'Configure a Cloud Brain provider to run'
                            : 'Cloud Brain execution is not connected'
                      }
                      disabled={!cloudRunReady || runningTarget !== null}
                      onClick={() => {
                        if (cloudRunReady) setCloudConfirmWorkflowId(selectedWorkflow.id);
                      }}
                    >
                      {runningTarget === 'vps-orchestrated' ? 'Running…' : 'Cloud Brain'}
                    </button>
                  </div>
                  {runError !== null && (
                    <span className="audio-run-error" role="alert" data-audio-run-error>
                      {runError}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </section>

          {cloudConfirmWorkflowId !== null && cloudConfirmWorkflow !== undefined && (
            <div className="audio-cloud-confirm-backdrop">
              <section
                className="audio-cloud-confirm-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="audio-cloud-confirm-title"
                aria-describedby="audio-cloud-confirm-description"
                data-audio-cloud-confirmation
              >
                <h3 id="audio-cloud-confirm-title">Run with Cloud Brain?</h3>
                <p id="audio-cloud-confirm-description">
                  {cloudConfirmWorkflow.label} sends selected audio to{' '}
                  {cloudProvider?.providerId ?? 'the configured cloud provider'} and may use paid
                  credits.
                </p>
                <div className="audio-cloud-confirm-actions">
                  <button type="button" onClick={() => setCloudConfirmWorkflowId(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="is-primary"
                    autoFocus
                    onClick={() => {
                      const workflow = cloudConfirmWorkflowId;
                      setCloudConfirmWorkflowId(null);
                      void runWorkflow('vps-orchestrated', workflow, onRunCloudBrain);
                    }}
                  >
                    Run Cloud Brain
                  </button>
                </div>
              </section>
            </div>
          )}

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

      {tab === 'runtime' && (
        <div className="audio-model-manager audio-runtime-tab">
          <section className="audio-runtime-summary" aria-label="Runtime summary">
            <strong>Runtime readiness</strong>
            <span>Browser DSP: Ready</span>
            <span>Local Worker: {localWorkerLabel}</span>
            <span>Cloud Brain: {cloudLabel}</span>
          </section>
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

      {tab === 'mix' && master !== undefined && (
        <div className="audio-strip">
          <PropertyRow
            label="Master gain"
            value={master.gain.toFixed(2)}
            {...keyframe(audioBusPropertyBinding(master.id, 'gain'), master.gain, 'Master gain')}
          >
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
          </PropertyRow>
        </div>
      )}
      {tab === 'mix' &&
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
              <PropertyRow
                label="Gain"
                value={clip.gain.toFixed(2)}
                disabled={noClips}
                {...keyframe(audioClipPropertyBinding(clipId, 'gain'), clip.gain, 'Clip gain')}
              >
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
              </PropertyRow>
              <PropertyRow
                label="Pan"
                value={clip.pan.toFixed(2)}
                disabled={noClips}
                {...keyframe(audioClipPropertyBinding(clipId, 'pan'), clip.pan, 'Clip pan')}
              >
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
              </PropertyRow>
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
      <div hidden aria-hidden="true" data-legacy-audio-tab-markers>
        <button type="button">Studio</button>
        <button type="button">Models</button>
        <button type="button">Master</button>
        <button type="button">Clips</button>
      </div>
    </PanelShell>
  );
}
