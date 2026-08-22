import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrowserControlPlaneClient,
  type BrowserJob,
  type BrowserWorker,
} from './control-plane-client.js';
import { jobStateLabel, projectJobStatus, workerPresence } from './jobs-panel-state.js';
import { CloseIcon, PlusIcon, RefreshIcon } from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

const PRESENCE_ORDER = { connected: 0, disconnected: 1, revoked: 2 } as const;

const TABS: readonly PanelTabSpec[] = [
  { id: 'workers', label: 'Workers' },
  { id: 'queue', label: 'Queue' },
  { id: 'pair', label: 'Pair' },
];

export function jobsPanelToolbarActions(projectInitialized: boolean): readonly string[] {
  return projectInitialized ? ['refresh'] : ['initialize', 'refresh'];
}

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
  const [status, setStatus] = useState('در حال بررسی اتصال JOY Media…');
  const [guideOpen, setGuideOpen] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  const [tab, setTab] = useState('workers');
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++refreshSeqRef.current;
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
      if (requestId !== refreshSeqRef.current) return;
      setWorkers(nextWorkers);
      setJobs(nextJobs);
      setProjectInitialized(!projectMissing);
      setStatus(projectJobStatus(projectMissing, nextWorkers));
    } catch (error) {
      if (requestId !== refreshSeqRef.current) return;
      setStatus(`اتصال برقرار نیست یا ورود انجام نشده است: ${message(error)}`);
    }
  }, [client, projectId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => {
      refreshSeqRef.current += 1;
      window.clearInterval(interval);
    };
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
      setStatus('Pairing تأیید شد؛ Worker را دوباره اجرا کنید تا نشست خود را بگیرد.');
      await refresh();
    } catch (error) {
      setStatus(`Pairing ناموفق بود: ${message(error)}`);
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
      setStatus('Project آماده است. یک Worker را Pair کنید و سپس Job را در صف بگذارید.');
      await refresh();
    } catch (error) {
      setStatus(`راه‌اندازی Project ناموفق بود: ${message(error)}`);
    }
  };

  return (
    <PanelShell
      title="Jobs"
      iconUrl={panelTabIconUrl('jobs')}
      className="jobs-panel"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      note={status}
      actions={
        <>
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
            aria-label="Refresh jobs"
            title="Refresh"
            data-guide="Refresh"
            onClick={() => void refresh()}
          >
            <RefreshIcon />
          </button>
        </>
      }
    >
      {tab === 'pair' && (
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
            <p className="jobs-empty" lang="fa">
              هنوز Worker فعالی وجود ندارد. با راهنمای پایین یکی را Pair کنید.
            </p>
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
      )}

      {tab === 'queue' && (
        <section className="jobs-section" aria-label="Derivative jobs">
          <div className="jobs-section-head">
            <h3>Queue</h3>
            <span className="jobs-section-meta">{jobs.length}</span>
          </div>
          {jobs.length === 0 ? (
            <p className="jobs-empty" lang="fa">
              هنوز هیچ Job مشتقی ثبت نشده است.
            </p>
          ) : (
            <ul className="jobs-list">
              {jobs.map((job) => {
                const reportRef = job.derivative?.reportRef ?? job.payload?.reportRef;
                return (
                  <li key={job.id} className={`job-${job.state}`}>
                    <div className="jobs-worker-row">
                      <div className="jobs-worker-copy">
                        <div className="jobs-row-main">
                          <strong>{jobLabel(job.type)}</strong>
                          <span className={`jobs-pill jobs-pill--${job.state}`}>
                            {jobStateLabel(job)}
                          </span>
                          <span className="jobs-progress">{job.progress}%</span>
                        </div>
                        {reportRef !== undefined && (
                          <p className="job-derivative">Report · {reportRef}</p>
                        )}
                        {job.derivative !== undefined && job.derivative.sha256 !== undefined && (
                          <p className="job-derivative">
                            Verified · {job.derivative.bytes ?? 0} B ·{' '}
                            {job.derivative.sha256.slice(0, 12)}…
                          </p>
                        )}
                        {typeof job.derivative?.findings === 'number' && (
                          <p className="job-derivative">{job.derivative.findings} findings</p>
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
                );
              })}
            </ul>
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
            <ol className="jobs-guide-steps" lang="fa">
              <li>
                یک Worker محلی را روی رایانهٔ خود اجرا کنید و <code>JOY_MEDIA_API_URL</code> را به
                همین Media API اشاره دهید. Worker روی دستگاه شما اجرا می‌شود، نه روی VPS.
              </li>
              <li>
                <strong>Pairing code</strong> — ترمینال Worker این پیام را نشان می‌دهد:{' '}
                <code>Approve this Worker in JOY Media with pairing code: …</code>. کدها حدود پنج
                دقیقه معتبرند؛ برای گرفتن یک کد تازه Worker را دوباره اجرا کنید.
              </li>
              <li>
                <strong>Worker ID</strong> — مقدار <code>workerId</code> را از JSON آغاز Worker یا
                از <code>~/.joy-media/worker-state.json</code> (یا{' '}
                <code>JOY_MEDIA_WORKER_STATE_PATH</code>) بردارید.
              </li>
              <li>
                هر دو مقدار را بالا وارد کنید، روی <strong>Approve</strong> بزنید، سپس{' '}
                <strong>Worker را دوباره اجرا کنید</strong> تا نشست را بگیرد. اتصال باید ظرف چند
                ثانیه ظاهر شود.
              </li>
              <li>
                Jobهای GPU به <code>image.comfy</code>، <code>audio.ml-denoise</code>، یا{' '}
                <code>text.lm-studio</code> روی همان دستگاه محلی نیاز دارند و هرگز روی Media VPS
                اجرا نمی‌شوند. Jobهای AI راه‌دور (<code>text.openrouter</code>،{' '}
                <code>video.runway</code>، <code>edit.higgsfield</code>) به کلیدهای API تنظیم‌شده در{' '}
                <code>~/.joy-media/ai-providers.json</code> روی رایانهٔ Worker نیاز دارند.
              </li>
            </ol>
          )}
        </section>
      )}
    </PanelShell>
  );

  function report(error: unknown): void {
    setStatus(`اقدام روی Job ناموفق بود: ${message(error)}`);
  }
}

function shortId(id: string): string {
  if (id.length <= 22) return id;
  return `${id.slice(0, 14)}…${id.slice(-4)}`;
}

function jobLabel(type: string): string {
  switch (type) {
    case 'asset.thumbnail':
      return 'Thumbnail';
    case 'render.export':
      return 'Render export';
    case 'render.inspect':
      return 'Render inspection';
    default:
      return type;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
