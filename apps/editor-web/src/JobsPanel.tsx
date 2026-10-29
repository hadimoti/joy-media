import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrowserControlPlaneClient,
  type BrowserJob,
  type BrowserWorker,
} from './control-plane-client.js';
import {
  jobStateLabel,
  projectJobStatus,
  workerPresence,
  workerProcessView,
} from './jobs-panel-state.js';
import {
  getDesktopWorkerStatus,
  isDesktopHost,
  retryDesktopWorker,
  type DesktopWorkerStatus,
} from './desktop-client.js';
import { BoundedPollingLoop } from './bounded-polling.js';
import { CloseIcon, RefreshIcon } from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

const PRESENCE_ORDER = { connected: 0, disconnected: 1 } as const;

const TABS: readonly PanelTabSpec[] = [
  { id: 'workers', label: 'Workers' },
  { id: 'queue', label: 'Queue' },
];

/**
 * The Jobs panel of the local build (PLAN-v4 §4a): the status of the local Worker, and the render
 * jobs of this project with cancel. The denoise and thumbnail queues, their review and the retry
 * action are not here: the local build has no channel for them yet.
 */
export function JobsPanel({
  projectId,
  projectTitle,
}: {
  readonly projectId: string;
  readonly projectTitle: string;
}) {
  const client = useMemo(() => new BrowserControlPlaneClient(), []);
  const [workers, setWorkers] = useState<readonly BrowserWorker[]>([]);
  const [jobs, setJobs] = useState<readonly BrowserJob[]>([]);
  const [workerProcess, setWorkerProcess] = useState<DesktopWorkerStatus>();
  // Track the initialized *project ID*, rather than a boolean. A panel can stay mounted while the
  // editor switches projects, and the next project must register its own binding first.
  const [initializedProjectId, setInitializedProjectId] = useState<string>();
  const [connectionStatus, setConnectionStatus] = useState('Checking the local Worker…');
  const [status, setStatus] = useState<string>();
  const [tab, setTab] = useState('workers');
  const refreshSeqRef = useRef(0);
  const pollingRef = useRef<BoundedPollingLoop | undefined>(undefined);
  const projectInitialized = initializedProjectId === projectId;

  const load = useCallback(async () => {
    const requestId = ++refreshSeqRef.current;
    try {
      const nextWorkers = await client.workers();
      // Register the project once. Repeating it on every ten-second status poll adds nothing.
      if (!projectInitialized) await client.ensureProject(projectId, projectTitle);
      const nextJobs = await client.jobs(projectId);
      const nextWorkerProcess = await readWorkerProcess();
      if (requestId !== refreshSeqRef.current) return;
      setWorkers(nextWorkers);
      setJobs(nextJobs);
      setWorkerProcess(nextWorkerProcess);
      setInitializedProjectId(projectId);
      setConnectionStatus(projectJobStatus(false, nextWorkers));
    } catch (error) {
      if (requestId !== refreshSeqRef.current) return;
      setConnectionStatus(`Local Worker status is unavailable: ${message(error)}`);
      throw error;
    }
  }, [client, projectId, projectInitialized, projectTitle]);

  const refresh = useCallback(() => pollingRef.current?.refresh() ?? load(), [load]);

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

  const retryWorkerProcess = useCallback(async () => {
    try {
      setWorkerProcess(await retryDesktopWorker());
      setStatus(undefined);
    } catch (error) {
      setStatus(`Worker retry failed: ${message(error)}`);
    }
  }, []);

  const sortedWorkers = useMemo(() => {
    return [...workers].sort((left, right) => {
      const lp = PRESENCE_ORDER[workerPresence(left)];
      const rp = PRESENCE_ORDER[workerPresence(right)];
      if (lp !== rp) return lp - rp;
      return left.id.localeCompare(right.id);
    });
  }, [workers]);

  const connectedCount = workers.filter((w) => workerPresence(w) === 'connected').length;

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
      }
    >
      {tab === 'workers' && (
        <section className="jobs-section" aria-label="Workers">
          <div className="jobs-section-head">
            <h3>Workers</h3>
            <span className="jobs-section-meta">
              {connectedCount} connected · {workers.length} total
            </span>
          </div>
          {workerProcess !== undefined && (
            <WorkerProcessRow status={workerProcess} onRetry={() => void retryWorkerProcess()} />
          )}
          {sortedWorkers.length === 0 ? (
            <p className="jobs-empty">No local Worker found.</p>
          ) : (
            <ul className="jobs-workers">
              {sortedWorkers.map((worker) => {
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
                    </div>
                  </li>
                );
              })}
            </ul>
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
            <p className="jobs-empty">No render jobs yet.</p>
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
                        <strong>{job.type === 'render.export' ? 'Export' : job.type}</strong>
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
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </PanelShell>
  );

  function report(error: unknown): void {
    setStatus(`Job action failed: ${message(error)}`);
  }
}

/** The desktop's own Worker process. Undefined outside the desktop host, or while its status cannot be read. */
async function readWorkerProcess(): Promise<DesktopWorkerStatus | undefined> {
  if (!isDesktopHost()) return undefined;
  return getDesktopWorkerStatus().catch(() => undefined);
}

function WorkerProcessRow({
  status,
  onRetry,
}: {
  readonly status: DesktopWorkerStatus;
  readonly onRetry: () => void;
}) {
  const view = workerProcessView(status.connection);
  return (
    <div className="jobs-worker-process" data-worker-connection={status.connection}>
      <div className="jobs-row-main">
        <strong>Local Worker</strong>
        <span className={`jobs-pill jobs-pill--${view.tone}`}>{view.label}</span>
      </div>
      {status.lastError !== undefined && <p className="jobs-error">{status.lastError}</p>}
      {view.canRetry && (
        <button
          type="button"
          className="jobs-retry-button"
          aria-label="Retry local Worker"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}

function shortId(id: string): string {
  if (id.length <= 22) return id;
  return `${id.slice(0, 14)}…${id.slice(-4)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
