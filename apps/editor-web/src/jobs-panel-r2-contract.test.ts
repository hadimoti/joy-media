import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { workerAudioDenoiseOperationId, workerResultWasApplied } from './JobsPanel.js';

const panelSource = readFileSync(new URL('./JobsPanel.tsx', import.meta.url), 'utf8');

describe('JobsPanel R2 pairing and exactly-once contract', () => {
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

  it('uses guarded form submission and preserves action feedback across refreshes', () => {
    expect(panelSource).toContain('const [connectionStatus, setConnectionStatus]');
    expect(panelSource).toContain('note={status ?? connectionStatus}');
    expect(panelSource).toContain('if (pairBusyRef.current) return;');
    expect(panelSource).toContain('onSubmit={(event) => {');
    expect(panelSource).toContain("{pairBusy ? 'Approving…' : 'Approve'}");
    expect(panelSource).toContain('connected successfully.');
    expect(panelSource).toContain('no restart is');
  });

  it('does not reset initialized state during the pre-binding readiness probe', () => {
    expect(panelSource).toMatch(/if \(projectScopeReady\) \{\s+setJobs\(nextJobs\);/);
    expect(panelSource).toContain("projectId.startsWith('project-')");
    expect(panelSource).toContain('await client.ensureProject(projectId, projectTitle);');
    expect(panelSource).toContain('setProjectInitialized(!projectMissing);');
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

  it('associates audio sources before queueing a project-scoped Worker operation', () => {
    expect(panelSource).toContain('await client.associateAsset(projectId, audioAssetId);');
    expect(panelSource).toContain(
      "client.enqueueWorkerGeneration(projectId, jobId, 'audio.ml-denoise', audioAssetId)",
    );
  });
});
