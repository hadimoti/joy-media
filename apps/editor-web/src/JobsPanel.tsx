import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrowserControlPlaneClient,
  invalidateWorkerReadCache,
  type BrowserJob,
  type BrowserWorker,
} from './control-plane-client.js';
import { jobStateLabel, projectJobStatus, workerPresence } from './jobs-panel-state.js';
import { BoundedPollingLoop } from './bounded-polling.js';
import { CloseIcon, ImageIcon, PlusIcon, RefreshIcon } from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import type { ProjectOperationLedger, ProjectOperationStatus } from './project-operation-ledger.js';
import { verifyWorkerAudioDerivative, type VerifiedWorkerAudioResult } from './worker-result.js';
import { useReleasableObjectUrl } from './media-object-url.js';

const PRESENCE_ORDER = { connected: 0, disconnected: 1, revoked: 2 } as const;

const TABS: readonly PanelTabSpec[] = [
  { id: 'workers', label: 'Workers' },
  { id: 'queue', label: 'Queue' },
  { id: 'pair', label: 'Pair' },
];

export function workerResultWasApplied(status: ProjectOperationStatus | undefined): boolean {
  return status === 'applied' || status === 'completed';
}

/** Stable globally unique job/ledger key for one project's selected source. */
export function workerAudioDenoiseOperationId(projectId: string, assetId: string): string {
  return `audio-denoise-${projectId}-${assetId}`;
}

export type QueueWorkerReadiness =
  | { readonly kind: 'ready'; readonly worker: BrowserWorker }
  | { readonly kind: 'missing-asset'; readonly reason: string }
  | { readonly kind: 'missing-capability'; readonly reason: string }
  | { readonly kind: 'source-unavailable'; readonly reason: string };

/**
 * A Worker is queueable only when the same connected Worker both advertises
 * the operation and reports the selected source as local. Capability and
 * source checks must not be satisfied by two different Workers.
 */
export function queueWorkerReadiness(
  workers: readonly BrowserWorker[],
  capability: string,
  assetId: string | undefined,
): QueueWorkerReadiness {
  if (assetId === undefined)
    return { kind: 'missing-asset', reason: 'Select a media clip before queueing a derivative.' };

  const compatibleWorkers = workers.filter(
    (worker) => workerPresence(worker) === 'connected' && worker.capabilities.includes(capability),
  );
  if (compatibleWorkers.length === 0)
    return {
      kind: 'missing-capability',
      reason: `No connected Worker advertises ${capability}.`,
    };

  const worker = compatibleWorkers.find((candidate) => candidate.localAssetIds?.includes(assetId));
  if (worker === undefined)
    return {
      kind: 'source-unavailable',
      reason: 'No connected capable Worker has this media source locally yet.',
    };
  return { kind: 'ready', worker };
}

