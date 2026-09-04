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
  CloseIcon,
  CloudIcon,
  DeviceProcessorIcon,
  DownloadIcon,
  LayersIcon,
  MasterBusIcon,
  MuteIcon,
  SlidersIcon,
  SoloIcon,
  SpeakerOnIcon,
  StorageFolderIcon,
  TuningIcon,
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
  audioExecutionTargetLabel,
  buildAudioWorkflowGraph,
  buildAudioWorkflowExecutionPlan,
  getAudioCapability,
  summarizeLocalAudioResources,
  type AudioAtomicCapability,
  type AudioEnhanceScopeId,
  type AudioExecutionTarget,
  type AudioModelSpec,
} from './audio-studio-runtime.js';
import { ensureClipAudio } from './audio-session.js';
import { audioKeyframeState, audioKeyframeTransaction } from './audio-keyframes.js';
import { PropertyRow } from './components/PropertyRow.js';
import { BoundedPollingLoop } from './bounded-polling.js';
import { createJoyMediaJobBridge } from './joy-agent/media-job-bridge.js';

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
  { id: 'vps-orchestrated', label: 'Remote Provider' },
];

interface AudioPanelProps {
  readonly clipIds: readonly string[];
  readonly enhanceScopes?: readonly AudioEnhanceScopeOption[];
  readonly audioState: AudioState;
  readonly onAudioChange: (next: AudioState, label: string) => void;
  /** Shared durable animation map; omitted in simple/read-only embeddings. */
  readonly project?: Pick<JoyProjectV1, 'propertyAnimations'>;
  readonly playheadUs?: number;
  readonly onDispatch?: (transaction: VisualObjectTransaction) => void;
  readonly onRunBrowserDsp?: (
    workflowId: string,
    clipIds: readonly string[],
  ) => void | Promise<void>;
  readonly onRunLocalWorker?: (workflowId: string) => void | Promise<void>;
  readonly onRunRemoteMediaJob?: (workflowId: string) => void | Promise<void>;
}

