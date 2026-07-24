import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrowserControlPlaneClient,
  type BrowserJob,
  type BrowserWorker,
} from './control-plane-client.js';
import { jobStateLabel, projectJobStatus, workerPresence } from './jobs-panel-state.js';
import { CloseIcon, ImageIcon, PlusIcon, RefreshIcon } from './icons.js';

const PRESENCE_ORDER = { connected: 0, disconnected: 1, revoked: 2 } as const;

export function JobsPanel({
  projectId,
  projectTitle,
}: {
  projectId: string;
  projectTitle: string;
}) {
  const client = useMemo(() => new BrowserControlPlaneClient(), []);
  const [workers, setWorkers] = useState<readonly BrowserWorker[]>([]);
  const [jobs, setJobs] = useState<readonly BrowserJob[]>([]);
  const [workerId, setWorkerId] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [projectInitialized, setProjectInitialized] = useState(false);
  const [status, setStatus] = useState('Checking JOY Media connection…');
  const [guideOpen, setGuideOpen] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const nextWorkers = await client.workers();
      let nextJobs: readonly BrowserJob[] = [];
      let projectMissing = false;
      try {
        nextJobs = await client.jobs(projectId);
      } catch (error) {
        if (!message(error).includes('PROJECT_NOT_FOUND')) throw error;
        projectMissing = true;
      }
      setWorkers(nextWorkers);
      setJobs(nextJobs);
      setProjectInitialized(!projectMissing);
      setStatus(projectJobStatus(projectMissing, nextWorkers));
    } catch (error) {
      setStatus(`Offline or not signed in: ${message(error)}`);
    }
  }, [client, projectId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

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

  const pair = async () => {
    try {
      await client.pairWorker(workerId.trim(), pairingCode.trim());
      setPairingCode('');
      setStatus('Pairing approved; restart the Worker so it can claim its session.');
      await refresh();
    } catch (error) {
      setStatus(`Pairing failed: ${message(error)}`);
    }
  };

  const initialize = async () => {
    try {
      try {
        await client.createProject(projectId, projectTitle);
      } catch (error) {
        if (!message(error).includes('PROJECT_EXISTS')) throw error;
      }
      setProjectInitialized(true);
      setStatus('Project ready. Pair a Worker, then queue work.');
      await refresh();
    } catch (error) {
      setStatus(`Could not initialize project: ${message(error)}`);
    }
  };

  const submit = async () => {
    if (!projectInitialized) {
      setStatus('Initialize this project before queueing a derivative job.');
      return;
    }
    try {
      await client.enqueueFixture(projectId, `fixture-thumbnail-${crypto.randomUUID()}`);
      setStatus('Thumbnail derivative queued for a paired local Worker.');
      await refresh();
    } catch (error) {
      setStatus(`Could not queue job: ${message(error)}`);
    }
  };

  return (
    <article className="jobs-panel">
      <header className="jobs-toolbar">
        <div className="jobs-toolbar-copy">
          <strong className="jobs-title">Jobs</strong>
          <p className="jobs-status" aria-live="polite">
            {status}
          </p>
        </div>
        <div className="jobs-toolbar-actions">
          {!projectInitialized && (
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
            aria-label="Queue thumbnail derivative"
            title="Queue thumbnail"
            data-guide="Queue thumbnail"
            disabled={!projectInitialized}
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
            onClick={() => void refresh()}
          >
            <RefreshIcon />
          </button>
        </div>
      </header>

      <section className="jobs-pair" aria-label="Pair local Worker">
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
            type="button"
            className="jobs-pair-submit"
            disabled={!workerId.trim() || !pairingCode.trim()}
            onClick={() => void pair()}
          >
            Approve
          </button>
        </div>
      </section>

      <div className="jobs-scroll">
        <section className="jobs-section" aria-label="Workers">
          <div className="jobs-section-head">
            <h3>Workers</h3>
            <span className="jobs-section-meta">
              {connectedCount} connected · {activeWorkers.length} active
            </span>
          </div>
          {visibleWorkers.length === 0 ? (
            <p className="jobs-empty">No active workers. Pair one below using the guide.</p>
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
                          onClick={() =>
                            void client.revokeWorker(worker.id).then(refresh).catch(report)
                          }
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
                <li key={job.id} className={`job-${job.state}`}>
                  <div className="jobs-worker-row">
                    <div className="jobs-worker-copy">
                      <div className="jobs-row-main">
                        <strong>Thumbnail</strong>
                        <span className={`jobs-pill jobs-pill--${job.state}`}>
                          {jobStateLabel(job)}
                        </span>
                        <span className="jobs-progress">{job.progress}%</span>
                      </div>
                      {job.derivative !== undefined && (
                        <p className="job-derivative">
                          Verified · {job.derivative.bytes} B ·{' '}
                          {job.derivative.sha256.slice(0, 12)}…
                        </p>
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
                          onClick={() =>
                            void client.cancel(projectId, job.id).then(refresh).catch(report)
                          }
                        >
                          <CloseIcon />
                        </button>
                      )}
                      {(job.state === 'canceled' ||
                        job.state === 'failed' ||
                        job.state === 'completed') && (
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
        </section>
      </div>

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
              On your PC, start the local Worker with <code>JOY_MEDIA_API_URL</code> pointed at
              this Media API. The Worker runs on your machine — not on the VPS.
            </li>
            <li>
              <strong>Pairing code</strong> — Worker terminal prints{' '}
              <code>Approve this Worker in JOY Media with pairing code: …</code>. Codes expire in
              ~5 minutes; restart the Worker for a fresh offer.
            </li>
            <li>
              <strong>Worker ID</strong> — copy <code>workerId</code> from the Worker startup JSON,
              or from <code>~/.joy-media/worker-state.json</code> (or{' '}
              <code>JOY_MEDIA_WORKER_STATE_PATH</code>).
            </li>
            <li>
              Paste both above → <strong>Approve</strong> → <strong>restart the Worker</strong> so
              it claims the session. It should show as connected within a few seconds.
            </li>
            <li>
              GPU work needs local <code>image.comfy</code> / <code>audio.ml-denoise</code> on that
              PC — never on the Media VPS.
            </li>
          </ol>
        )}
      </section>
    </article>
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
