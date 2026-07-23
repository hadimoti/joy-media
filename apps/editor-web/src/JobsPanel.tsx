import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrowserControlPlaneClient,
  type BrowserJob,
  type BrowserWorker,
} from './control-plane-client.js';
import { jobStateLabel, projectJobStatus, workerPresence } from './jobs-panel-state.js';
import { CloseIcon, RefreshIcon } from './icons.js';

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
  const refresh = useCallback(async () => {
    try {
      const nextWorkers = await client.workers();
      let nextJobs: readonly BrowserJob[] = [];
      let projectMissing = false;
      try {
        nextJobs = await client.jobs(projectId);
      } catch (error) {
        if (!message(error).includes('PROJECT_NOT_FOUND')) throw error;
        // A local editor project has no control-plane record until its first
        // submitted job. It is ready, not offline or unauthenticated.
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
  const pair = async () => {
    try {
      await client.pairWorker(workerId.trim(), pairingCode.trim());
      setPairingCode('');
      setStatus('Pairing approved; waiting for the local Worker to claim its session.');
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
      setStatus(
        'Project initialized. You can queue a thumbnail derivative when a Worker is available.',
      );
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
      <h2>Jobs</h2>
      <p className="jobs-status" aria-live="polite">
        {status}
      </p>
      <section className="jobs-pairing">
        <h3>Project actions</h3>
        <button type="button" onClick={() => void initialize()} disabled={projectInitialized}>
          {projectInitialized ? 'Project initialized' : 'Initialize project'}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!projectInitialized}
          aria-label="Queue thumbnail derivative for this project"
        >
          Queue thumbnail derivative
        </button>
      </section>
      <section className="jobs-pairing">
        <h3>Pair local Worker</h3>
        <label>
          Worker ID
          <input
            value={workerId}
            onChange={(event) => setWorkerId(event.target.value)}
            aria-label="Worker ID"
          />
        </label>
        <label>
          One-time pairing code
          <input
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
            autoComplete="off"
            aria-label="One-time pairing code"
          />
        </label>
        <button
          type="button"
          disabled={!workerId.trim() || !pairingCode.trim()}
          onClick={() => void pair()}
        >
          Approve pairing
        </button>
      </section>
      <section>
        <h3>Paired Workers</h3>
        <ul className="jobs-workers" aria-label="Paired Workers">
          {workers.map((worker) => (
            <li key={worker.id} className={`worker-${workerPresence(worker)}`}>
              <strong>{worker.id}</strong> · {workerPresence(worker)}
              {worker.capabilities.length > 0 && ` · ${worker.capabilities.join(', ')}`}
              {!worker.revoked && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Revoke Worker ${worker.id}`}
                  title={`Revoke Worker ${worker.id}`}
                  onClick={() => void client.revokeWorker(worker.id).then(refresh).catch(report)}
                >
                  <CloseIcon />
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Project derivative jobs</h3>
        <ul className="jobs-list" aria-label="Project derivative jobs">
          {jobs.map((job) => (
            <li key={job.id} className={`job-${job.state}`}>
              <div>
                <strong>Thumbnail derivative</strong> · <span>{jobStateLabel(job)}</span> ·{' '}
                {job.progress}%
                {job.derivative !== undefined && (
                  <div className="job-derivative" aria-label="Verified derivative receipt">
                    Verified receipt · {job.derivative.bytes} B · SHA-256{' '}
                    {job.derivative.sha256.slice(0, 12)}… ·{' '}
                    {new Date(job.derivative.verifiedAt).toLocaleString()}
                  </div>
                )}
                {job.error !== undefined && ` · ${job.error}`}
              </div>
              <div>
                {(job.state === 'queued' || job.state === 'leased') && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Cancel job ${job.id}`}
                    title="Cancel job"
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
                    title="Retry job"
                    onClick={() => void client.retry(projectId, job.id).then(refresh).catch(report)}
                  >
                    <RefreshIcon />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );

  function report(error: unknown): void {
    setStatus(`Job action failed: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