export interface AudioEnhanceScopeOption {
  readonly id: AudioEnhanceScopeId;
  readonly label: string;
  readonly description: string;
  readonly clipIds: readonly string[];
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

function installLabel(state: AudioModelSpec['installState']): string {
  switch (state) {
    case 'installed':
      return 'Installed';
    case 'available':
      return 'Download';
    case 'setup-required':
      return 'Runtime setup required';
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

/**
 * Select a recent paired Worker that actually advertises the audio denoise
 * capability. The API may return several connected Workers (for example a
 * render Worker alongside an audio Worker); choosing the first record makes
 * readiness depend on list ordering and incorrectly reports a capable Worker
 * as missing.
 */
export function selectConnectedAudioWorker(
  workers: readonly BrowserWorker[],
  now = Date.now(),
): BrowserWorker | undefined {
  return workers.find(
    (worker) =>
      worker.paired &&
      !worker.revoked &&
      worker.lastSeenAt !== undefined &&
      now - worker.lastSeenAt < 35_000 &&
      worker.capabilities.includes('audio.ml-denoise'),
  );
}

function AudioWorkflowStepIcon({
  capabilityId,
}: {
  readonly capabilityId: AudioAtomicCapability['id'];
}) {
  switch (capabilityId) {
    case 'audio.eq':
      return <TuningIcon />;
    case 'audio.compress':
    case 'audio.limit':
    case 'audio.normalize':
    case 'audio.mix':
    case 'audio.master':
      return <MasterBusIcon />;
    case 'audio.clone_voice':
    case 'audio.tts':
    case 'audio.convert_voice':
      return <AudioIcon />;
    default:
      return <AudioWorkerIcon />;
  }
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
        <span>{audioExecutionTargetLabel(capability.target)}</span>
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
  enhanceScopes,
  audioState,
  onAudioChange,
  project,
  playheadUs = 0,
  onDispatch,
  onRunBrowserDsp,
  onRunLocalWorker,
  onRunRemoteMediaJob,
}: AudioPanelProps) {
  const [tab, setTab] = useState('enhance');
  const [workflowId, setWorkflowId] = useState(AUDIO_WORKFLOW_PRESETS[0]!.id);
  const [scopeId, setScopeId] = useState<AudioEnhanceScopeId>('timeline');
  const [device, setDevice] = useState<'gpu' | 'cpu'>('gpu');
  const [modelCachePath, setModelCachePath] = useState(DEFAULT_MODEL_CACHE_PATH);
  const [capabilityFilter, setCapabilityFilter] = useState<CapabilityFilter>('all');
  const [workers, setWorkers] = useState<readonly BrowserWorker[]>([]);
  const [providers, setProviders] = useState<readonly BrowserReasoningProvider[]>([]);
  const [remoteConfirmWorkflowId, setRemoteConfirmWorkflowId] = useState<string | null>(null);
  const [runningTarget, setRunningTarget] = useState<AudioExecutionTarget | null>(null);
  const [reviewingWorkflow, setReviewingWorkflow] = useState<string | null>(null);
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
      if (workerResult.status === 'rejected' && providerResult.status === 'rejected') {
        throw workerResult.reason ?? providerResult.reason;
      }
    };
    const polling = new BoundedPollingLoop(refreshRuntime);
    const syncVisibility = () => {
      void polling.setVisible(document.visibilityState === 'visible').catch(() => undefined);
    };
    document.addEventListener('visibilitychange', syncVisibility);
    syncVisibility();
    polling.start();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', syncVisibility);
      polling.stop();
    };
  }, [client]);
  useEffect(() => {
    if (remoteConfirmWorkflowId === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRemoteConfirmWorkflowId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [remoteConfirmWorkflowId]);
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
  const resolvedEnhanceScopes = useMemo<readonly AudioEnhanceScopeOption[]>(
    () =>
      enhanceScopes ?? [
        {
          id: 'selection',
          label: 'Selected',
          description: 'Select timeline clips to target them directly.',
          clipIds: [],
        },
        {
          id: 'track',
          label: 'Track',
          description: 'Select a timeline clip to target its track.',
          clipIds: [],
        },
        {
          id: 'timeline',
          label: 'Timeline',
          description: `${clipIds.length} timeline clip${clipIds.length === 1 ? '' : 's'}`,
          clipIds,
        },
      ],
    [clipIds, enhanceScopes],
  );
  const selectedScope =
    resolvedEnhanceScopes.find((scope) => scope.id === scopeId) ??
    resolvedEnhanceScopes.find((scope) => scope.id === 'timeline') ??
    resolvedEnhanceScopes[0]!;
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
  const connectedWorker = selectConnectedAudioWorker(workers, now);
  const localWorkerReady = connectedWorker !== undefined;
  const hasRecentPairedWorker = workers.some(
    (worker) =>
      worker.paired &&
      !worker.revoked &&
      worker.lastSeenAt !== undefined &&
      now - worker.lastSeenAt < 35_000,
  );
  const localWorkerLabel = localWorkerReady
    ? 'Connected'
    : hasRecentPairedWorker
      ? 'Missing audio.ml-denoise'
      : 'Disconnected';
  const remoteProvider = providers.find(
    (provider) => provider.state === 'healthy' || provider.state === 'configured',
  );
  const remoteProviderLabel = remoteProvider === undefined ? 'Unavailable' : 'Online';
  const browserDspReady = selectedScope.clipIds.length > 0 && onRunBrowserDsp !== undefined;
  const localRunReady =
    selectedScope.clipIds.length > 0 && localWorkerReady && onRunLocalWorker !== undefined;
  const remoteRunReady =
    selectedScope.clipIds.length > 0 &&
    remoteProvider !== undefined &&
    onRunRemoteMediaJob !== undefined;
  const runReadinessId = `audio-${selectedWorkflow.id}-runtime-readiness`;
  const remoteConfirmWorkflow = AUDIO_WORKFLOW_PRESETS.find(
    (workflow) => workflow.id === remoteConfirmWorkflowId,
  );
  const executionPlan = useMemo(
    () =>
      buildAudioWorkflowExecutionPlan(selectedWorkflow.id, {
        browserDsp: browserDspReady,
        localWorker: localWorkerReady && onRunLocalWorker !== undefined,
        remoteProvider: remoteProvider !== undefined && onRunRemoteMediaJob !== undefined,
      }),
    [
      browserDspReady,
      remoteProvider,
      localWorkerReady,
      onRunRemoteMediaJob,
      onRunLocalWorker,
      selectedWorkflow.id,
    ],
  );
  const applyBrowserWorkflow = async () => {
    if (
      onRunBrowserDsp === undefined ||
      !executionPlan.browserDspRunnable ||
      selectedScope.clipIds.length === 0 ||
      runningTarget !== null
    )
      return;
    setRunError(null);
    setRunningTarget('browser-dsp');
    try {
      await onRunBrowserDsp(selectedWorkflow.id, selectedScope.clipIds);
      setReviewingWorkflow(null);
    } catch (error) {
      console.warn('browser audio workflow rejected', error);
      setRunError(error instanceof Error ? error.message : 'Could not apply Browser DSP workflow');
    } finally {
      setRunningTarget(null);
    }
  };
  const runExternalWorkflow = async (
    target: 'local-worker' | 'vps-orchestrated',
    workflow: string,
    callback: ((workflowId: string) => void | Promise<void>) | undefined,
  ) => {
    if (callback === undefined || runningTarget !== null) return;
    setRunError(null);
    setRunningTarget(target);
    try {
      if (target === 'vps-orchestrated') {
        const bridge = createJoyMediaJobBridge({
          submit: async (request) => {
            await callback(request.jobId);
          },
        });
        await bridge.submit({
          jobId: workflow,
          kind: 'audio',
          providerId: remoteProvider?.providerId ?? '',
          remoteUpload: true,
          // This path is reached only from the explicit confirmation dialog.
          approved: true,
        });
      } else {
        await callback(workflow);
      }
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
        <div className="audio-studio-stack audio-enhance-workspace">
          <section className="audio-enhance-target" aria-label="Enhance target">
            <div className="audio-enhance-target-heading">
              <div className="audio-enhance-heading-main">
                <span className="icon-tool audio-enhance-heading-icon" aria-hidden="true">
                  <LayersIcon />
                </span>
                <div className="audio-enhance-target-copy">
                  <strong>Enhance target</strong>
                  <span>{selectedScope.description}</span>
                </div>
              </div>
              <span className="audio-source-status" data-state={noClips ? 'idle' : 'ready'}>
                {noClips
                  ? 'Add clips first'
                  : `${selectedScope.clipIds.length} clip${selectedScope.clipIds.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div
              className="audio-enhance-scope-options"
              role="group"
              aria-label="Enhancement scope"
            >
              {resolvedEnhanceScopes.map((scope) => (
                <button
                  key={scope.id}
                  type="button"
                  className="audio-enhance-scope-button"
                  aria-pressed={scope.id === selectedScope.id}
                  disabled={scope.clipIds.length === 0}
                  onClick={() => {
                    setScopeId(scope.id);
                    setReviewingWorkflow(null);
                  }}
                >
                  {scope.label}
                  <span>{scope.clipIds.length}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="audio-enhance-route-summary" aria-label="Enhancement runtime summary">
            <span data-state={browserDspReady ? 'ready' : 'blocked'}>
              <DeviceProcessorIcon />
              <span>Browser DSP {browserDspReady ? 'ready' : 'needs clips'}</span>
            </span>
            <span data-state={localWorkerReady ? 'ready' : 'blocked'}>
              <AudioWorkerIcon />
              <span>Local Worker {localWorkerReady ? 'connected' : 'disconnected'}</span>
            </span>
            <button
              type="button"
              className="icon-button audio-enhance-runtime-button"
              aria-label="Open Audio Runtime"
              title="Open Audio Runtime"
              data-guide="Open Runtime"
              onClick={() => setTab('runtime')}
            >
              <TuningIcon />
            </button>
          </section>

          <section className="audio-workflow-section" aria-label="Audio AI workflows">
            <div className="audio-section-heading">
              <span className="icon-tool audio-workflow-icon" aria-hidden="true">
                <WorkflowPathIcon />
              </span>
              <div>
                <strong>Choose an enhancement</strong>
                <span>Review exact coverage before audio is changed</span>
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
                <div className="audio-workflow-card-title">
                  <span className="icon-tool audio-workflow-card-icon" aria-hidden="true">
                    <AudioIcon />
                  </span>
                  <div className="audio-workflow-card-copy">
                    <strong>{selectedWorkflow.label}</strong>
                    <span>{selectedWorkflow.steps.length} processing steps</span>
                  </div>
                </div>
                <p className="audio-workflow-command">“{selectedWorkflow.command}”</p>
              </div>
              <ol
                className="audio-workflow-steps"
                aria-label={`${selectedWorkflow.label} workflow path`}
              >
                {workflowGraph.nodes.map((node, index) => (
                  <li key={node.id}>
                    <span className="audio-workflow-step-icon" aria-hidden="true">
                      <AudioWorkflowStepIcon capabilityId={node.id} />
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
              <div className="audio-workflow-resources" aria-label="Workflow resource estimate">
                {workflowResources.modelCount === 0 ? (
                  <ResourcePill value="Browser" label="DSP" />
                ) : (
                  <>
                    <ResourcePill value={`${workflowResources.ramGb}G`} label="RAM" />
                    <ResourcePill value={`${workflowResources.vramGb}G`} label="VRAM" />
                    <ResourcePill value={`${workflowResources.diskGb}G`} label="Disk" />
                    <ResourcePill value={String(workflowResources.modelCount)} label="models" />
                  </>
                )}
              </div>
              <section className="audio-execution-plan" aria-label="Processing plan">
                <div className="audio-execution-plan-heading">
                  <strong>Processing plan</strong>
                  <span data-state={executionPlan.blockedSteps === 0 ? 'ready' : 'blocked'}>
                    {executionPlan.readySteps}/{executionPlan.steps.length} ready
                  </span>
                </div>
                <ul>
                  {executionPlan.steps.map((step) => (
                    <li key={step.id} data-state={step.ready ? 'ready' : 'blocked'}>
                      <span>{step.label}</span>
                      <span>{audioExecutionTargetLabel(step.target)}</span>
                      <small>{step.ready ? 'Ready' : step.reason}</small>
                    </li>
                  ))}
                </ul>
              </section>
              <div className="audio-enhance-apply">
                {selectedScope.clipIds.length === 0 ? (
                  <span>Select a target with clips to continue.</span>
                ) : executionPlan.browserDspRunnable ? (
                  reviewingWorkflow === selectedWorkflow.id ? (
                    <div className="audio-enhance-review" data-audio-review>
                      <span>
                        Review: apply {selectedWorkflow.label} to {selectedScope.clipIds.length}{' '}
                        clip
                        {selectedScope.clipIds.length === 1 ? '' : 's'}.
                      </span>
                      <div>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Back to enhancement review"
                          title="Back to enhancement review"
                          data-guide="Back"
                          onClick={() => setReviewingWorkflow(null)}
                        >
                          <CloseIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-button icon-button-labeled is-primary"
                          aria-label={
                            runningTarget === 'browser-dsp' ? 'Applying changes' : 'Apply changes'
                          }
                          title={
                            runningTarget === 'browser-dsp' ? 'Applying changes' : 'Apply changes'
                          }
                          data-guide={
                            runningTarget === 'browser-dsp' ? 'Applying changes' : 'Apply changes'
                          }
                          disabled={runningTarget !== null}
                          onClick={() => void applyBrowserWorkflow()}
                        >
                          <CheckIcon />
                          <span>{runningTarget === 'browser-dsp' ? 'Applying…' : 'Apply'}</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="icon-button icon-button-labeled audio-enhance-primary"
                      aria-label="Review Voice Polish changes"
                      title="Review Voice Polish changes"
                      data-guide="Review changes"
                      data-audio-review-workflow
                      onClick={() => setReviewingWorkflow(selectedWorkflow.id)}
                    >
                      <SlidersIcon />
                      <span>Review</span>
                    </button>
                  )
                ) : (
                  <span>
                    This preset is not fully wired. Review the blocked steps or open Runtime.
                  </span>
                )}
                {runError !== null && (
                  <span className="audio-run-error" role="alert" data-audio-run-error>
                    {runError}
                  </span>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {tab === 'runtime' && (
        <div className="audio-model-manager audio-runtime-tab">
          <section className="audio-runtime-summary" aria-label="Runtime summary">
            <strong>Runtime readiness</strong>
            <span>Browser DSP: {clipIds.length > 0 ? 'Ready' : 'Needs clips'}</span>
            <span>Local Worker: {localWorkerLabel}</span>
            <span>Remote Provider: {remoteProviderLabel}</span>
          </section>
          <section className="audio-runtime-section" aria-label="Audio runtime controls">
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
                data-state={remoteProvider === undefined ? 'offline' : 'online'}
              >
                <span className="icon-tool" aria-hidden="true">
                  <CloudIcon />
                </span>
                <strong>Remote Provider</strong>
                <span>{remoteProviderLabel}</span>
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
            <div className="audio-run-action audio-runtime-run-action">
              <span className="audio-run-readiness" id={runReadinessId}>
                {selectedScope.clipIds.length === 0
                  ? 'Select clips in Enhance before routing audio'
                  : 'Run the selected enhancement on an external target'}
              </span>
              <div
                className="audio-route-actions"
                role="group"
                aria-label="Runtime execution target"
              >
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
                      void runExternalWorkflow(
                        'local-worker',
                        selectedWorkflow.id,
                        onRunLocalWorker,
                      );
                    }
                  }}
                >
                  {runningTarget === 'local-worker' ? 'Running…' : 'Run Local'}
                </button>
                <button
                  type="button"
                  className="audio-run-button"
                  data-audio-route="vps-orchestrated"
                  aria-label={`Run ${selectedWorkflow.label} with Remote Provider`}
                  aria-describedby={runReadinessId}
                  title={
                    remoteRunReady
                      ? `Confirm remote provider run with ${remoteProvider?.providerId ?? 'provider'}`
                      : remoteProvider === undefined
                        ? 'Configure a remote provider to run'
                        : 'Remote provider execution is not connected'
                  }
                  disabled={!remoteRunReady || runningTarget !== null}
                  onClick={() => {
                    if (remoteRunReady) setRemoteConfirmWorkflowId(selectedWorkflow.id);
                  }}
                >
                  {runningTarget === 'vps-orchestrated' ? 'Running…' : 'Run Cloud'}
                </button>
              </div>
              {runError !== null && (
                <span className="audio-run-error" role="alert" data-audio-run-error>
                  {runError}
                </span>
              )}
            </div>
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
          <details className="audio-capability-library">
            <summary>
              <span className="icon-tool" aria-hidden="true">
                <SlidersIcon />
              </span>
              <strong>Capability Library</strong>
              <span>{AUDIO_ATOMIC_CAPABILITIES.length} capabilities</span>
              <small>Browse routes and future building blocks</small>
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

      {remoteConfirmWorkflowId !== null && remoteConfirmWorkflow !== undefined && (
        <div className="audio-cloud-confirm-backdrop">
          <section
            className="audio-cloud-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audio-cloud-confirm-title"
            aria-describedby="audio-cloud-confirm-description"
            data-audio-cloud-confirmation
          >
            <h3 id="audio-cloud-confirm-title">Run with a remote provider?</h3>
            <p id="audio-cloud-confirm-description">
              {remoteConfirmWorkflow.label} sends selected audio to{' '}
              {remoteProvider?.providerId ?? 'the configured remote provider'} and may use paid
              credits.
            </p>
            <div className="audio-cloud-confirm-actions">
              <button type="button" onClick={() => setRemoteConfirmWorkflowId(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="is-primary"
                autoFocus
                onClick={() => {
                  const workflow = remoteConfirmWorkflowId;
                  setRemoteConfirmWorkflowId(null);
                  void runExternalWorkflow('vps-orchestrated', workflow, onRunRemoteMediaJob);
                }}
              >
                Run remote job
              </button>
            </div>
          </section>
        </div>
      )}

      {tab === 'mix' && master !== undefined && (
        <div className="audio-strip">
          <PropertyRow
            label="Master gain"
            value={master.gain.toFixed(2)}
            layout="inline"
            {...keyframe(audioBusPropertyBinding(master.id, 'gain'), master.gain, 'Master gain')}
          >
            <div className="audio-mix-control">
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
            </div>
          </PropertyRow>
          <PropertyRow
            label="Master pan"
            value={master.pan.toFixed(2)}
            layout="inline"
            {...keyframe(audioBusPropertyBinding(master.id, 'pan'), master.pan, 'Master pan')}
          >
            <div className="audio-mix-control">
              <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={master.pan}
                aria-label="Master pan"
                title="Master pan"
                onChange={(event) =>
                  dispatch(
                    {
                      type: 'audioBus.setPan',
                      payload: { busId: master.id, pan: event.currentTarget.valueAsNumber },
                    },
                    `Master pan ${event.currentTarget.valueAsNumber.toFixed(2)}`,
                  )
                }
              />
            </div>
          </PropertyRow>
          <PropertyRow
            label="Master mute"
            value={master.mute ? 'Muted' : 'Live'}
            layout="inline"
            {...keyframe(audioBusPropertyBinding(master.id, 'mute'), master.mute, 'Master mute')}
          >
            <button
              type="button"
              className="icon-button audio-mix-toggle"
              aria-pressed={master.mute}
              aria-label="Mute master bus"
              title="Mute master bus"
              data-guide="Mute master bus"
              onClick={() =>
                dispatch(
                  { type: 'audioBus.setMute', payload: { busId: master.id, mute: !master.mute } },
                  `Mute master bus`,
                )
              }
            >
              {master.mute ? <MuteIcon /> : <SpeakerOnIcon />}
            </button>
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
                  aria-pressed={clip.solo}
                  aria-label={`Solo ${clipId}`}
                  title={`Solo ${clipId}`}
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
                layout="inline"
                disabled={noClips}
                {...keyframe(audioClipPropertyBinding(clipId, 'gain'), clip.gain, 'Clip gain')}
              >
                <div className="audio-mix-control">
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
                </div>
              </PropertyRow>
              <PropertyRow
                label="Pan"
                value={clip.pan.toFixed(2)}
                layout="inline"
                disabled={noClips}
                {...keyframe(audioClipPropertyBinding(clipId, 'pan'), clip.pan, 'Clip pan')}
              >
                <div className="audio-mix-control">
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
                </div>
              </PropertyRow>
              <PropertyRow
                label="Mute"
                value={clip.mute ? 'Muted' : 'Live'}
                layout="inline"
                disabled={noClips}
                {...keyframe(audioClipPropertyBinding(clipId, 'mute'), clip.mute, 'Clip mute')}
              >
                <button
                  type="button"
                  className="icon-button audio-mix-toggle"
                  aria-pressed={clip.mute}
                  aria-label={`Mute ${clipId}`}
                  title={`Mute ${clipId}`}
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
              </PropertyRow>
              <PropertyRow label="Fade in" layout="inline" disabled={noClips}>
                <div className="audio-mix-control">
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
                  <span className="audio-mix-unit">ms</span>
                </div>
              </PropertyRow>
              <PropertyRow label="Fade out" layout="inline" disabled={noClips}>
                <div className="audio-mix-control">
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
                  <span className="audio-mix-unit">ms</span>
                </div>
              </PropertyRow>
              <div className="audio-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, clip.gain * 50)}%` }} />
              </div>
            </div>
          );
        })}
    </PanelShell>
  );
}
