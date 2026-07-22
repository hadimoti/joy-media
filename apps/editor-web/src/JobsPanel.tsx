import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BrowserControlPlaneClient,
  type BrowserJob,
  type BrowserWorker,
} from './control-plane-client.js';

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
  const [status, setStatus] = useState('Checking JOY Media connection…');
  const refresh = useCallback(async () => {
    try {
      const [nextWorkers, nextJobs] = await Promise.all([client.workers(), client.jobs(projectId)]);
      setWorkers(nextWorkers);
      setJobs(nextJobs);
      setStatus(
        nextWorkers.some(isConnected) ? 'Connected Worker available' : 'No connected Worker',
      );
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
  const submit = async () => {
    try {
      try {
        await client.createProject(projectId, projectTitle);
      } catch (error) {
        if (!message(error).includes('PROJECT_EXISTS')) throw error;
      }
      await client.enqueueFixture(projectId, `fixture-thumbnail-${crypto.randomUUID()}`);
      setStatus('Fixture thumbnail queued for a paired local Worker.');
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
        <strong>Pair local Worker</strong>
        <label>
          Worker ID
          <input value={workerId} onChange={(event) => setWorkerId(event.target.value)} />
        </label>
        <label>
          One-time pairing code
          <input
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
            autoComplete="off"
          />
        </label>
        <button disabled={!workerId.trim() || !pairingCode.trim()} onClick={() => void pair()}>
          Approve pairing
        </button>
      </section>
      <section>
        <button onClick={() => void submit()}>Queue fixture thumbnail</button>
      </section>
      <ul className="jobs-workers" aria-label="Paired Workers">
        {workers.map((worker) => (
          <li key={worker.id}>
            <strong>{worker.id}</strong> ·{' '}
            {worker.revoked ? 'revoked' : isConnected(worker) ? 'connected' : 'disconnected'}
            {worker.capabilities.length > 0 && ` · ${worker.capabilities.join(', ')}`}
          </li>
        ))}
      </ul>
      <ul className="jobs-list" aria-label="Project jobs">
        {jobs.map((job) => (
          <li key={job.id}>
            <div>
              <strong>{job.type}</strong> · {job.state} · {job.progress}%
              {job.cancelRequested && ' · cancel requested'}
              {job.result !== undefined && ` · verified ${job.result.bytes} B receipt`}
              {job.error !== undefined && ` · ${job.error}`}
            </div>
            <div>
              {(job.state === 'queued' || job.state === 'leased') && (
                <button
                  onClick={() => void client.cancel(projectId, job.id).then(refresh).catch(report)}
                >
                  Cancel
                </button>
              )}
              {(job.state === 'canceled' ||
                job.state === 'failed' ||
                job.state === 'completed') && (
                <button
                  onClick={() => void client.retry(projectId, job.id).then(refresh).catch(report)}
                >
                  Retry
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </article>
  );

  function report(error: unknown): void {
    setStatus(`Job action failed: ${message(error)}`);
  }
}

function isConnected(worker: BrowserWorker): boolean {
  return worker.lastSeenAt !== undefined && worker.lastSeenAt > Date.now() - 35_000;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