export function JobsPanel({
  projectId,
  projectTitle,
  controlPlaneReady = true,
  audioAssetId,
  thumbnailAssetId,
  onApplyWorkerAudioResult,
  operationLedger,
  operationRevision = 0,
}: {
  projectId: string;
  projectTitle: string;
  readonly controlPlaneReady?: boolean;
  readonly audioAssetId?: string;
  /** Selected visual asset that can be rendered by the Worker thumbnail path. */
  readonly thumbnailAssetId?: string;
  readonly onApplyWorkerAudioResult?: (
    result: VerifiedWorkerAudioResult,
    mode: 'replace' | 'keep',
  ) => Promise<void> | void;
  readonly operationLedger?: Pick<ProjectOperationLedger, 'begin' | 'finish' | 'get'>;
  readonly operationRevision?: number;
}) {
  const client = useMemo(() => new BrowserControlPlaneClient(), []);
  const [workers, setWorkers] = useState<readonly BrowserWorker[]>([]);
  const [jobs, setJobs] = useState<readonly BrowserJob[]>([]);
  const [workerId, setWorkerId] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  // Track the initialized *project ID*, rather than a boolean. A panel can
  // stay mounted while the editor switches projects; a boolean would let the
  // next project's first poll skip its required idempotent bootstrap.
  const [initializedProjectId, setInitializedProjectId] = useState<string>();
  const [connectionStatus, setConnectionStatus] = useState('Checking JOY Media connection…');
  const [status, setStatus] = useState<string>();
  const [guideOpen, setGuideOpen] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  const [tab, setTab] = useState('workers');
  const [review, setReview] = useState<VerifiedWorkerAudioResult | undefined>();
  const [reviewUrl, setReviewUrl] = useState<string | undefined>();
  const reviewAudioRef = useReleasableObjectUrl<HTMLAudioElement>(reviewUrl);
  const [reviewBusy, setReviewBusy] = useState(false);
  const reviewBusyRef = useRef(false);
  const [pairBusy, setPairBusy] = useState(false);
  const pairBusyRef = useRef(false);
  const [pendingPairWorkerId, setPendingPairWorkerId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const refreshSeqRef = useRef(0);
  const pollingRef = useRef<BoundedPollingLoop | undefined>(undefined);
  const projectInitialized = initializedProjectId === projectId;

  useEffect(() => {
    if (review === undefined) {
      setReviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(review.blob);
    setReviewUrl(url);
  }, [review]);

  const load = useCallback(async () => {
    const requestId = ++refreshSeqRef.current;
    try {
      const nextWorkers = await client.workers();
      let nextJobs: readonly BrowserJob[] = [];
      const projectScopeReady =
        controlPlaneReady || projectInitialized || projectId.startsWith('project-');
      let projectMissing = !projectScopeReady;
      if (projectScopeReady) {
        try {
          // Bootstrap only the first poll for this project. Repeating an
          // idempotent write on every ten-second status poll still creates
          // avoidable API/PostgreSQL load. Switching projects makes
          // projectInitialized false again, so the new binding is never
          // assumed from the old project's successful bootstrap.
          if (!projectInitialized) await client.ensureProject(projectId, projectTitle);
          nextJobs = await client.jobs(projectId);
        } catch (error) {
          if (!message(error).includes('PROJECT_NOT_FOUND')) throw error;
          projectMissing = true;
        }
      }
      if (requestId !== refreshSeqRef.current) return;
      setWorkers(nextWorkers);
      if (projectScopeReady) {
        setJobs(nextJobs);
        setInitializedProjectId(projectMissing ? undefined : projectId);
        setConnectionStatus(projectJobStatus(projectMissing, nextWorkers));
      }
    } catch (error) {
      if (requestId !== refreshSeqRef.current) return;
      setConnectionStatus(`Not connected or not signed in: ${message(error)}`);
      throw error;
    }
  }, [client, controlPlaneReady, projectId, projectInitialized, projectTitle]);

  const refresh = useCallback(() => {
    // Pair/hello is also used directly by the protocol acceptance journeys;
    // an explicit user refresh must bypass the cross-panel worker projection
    // cache so newly connected capabilities become actionable immediately.
    invalidateWorkerReadCache();
    return pollingRef.current?.refresh() ?? load();
  }, [load]);

  useEffect(() => {
    const onJobsChanged = () => {
      void refresh().catch(() => undefined);
    };
    window.addEventListener('joy-media-jobs-changed', onJobsChanged);
    return () => window.removeEventListener('joy-media-jobs-changed', onJobsChanged);
  }, [refresh]);

  useEffect(() => {
    const polling = new BoundedPollingLoop(load);
    pollingRef.current = polling;
    const syncVisibility = () => {
      void polling.setVisible(document.visibilityState === 'visible').catch(() => undefined);
    };
    document.addEventListener('visibilitychange', syncVisibility);
    syncVisibility();
    polling.start();
    return () => {
      refreshSeqRef.current += 1;
      document.removeEventListener('visibilitychange', syncVisibility);
      polling.stop();
      if (pollingRef.current === polling) pollingRef.current = undefined;
    };
  }, [load]);

  const sortedWorkers = useMemo(() => {
    return [...workers].sort((left, right) => {
      const lp = PRESENCE_ORDER[workerPresence(left)];
      const rp = PRESENCE_ORDER[workerPresence(right)];
      if (lp !== rp) return lp - rp;
      return left.id.localeCompare(right.id);
    });
  }, [workers]);

  const activeWorkers = sortedWorkers.filter((w) => !w.revoked);
  const revokedWorkers = sortedWorkers.filter((w) => w.revoked);
  const visibleWorkers = showRevoked ? sortedWorkers : activeWorkers;
  const connectedCount = workers.filter((w) => workerPresence(w) === 'connected').length;
  const queuedAssetId = audioAssetId ?? thumbnailAssetId;
  const queuedCapability = audioAssetId === undefined ? 'asset.thumbnail' : 'audio.ml-denoise';
  const queueReadiness = useMemo(
    () => queueWorkerReadiness(workers, queuedCapability, queuedAssetId),
    [queuedAssetId, queuedCapability, workers],
  );
  const queueUnavailableReason =
    queueReadiness.kind === 'ready' ? undefined : queueReadiness.reason;
  // A ready authenticated session initializes its opaque project binding during
  // refresh. Do not briefly mount an action that that same refresh immediately
  // removes; it produces a real UI flicker and can detach a user's click.
  const showInitialize =
    !projectInitialized &&
    (!controlPlaneReady || connectionStatus.startsWith('Not connected or not signed in:'));

  useEffect(() => {
    if (pendingPairWorkerId === undefined) return;
    const paired = workers.find((worker) => worker.id === pendingPairWorkerId);
    if (paired === undefined || workerPresence(paired) !== 'connected') return;
    setStatus(`Worker ${shortId(paired.id)} connected successfully.`);
    setPendingPairWorkerId(undefined);
  }, [pendingPairWorkerId, workers]);

  const pair = async () => {
    if (pairBusyRef.current) return;
    pairBusyRef.current = true;
    setPairBusy(true);
    try {
      const approved = await client.pairWorker(workerId.trim(), pairingCode.trim());
      setPairingCode('');
      setPendingPairWorkerId(approved.id);
      setStatus(
        `Pairing approved for ${shortId(approved.id)}; waiting for the Worker to claim automatically.`,
      );
      await refresh();
    } catch (error) {
      setStatus(`Pairing failed: ${message(error)}`);
    } finally {
      pairBusyRef.current = false;
      setPairBusy(false);
    }
  };

  const initialize = async () => {
    try {
      await client.ensureProject(projectId, projectTitle);
      setInitializedProjectId(projectId);
      setStatus('Project is ready. Pair a Worker, then queue a job.');
      await refresh();
    } catch (error) {
      setStatus(`Failed to initialize project: ${message(error)}`);
    }
  };

  const submit = async () => {
    if (!projectInitialized) {
      setStatus('Initialize this project before queueing a derivative job.');
      return;
    }
    if (queueReadiness.kind !== 'ready') {
      setStatus(queueReadiness.reason);
      return;
    }
    let operationId: string | undefined;
    let operationStarted = false;
    try {
      setSubmitting(true);
      if (audioAssetId !== undefined) {
        const jobId = workerAudioDenoiseOperationId(projectId, audioAssetId);
        operationId = jobId;
        const existing = operationLedger?.get(jobId);
        if (existing?.status === 'applied' || existing?.status === 'completed') {
          setStatus('This Worker result has already been applied to the project.');
          return;
        }
        if (existing?.status === 'review') {
          setStatus('This Worker result is waiting in the review surface.');
          return;
        }
        if (existing?.status === 'running') {
          setStatus('This Worker operation is already running. Refresh Queue to reattach.');
          return;
        }
        operationLedger?.begin({
          id: jobId,
          type: 'worker-job',
          fingerprint: `${audioAssetId}:audio.ml-denoise:v1`,
          revision: operationRevision,
        });
        operationStarted = true;
        await client.associateAsset(projectId, audioAssetId);
        await client.enqueueWorkerGeneration(projectId, jobId, 'audio.ml-denoise', audioAssetId);
        setStatus(
          'Audio denoise job queued. The Worker result will require review before insertion.',
        );
      } else if (thumbnailAssetId !== undefined) {
        await client.associateAsset(projectId, thumbnailAssetId);
        await client.enqueueAssetThumbnail(
          projectId,
          `asset-thumbnail-${crypto.randomUUID()}`,
          thumbnailAssetId,
        );
        setStatus('Thumbnail job queued for the paired local Worker.');
      } else {
        setStatus('Select a media clip before queueing a thumbnail.');
        return;
      }
      await refresh();
    } catch (error) {
      if (operationStarted && operationId !== undefined) {
        try {
          operationLedger?.finish(operationId, 'failed', { error: message(error) });
        } catch {
          /* Keep the API error visible even if an older ledger is corrupt. */
        }
      }
      setStatus(`Failed to queue job: ${message(error)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const reviewAudioResult = async (job: BrowserJob): Promise<void> => {
    if (job.assetId === undefined || job.derivative === undefined) return;
    if (workerResultWasApplied(operationLedger?.get(job.id)?.status)) {
      setStatus('This Worker result is already applied to the project.');
      return;
    }
    if (reviewBusyRef.current) return;
    reviewBusyRef.current = true;
    try {
      setReviewBusy(true);
      const derivatives = await client.derivatives(projectId, job.assetId);
      const derivative = derivatives.find(
        (candidate) => candidate.kind === 'audio' && candidate.sha256 === job.derivative?.sha256,
      );
      if (derivative === undefined) throw new Error('Verified audio derivative is unavailable');
      const blob = await client.derivativeBytes(projectId, job.assetId, derivative.id);
      const sourceAsset = (await client.assets(projectId)).find(
        (asset) => asset.id === job.assetId,
      );
      if (sourceAsset === undefined)
        throw new Error('The Worker result source asset is no longer available');
      const verified = await verifyWorkerAudioDerivative({
        jobId: job.id,
        sourceAssetId: job.assetId,
        sourceAssetSha256: sourceAsset.sha256,
        derivative,
        blob,
      });
      if (operationLedger !== undefined) {
        if (operationLedger.get(job.id) === undefined) {
          operationLedger.begin({
            id: job.id,
            type: 'worker-job',
            fingerprint: `${job.assetId}:audio.ml-denoise:v1`,
            revision: operationRevision,
          });
        }
        operationLedger.finish(job.id, 'review', {
          resultRef: derivative.id,
        });
      }
      setReview(verified);
      setStatus('Worker result verified. Choose how to apply it to the project.');
    } catch (error) {
      setStatus(`Could not verify Worker result: ${message(error)}`);
    } finally {
      reviewBusyRef.current = false;
      setReviewBusy(false);
    }
  };

  const applyReview = async (mode: 'replace' | 'keep'): Promise<void> => {
    if (review === undefined) return;
    if (onApplyWorkerAudioResult === undefined) {
      setStatus('Worker result review is ready, but no project insertion target is selected.');
      return;
    }
    if (workerResultWasApplied(operationLedger?.get(review.jobId)?.status)) {
      setReview(undefined);
      setStatus('This Worker result is already applied to the project.');
      return;
    }
    if (reviewBusyRef.current) return;
    reviewBusyRef.current = true;
    try {
      setReviewBusy(true);
      await onApplyWorkerAudioResult(review, mode);
      try {
        operationLedger?.finish(review.jobId, 'applied', {
          resultRef: review.generatedAsset.id,
        });
      } catch {
        /* The creative transaction is still authoritative for legacy jobs. */
      }
      setReview(undefined);
      setStatus(
        mode === 'replace'
          ? 'Processed audio applied to the selected clip.'
          : 'Processed audio kept in the project.',
      );
    } catch (error) {
      setStatus(`Could not apply Worker result: ${message(error)}`);
    } finally {
      reviewBusyRef.current = false;
      setReviewBusy(false);
    }
  };

  const discardReview = (): void => {
    if (review !== undefined) {
      try {
        operationLedger?.finish(review.jobId, 'cancelled');
      } catch {
        /* Legacy jobs have no ledger record to remove. */
      }
    }
    setReview(undefined);
  };

  return (
    <PanelShell
      title="Jobs"
      iconUrl={panelTabIconUrl('jobs')}
      className="jobs-panel"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      note={status ?? connectionStatus}
      actions={
        <>
          {showInitialize && (
            <button
              type="button"
              className="icon-button"
              aria-label="Initialize project"
              title="Initialize project"
              data-guide="Initialize"
              onClick={() => void initialize()}
            >
              <PlusIcon />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={
              audioAssetId === undefined ? 'Queue thumbnail derivative' : 'Run audio denoise'
            }
            title={
              queueUnavailableReason ??
              (audioAssetId === undefined ? 'Queue thumbnail derivative' : 'Run audio denoise')
            }
            data-guide={audioAssetId === undefined ? 'Queue thumbnail' : 'Run audio denoise'}
            disabled={!projectInitialized || submitting || queueUnavailableReason !== undefined}
            onClick={() => void submit()}
          >
            <ImageIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh jobs"
            title="Refresh"
            data-guide="Refresh"
            onClick={() => void refresh().catch(report)}
          >
            <RefreshIcon />
          </button>
        </>
      }
    >
      {tab === 'pair' && (
        <form
          className="jobs-pair"
          aria-label="Pair local Worker"
          onSubmit={(event) => {
            event.preventDefault();
            void pair();
          }}
        >
          <label className="jobs-field">
            <span>Worker ID</span>
            <input
              value={workerId}
              onChange={(event) => setWorkerId(event.target.value)}
              placeholder="worker-…"
              spellCheck={false}
              aria-label="Worker ID"
            />
          </label>
          <label className="jobs-field">
            <span>Pairing code</span>
            <input
              value={pairingCode}
              onChange={(event) => setPairingCode(event.target.value)}
              placeholder="One-time code"
              autoComplete="off"
              spellCheck={false}
              aria-label="One-time pairing code"
            />
          </label>
          <div className="jobs-pair-action">
            <span className="jobs-pair-action-label" aria-hidden>
              &nbsp;
            </span>
            <button
              type="submit"
              className="jobs-pair-submit"
              disabled={pairBusy || !workerId.trim() || !pairingCode.trim()}
            >
              {pairBusy ? 'Approving…' : 'Approve'}
            </button>
          </div>
        </form>
      )}

      {tab === 'workers' && (
        <section className="jobs-section" aria-label="Workers">
          <div className="jobs-section-head">
            <h3>Workers</h3>
            <span className="jobs-section-meta">
              {connectedCount} connected · {activeWorkers.length} active
            </span>
          </div>
          {visibleWorkers.length === 0 ? (
            <p className="jobs-empty">No active Worker. Pair one using the guide below.</p>
          ) : (
            <ul className="jobs-workers">
              {visibleWorkers.map((worker) => {
                const presence = workerPresence(worker);
                return (
                  <li key={worker.id} className={`worker-${presence}`}>
                    <div className="jobs-worker-row">
                      <div className="jobs-worker-copy">
                        <div className="jobs-row-main">
                          <strong title={worker.id}>{shortId(worker.id)}</strong>
                          <span className={`jobs-pill jobs-pill--${presence}`}>{presence}</span>
                        </div>
                        {worker.capabilities.length > 0 && (
                          <p className="jobs-caps">{worker.capabilities.join(' · ')}</p>
                        )}
                      </div>
                      {!worker.revoked && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Revoke Worker ${worker.id}`}
                          title="Revoke"
                          data-guide="Revoke"
                          onClick={() => {
                            if (!window.confirm(`Revoke Worker ${worker.id}?`)) return;
                            void client.revokeWorker(worker.id).then(refresh).catch(report);
                          }}
                        >
                          <CloseIcon />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {revokedWorkers.length > 0 && (
            <button
              type="button"
              className="jobs-muted-toggle"
              aria-pressed={showRevoked}
              onClick={() => setShowRevoked((open) => !open)}
            >
              {showRevoked ? 'Hide' : 'Show'} {revokedWorkers.length} revoked
            </button>
          )}
        </section>
      )}

      {tab === 'queue' && (
        <section className="jobs-section" aria-label="Derivative jobs">
          <div className="jobs-section-head">
            <h3>Queue</h3>
            <span className="jobs-section-meta">{jobs.length}</span>
          </div>
          {jobs.length === 0 ? (
            <p className="jobs-empty">No derivative jobs yet.</p>
          ) : (
            <ul className="jobs-list">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  className={`job-${job.state}`}
                  data-job-id={job.id}
                  data-job-state={job.state}
                >
                  <div className="jobs-worker-row">
                    <div className="jobs-worker-copy">
                      <div className="jobs-row-main">
                        <strong>{job.type === 'asset.thumbnail' ? 'Thumbnail' : job.type}</strong>
                        <span className={`jobs-pill jobs-pill--${job.state}`}>
                          {jobStateLabel(job)}
                        </span>
                        <span className="jobs-progress">{job.progress}%</span>
                      </div>
                      {job.derivative !== undefined && (
                        <p className="job-derivative">
                          Verified · {job.derivative.bytes} B · {job.derivative.sha256.slice(0, 12)}
                          …
                        </p>
                      )}
                      {job.state === 'completed' &&
                        job.type === 'audio.ml-denoise' &&
                        job.derivative !== undefined && (
                          <button
                            type="button"
                            className="jobs-review-button"
                            disabled={
                              reviewBusy ||
                              workerResultWasApplied(operationLedger?.get(job.id)?.status)
                            }
                            onClick={() => void reviewAudioResult(job)}
                          >
                            {reviewBusy
                              ? 'Verifying…'
                              : workerResultWasApplied(operationLedger?.get(job.id)?.status)
                                ? 'Applied'
                                : 'Review result'}
                          </button>
                        )}
                      {job.error !== undefined && <p className="jobs-error">{job.error}</p>}
                    </div>
                    <div className="jobs-inline-actions">
                      {(job.state === 'queued' || job.state === 'leased') && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Cancel job ${job.id}`}
                          title="Cancel"
                          data-guide="Cancel"
                          onClick={() => {
                            if (!window.confirm(`Cancel job ${job.id}?`)) return;
                            void client.cancel(projectId, job.id).then(refresh).catch(report);
                          }}
                        >
                          <CloseIcon />
                        </button>
                      )}
                      {(job.state === 'canceled' ||
                        job.state === 'failed' ||
                        job.state === 'completed') &&
                        !(
                          job.type === 'audio.ml-denoise' &&
                          workerResultWasApplied(operationLedger?.get(job.id)?.status)
                        ) && (
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Retry job ${job.id}`}
                            title="Retry"
                            data-guide="Retry"
                            onClick={() =>
                              void client.retry(projectId, job.id).then(refresh).catch(report)
                            }
                          >
                            <RefreshIcon />
                          </button>
                        )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {review !== undefined && (
            <section className="jobs-review" role="dialog" aria-label="Review processed audio">
              <div className="jobs-section-head">
                <h3>Review processed audio</h3>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close result review"
                  onClick={() => setReview(undefined)}
                >
                  <CloseIcon />
                </button>
              </div>
              <p>
                Verified {review.bytes} bytes · {review.descriptor.mimeType} · source{' '}
                {shortId(review.sourceAssetId)}
              </p>
              {reviewUrl !== undefined && (
                <audio ref={reviewAudioRef} controls src={reviewUrl} preload="metadata" />
              )}
              <div className="jobs-inline-actions">
                <button
                  type="button"
                  disabled={reviewBusy}
                  onClick={() => void applyReview('replace')}
                >
                  Replace selected clip audio
                </button>
                <button
                  type="button"
                  disabled={reviewBusy}
                  onClick={() => void applyReview('keep')}
                >
                  Keep generated asset
                </button>
                <button type="button" disabled={reviewBusy} onClick={discardReview}>
                  Discard
                </button>
              </div>
            </section>
          )}
        </section>
      )}

      {tab === 'pair' && (
        <section className="jobs-guide" aria-label="How to find Worker ID and pairing code">
          <button
            type="button"
            className="jobs-guide-toggle"
            aria-expanded={guideOpen}
            onClick={() => setGuideOpen((open) => !open)}
          >
            How to find Worker ID & pairing code
            <span aria-hidden>{guideOpen ? '−' : '+'}</span>
          </button>
          {guideOpen && (
            <ol className="jobs-guide-steps">
              <li>
                Run a local Worker on your computer with <code>JOY_MEDIA_API_URL</code> pointing at
                this Media API. The Worker runs on your machine, not the VPS.
              </li>
              <li>
                <strong>Pairing code</strong> — the Worker terminal shows{' '}
                <code>Approve this Worker in JOY Media with pairing code: …</code>. Codes are valid
                for about five minutes; the running Worker prints a fresh code automatically after
                expiry.
              </li>
              <li>
                <strong>Worker ID</strong> — copy <code>workerId</code> from the Worker startup JSON
                or from <code>~/.joy-media/worker-state.json</code> (or{' '}
                <code>JOY_MEDIA_WORKER_STATE_PATH</code>).
              </li>
              <li>
                Enter both values above and click <strong>Approve</strong>. The running Worker polls
                for approval and should appear as connected within a few seconds; no restart is
                required.
              </li>
              <li>
                GPU jobs need local <code>image.comfy</code>, <code>audio.ml-denoise</code>, or{' '}
                <code>text.lm-studio</code> on that same machine and never run on the Media VPS.
                Remote AI jobs (<code>text.openrouter</code>, <code>video.runway</code>,{' '}
                <code>edit.higgsfield</code>) require API keys configured in{' '}
                <code>~/.joy-media/ai-providers.json</code> on the Worker PC.
              </li>
            </ol>
          )}
        </section>
      )}
    </PanelShell>
  );

  function report(error: unknown): void {
    setStatus(`Job action failed: ${message(error)}`);
  }
}

function shortId(id: string): string {
  if (id.length <= 22) return id;
  return `${id.slice(0, 14)}…${id.slice(-4)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
