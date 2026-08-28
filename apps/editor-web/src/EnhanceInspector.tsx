import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserJob, BrowserWorker } from './control-plane-client.js';
import { BrowserControlPlaneClient } from './control-plane-client.js';
import { BoundedPollingLoop } from './bounded-polling.js';
import { AiEffectIcon } from './icons.js';
import { upscaleJobPayload, type UpscaleSettings, type UpscaleTarget } from './upscaling.js';

export interface EnhanceInspectorProps {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly target: UpscaleTarget;
  readonly settings: UpscaleSettings;
  readonly onChange: (next: UpscaleSettings) => void;
  readonly onApplyResult: (job: BrowserJob, settings: UpscaleSettings) => Promise<string>;
  readonly client?: BrowserControlPlaneClient;
}

type EnhanceRuntimeState = 'ready' | 'source-missing' | 'model-missing' | 'offline';

interface EnhanceRuntimeStatus {
  readonly state: EnhanceRuntimeState;
  readonly label: string;
  readonly title: string;
}

const WORKER_FRESHNESS_MS = 35_000;

function runtimeStatus(
  target: UpscaleTarget,
  workers: readonly BrowserWorker[],
  nowMs = Date.now(),
): EnhanceRuntimeStatus {
  const capability = target.kind === 'image' ? 'upscale.image' : 'upscale.video';
  const paired = workers.filter((worker) => worker.paired && !worker.revoked);
  const online = paired.filter(
    (worker) =>
      worker.lastSeenAt !== undefined &&
      nowMs - worker.lastSeenAt >= 0 &&
      nowMs - worker.lastSeenAt < WORKER_FRESHNESS_MS,
  );
  const capable = online.filter((worker) => worker.capabilities.includes(capability));
  if (capable.some((worker) => (worker.localAssetIds ?? []).includes(target.assetId))) {
    return {
      state: 'ready',
      label: target.kind === 'image' ? 'Photo Worker ready' : 'Video Worker ready',
      title: 'A capable Local Worker has the selected source.',
    };
  }
  if (capable.length > 0)
    return {
      state: 'source-missing',
      label: 'Worker ready · source missing',
      title: 'The selected source is not available on a capable Local Worker.',
    };
  if (online.length > 0)
    return {
      state: 'model-missing',
      label: target.kind === 'image' ? 'Add an image upscaler' : 'Add a video upscaler',
      title: `No online Worker advertises ${capability}.`,
    };
  return {
    state: 'offline',
    label: 'Local Worker offline',
    title:
      paired.length > 0
        ? 'A paired Worker has not checked in recently.'
        : 'Pair a Local Worker to upscale locally.',
  };
}

function statusClass(state: EnhanceRuntimeState): string {
  return `enhance-runtime-state enhance-runtime-state--${state}`;
}

