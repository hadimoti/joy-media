import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserJob, BrowserWorker } from './control-plane-client.js';
import { BrowserControlPlaneClient } from './control-plane-client.js';
import {
  CloseIcon,
  MaskIcon,
  PointAddIcon,
  PointSubtractIcon,
  SelectionBoxIcon,
  SubjectIcon,
  TrackMaskIcon,
  TrashIcon,
} from './icons.js';
import { maskJobPayload, type MaskSettings, type MaskTarget } from './masking.js';

export interface MaskInspectorProps {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly target: MaskTarget;
  readonly settings: MaskSettings;
  readonly onChange: (next: MaskSettings) => void;
  readonly onApplyResult: (job: BrowserJob, settings: MaskSettings) => Promise<string>;
  readonly onClear: () => void;
  readonly client?: BrowserControlPlaneClient;
}

export type MaskRuntimeState = 'ready' | 'source-missing' | 'model-missing' | 'offline';

export interface MaskRuntimeStatus {
  readonly state: MaskRuntimeState;
  readonly label: string;
  readonly title: string;
}

/** Keep the Inspector's idea of a live Worker consistent with the Audio workspace. */
export const MASK_WORKER_FRESHNESS_MS = 35_000;

/**
 * A paired record is not evidence of a usable local runtime. A Worker must
 * have checked in recently, advertise the exact image/video capability, and
 * hold the selected source asset before the destructive-looking actions can
 * become enabled.
 */
export function maskRuntimeStatus(
  target: Pick<MaskTarget, 'kind' | 'assetId'>,
  workers: readonly BrowserWorker[],
  nowMs = Date.now(),
): MaskRuntimeStatus {
  const capability = target.kind === 'image' ? 'mask.image' : 'mask.video';
  const alternateCapability = target.kind === 'image' ? 'mask.video' : 'mask.image';
  const pairedWorkers = workers.filter((worker) => worker.paired && !worker.revoked);
  const onlineWorkers = pairedWorkers.filter(
    (worker) =>
      worker.lastSeenAt !== undefined &&
      nowMs - worker.lastSeenAt >= 0 &&
      nowMs - worker.lastSeenAt < MASK_WORKER_FRESHNESS_MS,
  );
  const capableWorkers = onlineWorkers.filter((worker) => worker.capabilities.includes(capability));
  const readyWorker = capableWorkers.find((worker) =>
    (worker.localAssetIds ?? []).includes(target.assetId),
  );

  if (readyWorker !== undefined) {
    const label = target.kind === 'image' ? 'Photo Worker ready' : 'Video Worker ready';
    return { state: 'ready', label, title: `${label} · selected source is local` };
  }
  if (capableWorkers.length > 0) {
    return {
      state: 'source-missing',
      label: 'Worker ready · source missing',
      title: 'The selected source is not available on a capable Local Worker',
    };
  }
  if (onlineWorkers.some((worker) => worker.capabilities.includes(alternateCapability))) {
    const label =
      target.kind === 'image'
        ? 'Video tracking ready · add image model'
        : 'Photo masks ready · add SAM 2';
    return { state: 'model-missing', label, title: label };
  }
  if (onlineWorkers.length > 0) {
    const label = target.kind === 'image' ? 'Add image masking model' : 'Add SAM 2 video tracking';
    return { state: 'model-missing', label, title: label };
  }
  return {
    state: 'offline',
    label: 'Local Worker offline',
    title:
      pairedWorkers.length > 0
        ? 'A paired Local Worker has not checked in recently'
        : 'Pair a Local Worker to enable masking',
  };
}

