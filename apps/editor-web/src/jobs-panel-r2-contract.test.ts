// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserControlPlaneClient, type BrowserWorker } from './control-plane-client.js';
import { JobsPanel } from './JobsPanel.js';
import {
  queueWorkerReadiness,
  workerAudioDenoiseOperationId,
  workerResultWasApplied,
} from './JobsPanel.js';

// jsdom runs transform the module URL to http, so the source is read through Vite instead.
const panelSource = import.meta.glob('./JobsPanel.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
})['./JobsPanel.tsx'] as string;

describe('JobsPanel R2 exactly-once contract', () => {
  it('treats applied terminal states as non-reviewable', () => {
    expect(workerResultWasApplied('applied')).toBe(true);
    expect(workerResultWasApplied('completed')).toBe(true);
    expect(workerResultWasApplied('review')).toBe(false);
    expect(workerResultWasApplied(undefined)).toBe(false);
  });

  it('scopes stable Worker job IDs to the owning project', () => {
    expect(workerAudioDenoiseOperationId('project-a', 'asset-1')).toBe(
      'audio-denoise-project-a-asset-1',
    );
    expect(workerAudioDenoiseOperationId('project-a', 'asset-1')).not.toBe(
      workerAudioDenoiseOperationId('project-b', 'asset-1'),
    );
  });

  it('preserves action feedback across refreshes', () => {
    expect(panelSource).toContain('const [connectionStatus, setConnectionStatus]');
    expect(panelSource).toContain('note={status ?? connectionStatus}');
  });

  it('bootstraps each project once before polling jobs and never reuses a previous project state', () => {
    expect(panelSource).toMatch(/if \(projectScopeReady\) \{\s+setJobs\(nextJobs\);/);
    expect(panelSource).toContain("projectId.startsWith('project-')");
    expect(panelSource).toContain('const projectInitialized = initializedProjectId === projectId;');
    expect(panelSource).toContain(
      'if (!projectInitialized) await client.ensureProject(projectId, projectTitle);',
    );
    expect(panelSource).toContain(
      'setInitializedProjectId(projectMissing ? undefined : projectId);',
    );
    expect(panelSource).toContain(
      'setConnectionStatus(projectJobStatus(projectMissing, nextWorkers));',
    );
  });

  it('never reconstructs a ledger key from an asset after review has completed', () => {
    expect(panelSource).toContain("operationLedger.finish(job.id, 'review'");
    expect(panelSource).toContain('if (operationLedger.get(job.id) === undefined)');
    expect(panelSource).toContain("operationLedger?.finish(review.jobId, 'applied'");
    expect(panelSource).toContain("operationLedger?.finish(review.jobId, 'cancelled'");
    expect(panelSource).not.toContain('finish(`audio-denoise-${review.sourceAssetId}`');
  });

  it('queues thumbnails only for the selected real media asset', () => {
    expect(panelSource).toContain('thumbnailAssetId');
    expect(panelSource).toContain('await client.associateAsset(projectId, thumbnailAssetId);');
    expect(panelSource).toContain('client.enqueueAssetThumbnail');
    expect(panelSource).not.toContain('enqueueFixture');
  });

  it('requires one connected Worker to have both the capability and selected source', () => {
    const readiness = queueWorkerReadiness(
      [
        worker({ id: 'worker-capability-only', localAssetIds: ['another-asset'] }),
        worker({ id: 'worker-ready', localAssetIds: ['asset-1'] }),
      ],
      'audio.ml-denoise',
      'asset-1',
    );

    expect(readiness).toMatchObject({ kind: 'ready', worker: { id: 'worker-ready' } });
    expect(
      queueWorkerReadiness(
        [worker({ id: 'worker-capability-only', localAssetIds: ['another-asset'] })],
        'audio.ml-denoise',
        'asset-1',
      ),
    ).toEqual({
      kind: 'source-unavailable',
      reason: 'No connected capable Worker has this media source locally yet.',
    });
    expect(
      queueWorkerReadiness([worker({ capabilities: [] })], 'audio.ml-denoise', 'asset-1'),
    ).toEqual({
      kind: 'missing-capability',
      reason: 'No connected Worker advertises audio.ml-denoise.',
    });
    expect(panelSource).toContain('const queueReadiness = useMemo(');
    expect(panelSource).toContain("if (queueReadiness.kind !== 'ready')");
    expect(panelSource).toContain('queueUnavailableReason !== undefined');
  });

  it('associates audio sources before queueing a project-scoped Worker operation', () => {
    expect(panelSource).toContain('await client.associateAsset(projectId, audioAssetId);');
    expect(panelSource).toContain(
      "client.enqueueWorkerGeneration(projectId, jobId, 'audio.ml-denoise', audioAssetId)",
    );
  });
});

describe('JobsPanel local Worker controls', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  it('keeps local Worker status and Queue while omitting pairing and revocation controls', async () => {
    vi.spyOn(BrowserControlPlaneClient.prototype, 'workers').mockResolvedValue([
      worker({ lastSeenAt: Date.now() }),
    ]);
    vi.spyOn(BrowserControlPlaneClient.prototype, 'ensureProject').mockResolvedValue();
    vi.spyOn(BrowserControlPlaneClient.prototype, 'jobs').mockResolvedValue([]);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(JobsPanel, { projectId: 'project-a', projectTitle: 'Project A' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabs).toEqual(['Workers', 'Queue']);
    expect(container.querySelector('[aria-label="One-time pairing code"]')).toBeNull();
    expect(container.querySelector('[aria-label="Revoke Worker worker-1"]')).toBeNull();
    expect(container.textContent).toContain('worker-1');
    expect(container.textContent).toContain('connected');
  });
});

function worker(input: Partial<BrowserWorker>): BrowserWorker {
  return {
    id: 'worker-1',
    paired: true,
    revoked: false,
    capabilities: ['audio.ml-denoise'],
    lastSeenAt: Date.now(),
    ...input,
  };
}