export function EnhanceInspector({
  projectId,
  projectTitle,
  target,
  settings,
  onChange,
  onApplyResult,
  client: suppliedClient,
}: EnhanceInspectorProps) {
  const client = useMemo(() => suppliedClient ?? new BrowserControlPlaneClient(), [suppliedClient]);
  const [workers, setWorkers] = useState<readonly BrowserWorker[]>([]);
  const [running, setRunning] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | undefined>();
  const appliedJobRef = useRef<string | undefined>(
    settings.lastJob?.resultAssetId ? settings.lastJob.id : undefined,
  );
  const settingsRef = useRef(settings);
  const callbacksRef = useRef({ onChange, onApplyResult });

  useEffect(() => {
    settingsRef.current = settings;
    callbacksRef.current = { onChange, onApplyResult };
    if (settings.lastJob?.resultAssetId !== undefined) appliedJobRef.current = settings.lastJob.id;
  }, [onApplyResult, onChange, settings]);

  const refreshWorkers = useCallback(async () => {
    try {
      setWorkers(await client.workers());
      setRuntimeError(undefined);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : 'Worker status unavailable');
      throw error;
    }
  }, [client]);

  useEffect(() => {
    const polling = new BoundedPollingLoop(refreshWorkers);
    const syncVisibility = () => {
      void polling.setVisible(document.visibilityState === 'visible').catch(() => undefined);
    };
    document.addEventListener('visibilitychange', syncVisibility);
    syncVisibility();
    polling.start();
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      polling.stop();
    };
  }, [refreshWorkers]);

  const runtime = runtimeStatus(target, workers);
  const jobId = settings.lastJob?.id;
  useEffect(() => {
    if (jobId === undefined || settings.lastJob?.resultAssetId !== undefined) return;
    let cancelled = false;
    const pollingRef: { current?: BoundedPollingLoop } = {};
    const poll = async () => {
      try {
        const job = (await client.jobs(projectId)).find((candidate) => candidate.id === jobId);
        if (cancelled || job === undefined) return;
        const current = settingsRef.current;
        const next: UpscaleSettings = {
          ...current,
          lastJob: {
            id: job.id,
            state: job.state,
            progress: job.progress,
            ...(job.error === undefined ? {} : { error: job.error }),
          },
        };
        if (
          current.lastJob?.state !== next.lastJob?.state ||
          current.lastJob?.progress !== next.lastJob?.progress ||
          current.lastJob?.error !== next.lastJob?.error
        )
          callbacksRef.current.onChange(next);
        if (
          job.state === 'completed' &&
          job.derivative !== undefined &&
          appliedJobRef.current !== job.id
        ) {
          appliedJobRef.current = job.id;
          const resultAssetId = await callbacksRef.current.onApplyResult(job, next);
          if (!cancelled)
            callbacksRef.current.onChange({
              ...next,
              lastJob: { ...next.lastJob!, resultAssetId },
            });
        }
        if (job.state !== 'queued' && job.state !== 'leased') pollingRef.current?.stop();
      } catch (error) {
        if (!cancelled) setRuntimeError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    };
    const polling = new BoundedPollingLoop(poll);
    pollingRef.current = polling;
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
  }, [client, jobId, projectId, settings.lastJob?.resultAssetId]);

  const patch = (next: Partial<UpscaleSettings>) => onChange({ ...settings, ...next });
  const queue = async (purpose: 'preview' | 'full') => {
    if (runtime.state !== 'ready') return;
    setRunning(true);
    setRuntimeError(undefined);
    try {
      await client.ensureProject(projectId, projectTitle);
      const job = await client.enqueueUpscale(
        projectId,
        `upscale-${target.targetId}-${purpose}-${Date.now()}`,
        target.kind === 'image' ? 'upscale.image' : 'upscale.video',
        target.assetId,
        upscaleJobPayload(settings, target, purpose) as unknown as Readonly<
          Record<string, unknown>
        >,
      );
      appliedJobRef.current = undefined;
      onChange({ ...settings, lastJob: { id: job.id, state: job.state, progress: job.progress } });
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const cancel = async () => {
    if (settings.lastJob === undefined || !['queued', 'leased'].includes(settings.lastJob.state))
      return;
    try {
      const job = await client.cancel(projectId, settings.lastJob.id);
      onChange({
        ...settings,
        lastJob: {
          id: job.id,
          state: job.state,
          progress: job.progress,
          ...(job.error ? { error: job.error } : {}),
        },
      });
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    }
  };

  const modelLabel = workers
    .flatMap((worker) => worker.modelInventory?.models ?? [])
    .find((model) => model.modelId === 'realesrgan-x4plus');
  const job = settings.lastJob;
  return (
    <div className="enhance-inspector" aria-label="AI Enhance controls">
      <section className="inspector-section enhance-runtime-section">
        <div className="enhance-section-heading">
          <h3>
            <AiEffectIcon /> Enhance
          </h3>
          <span className={statusClass(runtime.state)} role="status" title={runtime.title}>
            <span aria-hidden="true" />
            {runtime.label}
          </span>
        </div>
        <div className="enhance-meta-row">
          <span>Model</span>
          <strong>{modelLabel?.modelId ?? 'Real-ESRGAN x4plus'}</strong>
          <span>Status</span>
          <strong>{modelLabel?.state ?? 'Not reported'}</strong>
        </div>
      </section>
      <section className="inspector-section enhance-controls-section">
        <div className="enhance-control-grid">
          <label>
            Preset
            <select
              value={settings.preset}
              onChange={(event) =>
                patch({ preset: event.currentTarget.value as UpscaleSettings['preset'] })
              }
            >
              <option value="fast">Fast</option>
              <option value="quality">Quality</option>
            </select>
          </label>
          <label>
            Scale
            <select
              value={settings.scale}
              onChange={(event) =>
                patch({ scale: Number(event.currentTarget.value) as UpscaleSettings['scale'] })
              }
            >
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
          </label>
          {target.kind === 'image' && (
            <label>
              Format
              <select
                value={settings.imageFormat}
                onChange={(event) =>
                  patch({
                    imageFormat: event.currentTarget.value as UpscaleSettings['imageFormat'],
                  })
                }
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
              </select>
            </label>
          )}
          <label>
            Memory
            <select
              value={settings.memoryMode}
              onChange={(event) =>
                patch({ memoryMode: event.currentTarget.value as UpscaleSettings['memoryMode'] })
              }
            >
              <option value="auto">Auto</option>
              <option value="low-vram">Low VRAM</option>
              <option value="maximum-quality">Max quality</option>
            </select>
          </label>
        </div>
        {target.kind === 'video' && (
          <label className="enhance-checkbox">
            <input
              type="checkbox"
              checked={settings.keepAudio}
              onChange={(event) => patch({ keepAudio: event.currentTarget.checked })}
            />{' '}
            Keep source audio
          </label>
        )}
      </section>
      <section className="inspector-section enhance-actions-section">
        {job !== undefined && (
          <div className="enhance-job-row">
            <span>{job.state === 'completed' ? 'Result ready' : `Job ${job.state}`}</span>
            <strong>{Math.round(job.progress)}%</strong>
          </div>
        )}
        <div className="enhance-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={runtime.state !== 'ready' || running}
            onClick={() => void queue('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={runtime.state !== 'ready' || running}
            onClick={() => void queue('full')}
          >
            {running ? 'Queueing…' : 'Enhance'}
          </button>
          {job !== undefined && ['queued', 'leased'].includes(job.state) && (
            <button type="button" className="button button-ghost" onClick={() => void cancel()}>
              Cancel
            </button>
          )}
        </div>
        {runtimeError !== undefined && (
          <p className="inspector-error" role="alert">
            {runtimeError}
          </p>
        )}
        {job?.error !== undefined && (
          <p className="inspector-error" role="alert">
            {job.error}
          </p>
        )}
      </section>
    </div>
  );
}