export function MaskInspector({
  projectId,
  projectTitle,
  target,
  settings,
  onChange,
  onApplyResult,
  onClear,
  client: suppliedClient,
}: MaskInspectorProps) {
  const client = useMemo(() => suppliedClient ?? new BrowserControlPlaneClient(), [suppliedClient]);
  const [workers, setWorkers] = useState<readonly BrowserWorker[]>([]);
  const [runtimeError, setRuntimeError] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [pointDraft, setPointDraft] = useState({ x: 0.5, y: 0.5 });
  const [pointLabel, setPointLabel] = useState<'foreground' | 'background'>('foreground');
  const appliedJobRef = useRef<string | undefined>(
    settings.lastJob?.resultAssetId === undefined ? undefined : settings.lastJob.id,
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
    }
  }, [client]);

  useEffect(() => {
    void refreshWorkers();
    const timer = window.setInterval(() => void refreshWorkers(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshWorkers]);

  const runtime = maskRuntimeStatus(target, workers);
  const runtimeState = runtime.state;

  useEffect(() => {
    const jobId = settings.lastJob?.id;
    if (jobId === undefined || settings.lastJob?.resultAssetId !== undefined) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const job = (await client.jobs(projectId)).find((candidate) => candidate.id === jobId);
        if (cancelled || job === undefined) return;
        const current = settingsRef.current;
        const next: MaskSettings = {
          ...current,
          lastJob: {
            id: job.id,
            state: job.state,
            progress: job.progress,
            ...(job.error === undefined ? {} : { error: job.error }),
            ...(current.lastJob?.resultAssetId === undefined
              ? {}
              : { resultAssetId: current.lastJob.resultAssetId }),
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
        if (job.state !== 'queued' && job.state !== 'leased') window.clearInterval(timer);
      } catch (error) {
        if (!cancelled) setRuntimeError(error instanceof Error ? error.message : String(error));
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, projectId, settings.lastJob?.id, settings.lastJob?.resultAssetId]);

  const patch = (next: Partial<MaskSettings>) => onChange({ ...settings, ...next });
  const patchSelection = (next: Partial<MaskSettings['selection']>) =>
    patch({ selection: { ...settings.selection, ...next } });
  const patchEdge = (next: Partial<MaskSettings['edge']>) =>
    patch({ edge: { ...settings.edge, ...next } });
  const queue = async (output: 'matte' | 'cutout') => {
    if (runtimeState !== 'ready') return;
    if (settings.selection.mode === 'prompt' && !settings.selection.prompt?.trim()) {
      setRuntimeError('Enter the subject to select.');
      return;
    }
    if (settings.selection.mode === 'points' && (settings.selection.points?.length ?? 0) === 0) {
      setRuntimeError('Add at least one foreground or background point.');
      return;
    }
    setRunning(true);
    setRuntimeError(undefined);
    try {
      await client.ensureProject(projectId, projectTitle);
      const id = maskJobId(target.targetId);
      const job = await client.enqueueMask(
        projectId,
        id,
        target.kind === 'image' ? 'mask.image' : 'mask.video',
        target.assetId,
        maskJobPayload(settings, output, target.playheadUs) as unknown as Readonly<
          Record<string, unknown>
        >,
      );
      appliedJobRef.current = undefined;
      onChange({
        ...settings,
        output,
        lastJob: { id: job.id, state: job.state, progress: job.progress },
      });
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };
  const cancel = async () => {
    const job = settings.lastJob;
    if (job === undefined || (job.state !== 'queued' && job.state !== 'leased')) return;
    setCanceling(true);
    setRuntimeError(undefined);
    try {
      const canceled = await client.cancel(projectId, job.id);
      onChange({
        ...settings,
        lastJob: {
          id: canceled.id,
          state: canceled.state,
          progress: canceled.progress,
          ...(canceled.error === undefined ? {} : { error: canceled.error }),
        },
      });
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setCanceling(false);
    }
  };

  const points = settings.selection.points ?? [];
  const box = settings.selection.box ?? { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
  return (
    <div className="mask-inspector" aria-label="Mask controls">
      <section className="inspector-section mask-runtime-section">
        <div className="mask-section-heading">
          <h3>Model</h3>
          <span
            className={`mask-runtime-state mask-runtime-state--${runtimeState}`}
            role="status"
            title={runtime.title}
          >
            <span aria-hidden="true" />
            {runtime.label}
          </span>
        </div>
        <select
          className="mask-select"
          aria-label="Masking model"
          value={settings.provider}
          onChange={(event) =>
            patch({ provider: event.currentTarget.value as MaskSettings['provider'] })
          }
        >
          <option value="auto">Auto · best installed</option>
          <option value="sam3">SAM 3.1 · prompt + tracking</option>
          <option value="sam2-grounded">SAM 2.1 + Grounding DINO</option>
          <option value="birefnet">BiRefNet · fine edges</option>
        </select>
      </section>

      <section className="inspector-section">
        <h3>Selection</h3>
        <div className="mask-choice-grid" role="group" aria-label="Subject selection mode">
          <MaskChoice
            active={settings.selection.mode === 'subject'}
            label="Subject"
            icon={<SubjectIcon />}
            onClick={() => patchSelection({ mode: 'subject' })}
          />
          <MaskChoice
            active={settings.selection.mode === 'person'}
            label="Person"
            icon={<MaskIcon />}
            onClick={() => patchSelection({ mode: 'person' })}
          />
          <MaskChoice
            active={settings.selection.mode === 'prompt'}
            label="Prompt"
            icon={<TrackMaskIcon />}
            onClick={() => patchSelection({ mode: 'prompt' })}
          />
        </div>
        {settings.selection.mode === 'prompt' && (
          <input
            className="mask-prompt-input"
            type="text"
            maxLength={500}
            value={settings.selection.prompt ?? ''}
            placeholder="e.g. the person in the yellow jacket"
            aria-label="Subject prompt"
            onChange={(event) => patchSelection({ prompt: event.currentTarget.value })}
          />
        )}
        <div className="mask-tool-row" role="group" aria-label="Mask refinement tool">
          <button
            type="button"
            className="icon-button icon-button-labeled"
            aria-pressed={settings.selection.mode === 'points' && pointLabel === 'foreground'}
            title="Foreground point"
            onClick={() => {
              setPointLabel('foreground');
              patchSelection({ mode: 'points' });
            }}
          >
            <PointAddIcon /> Add
          </button>
          <button
            type="button"
            className="icon-button icon-button-labeled"
            aria-pressed={settings.selection.mode === 'points' && pointLabel === 'background'}
            title="Background point"
            onClick={() => {
              setPointLabel('background');
              patchSelection({ mode: 'points' });
            }}
          >
            <PointSubtractIcon /> Subtract
          </button>
          <button
            type="button"
            className="icon-button icon-button-labeled"
            aria-pressed={settings.selection.mode === 'box'}
            title="Selection box"
            onClick={() => patchSelection({ mode: 'box', box })}
          >
            <SelectionBoxIcon /> Box
          </button>
        </div>
        {settings.selection.mode === 'points' && (
          <div className="mask-coordinate-editor">
            <Coordinate
              label="X"
              value={pointDraft.x}
              onChange={(x) => setPointDraft((p) => ({ ...p, x }))}
            />
            <Coordinate
              label="Y"
              value={pointDraft.y}
              onChange={(y) => setPointDraft((p) => ({ ...p, y }))}
            />
            <button
              type="button"
              className="icon-button icon-button-labeled"
              onClick={() =>
                patchSelection({
                  points: [...points, { ...pointDraft, label: pointLabel }].slice(-64),
                })
              }
            >
              {pointLabel === 'foreground' ? <PointAddIcon /> : <PointSubtractIcon />}
              {pointLabel === 'foreground' ? 'Keep' : 'Exclude'}
            </button>
            <span className="mask-point-count">{points.length} points</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Clear mask points"
              title="Clear points"
              disabled={points.length === 0}
              onClick={() => patchSelection({ points: [] })}
            >
              <TrashIcon />
            </button>
          </div>
        )}
        {settings.selection.mode === 'box' && (
          <div className="mask-box-grid">
            {(['x', 'y', 'width', 'height'] as const).map((key) => (
              <Coordinate
                key={key}
                label={key === 'width' ? 'W' : key === 'height' ? 'H' : key.toUpperCase()}
                value={box[key]}
                onChange={(value) => patchSelection({ box: nextMaskBox(box, key, value) })}
              />
            ))}
          </div>
        )}
      </section>

      <section className="inspector-section">
        <h3>Edge</h3>
        <MaskRange
          label="Feather"
          value={settings.edge.featherPx}
          min={0}
          max={100}
          unit="px"
          onChange={(featherPx) => patchEdge({ featherPx })}
        />
        <MaskRange
          label="Expand"
          value={settings.edge.expansionPx}
          min={-100}
          max={100}
          unit="px"
          onChange={(expansionPx) => patchEdge({ expansionPx })}
        />
        <MaskRange
          label="Detail"
          value={settings.edge.detail}
          min={0}
          max={1}
          step={0.01}
          onChange={(detail) => patchEdge({ detail })}
        />
        <div className="mask-switch-row">
          <label>
            <input
              type="checkbox"
              checked={settings.edge.decontaminate}
              onChange={(event) => patchEdge({ decontaminate: event.currentTarget.checked })}
            />{' '}
            Decontaminate
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.invert}
              onChange={(event) => patch({ invert: event.currentTarget.checked })}
            />{' '}
            Invert
          </label>
        </div>
      </section>

      {target.kind === 'video' && settings.video !== undefined && (
        <section className="inspector-section">
          <div className="mask-section-heading">
            <h3>Tracking</h3>
            <TrackMaskIcon />
          </div>
          <div className="mask-segmented" role="group" aria-label="Tracking direction">
            {(['forward', 'both', 'backward'] as const).map((direction) => (
              <button
                key={direction}
                type="button"
                aria-pressed={settings.video!.direction === direction}
                onClick={() => patch({ video: { ...settings.video!, direction } })}
              >
                {direction}
              </button>
            ))}
          </div>
          <MaskRange
            label="Consistency"
            value={settings.video.temporalConsistency}
            min={0}
            max={1}
            step={0.01}
            onChange={(temporalConsistency) =>
              patch({ video: { ...settings.video!, temporalConsistency } })
            }
          />
        </section>
      )}

      <section className="inspector-section mask-output-section">
        {settings.lastJob !== undefined && (
          <div className="mask-job-status" aria-live="polite">
            <span>{settings.lastJob.state}</span>
            <progress max={100} value={settings.lastJob.progress} />
            <strong>{Math.round(settings.lastJob.progress)}%</strong>
            {(settings.lastJob.state === 'queued' || settings.lastJob.state === 'leased') && (
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel mask job"
                title="Cancel"
                disabled={canceling}
                onClick={() => void cancel()}
              >
                <CloseIcon />
              </button>
            )}
          </div>
        )}
        {runtimeError !== undefined && <p className="inspector-expression-error">{runtimeError}</p>}
        <div className="mask-action-row">
          <button
            type="button"
            className="icon-button icon-button-labeled mask-primary-action"
            disabled={running || runtimeState !== 'ready'}
            title={runtimeState === 'ready' ? 'Create alpha matte' : runtime.title}
            onClick={() => void queue('matte')}
          >
            <MaskIcon /> Create Mask
          </button>
          <button
            type="button"
            className="icon-button icon-button-labeled"
            disabled={running || runtimeState !== 'ready'}
            title={runtimeState === 'ready' ? 'Remove background' : runtime.title}
            onClick={() => void queue('cutout')}
          >
            <SubjectIcon /> Remove BG
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Clear mask"
            title="Clear mask"
            onClick={onClear}
          >
            <TrashIcon />
          </button>
        </div>
      </section>
    </div>
  );
}

function MaskChoice({
  active,
  label,
  icon,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" className="mask-choice" aria-pressed={active} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Coordinate({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="mask-coordinate">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        max={1}
        step={0.01}
        value={Math.round(value * 100) / 100}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next)) onChange(Math.min(1, Math.max(0, next)));
        }}
      />
    </label>
  );
}

function MaskRange({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit?: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="mask-range">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
      <output>
        {step < 1 ? value.toFixed(2) : Math.round(value)}
        {unit}
      </output>
    </label>
  );
}

function maskJobId(targetId: string): string {
  const safe = targetId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 78);
  return `mask-${safe}-${Date.now().toString(36)}`;
}

function nextMaskBox(
  current: NonNullable<MaskSettings['selection']['box']>,
  key: 'x' | 'y' | 'width' | 'height',
  value: number,
): NonNullable<MaskSettings['selection']['box']> {
  const draft = { ...current, [key]: value };
  const x = Math.min(0.999, Math.max(0, draft.x));
  const y = Math.min(0.999, Math.max(0, draft.y));
  return {
    ...draft,
    x,
    y,
    width: Math.max(0.001, Math.min(draft.width, 1 - x)),
    height: Math.max(0.001, Math.min(draft.height, 1 - y)),
  };
}
