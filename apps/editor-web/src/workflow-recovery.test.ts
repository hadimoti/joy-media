import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { createStubFirstPartyLibrary } from './first-party-handlers.js';

const workflowId = 'joy.first-party.long-video-draft-reels';

function makeSession(id = 'recovery-project') {
  const values = new Map<string, string>();
  return new EditorSession(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    buildReferenceSpikeProject(),
    { ...INITIAL_EDITOR_PROJECT, id },
  );
}

function browserStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  vi.stubGlobal('localStorage', storage);
  return { values, storage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('project-bound workflow recovery', () => {
  it('reloads both approvals without rerunning completed nodes and removes the completed run', async () => {
    const { values } = browserStorage();
    const session = makeSession();
    let runner = await import('./workflow-runner.js');
    const first = await runner.runWorkflow(session, workflowId, { assetId: 'opaque-video' });
    expect(first).toMatchObject({ status: 'waiting_for_input', recovery: 'saved' });
    vi.resetModules();
    runner = await import('./workflow-runner.js');
    const reopened = makeSession();
    const parked = runner.listParkedWorkflowRuns(reopened)[0]!;
    expect(parked.runId).toBe(first.runId);
    const library = createStubFirstPartyLibrary();
    const handlers = Object.fromEntries(
      Object.entries(library.handlers).map(([id, handler]) => [id, vi.fn(handler)]),
    );
    runner.setFirstPartyLibraryForTests({ ...library, handlers });
    const payload = parked.request.payload as { candidates: unknown[] };
    const second = await runner.resumeWorkflow(reopened, parked.runId, {
      [parked.nodeId]: { candidates: payload.candidates.slice(0, 1) },
    });
    expect(second).toMatchObject({ status: 'waiting_for_input', nodeId: 'approve-drafts' });
    expect(handlers['analysis.transcribe']).not.toHaveBeenCalled();
    expect(handlers['analysis.hooks']).not.toHaveBeenCalled();
    vi.resetModules();
    runner = await import('./workflow-runner.js');
    const renderApproval = runner.listParkedWorkflowRuns(reopened)[0]!;
    const renderPayload = renderApproval.request.payload as { items: unknown[] };
    const completed = await runner.resumeWorkflow(reopened, renderApproval.runId, {
      [renderApproval.nodeId]: { approved: renderPayload.items },
    });
    expect(completed).toMatchObject({ status: 'succeeded', outputs: { deferred: true } });
    expect(values.has(runner.PARKED_RUNS_STORAGE_KEY)).toBe(false);
    vi.resetModules();
    runner = await import('./workflow-runner.js');
    expect(runner.listParkedWorkflowRuns(reopened)).toEqual([]);
    expect(await runner.resumeWorkflow(reopened, first.runId, {})).toMatchObject({
      status: 'failed',
    });
  });

  it('does not expose or resume another project approval', async () => {
    browserStorage();
    const runner = await import('./workflow-runner.js');
    const first = await runner.runWorkflow(makeSession('project-a'), workflowId, {
      assetId: 'opaque-a',
    });
    const other = makeSession('project-b');
    expect(runner.listParkedWorkflowRuns(other)).toEqual([]);
    expect(await runner.resumeWorkflow(other, first.runId, {})).toMatchObject({ status: 'failed' });
    runner.discardParkedWorkflowRun(other, first.runId);
    expect(runner.listParkedWorkflowRuns(makeSession('project-a'))).toHaveLength(1);
  });

  it('rejects an approval after the canonical project revision changes', async () => {
    browserStorage();
    const runner = await import('./workflow-runner.js');
    const session = makeSession();
    const first = await runner.runWorkflow(session, workflowId, { assetId: 'opaque-a' });
    session.dispatchCompound('Change project', {
      document: { ...session.visualProject, title: 'Changed' },
    });
    expect(await runner.resumeWorkflow(session, first.runId, {})).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Project changed'),
    });
    runner.discardParkedWorkflowRun(session, first.runId);
    expect(runner.listParkedWorkflowRuns(session)).toEqual([]);
  });

  it.each(['nodes', 'identity', 'workflow', 'request', 'legacy'])(
    'ignores a malformed or incompatible %s recovery record',
    async (corruption) => {
      const { values } = browserStorage();
      let runner = await import('./workflow-runner.js');
      const session = makeSession();
      await runner.runWorkflow(session, workflowId, { assetId: 'opaque-a' });
      const key = runner.PARKED_RUNS_STORAGE_KEY;
      const records = JSON.parse(values.get(key)!);
      if (corruption === 'nodes') records[0].checkpoint.nodes = null;
      if (corruption === 'identity') records[0].checkpoint.runId = 'different-run';
      if (corruption === 'workflow') records[0].workflow.version = '999.0.0';
      if (corruption === 'request') records[0].request = { kind: 'unknown' };
      if (corruption === 'legacy') delete records[0].projectId;
      values.set(key, JSON.stringify(records));
      vi.resetModules();
      runner = await import('./workflow-runner.js');
      expect(runner.listParkedWorkflowRuns(session)).toEqual([]);
    },
  );

  it('restores earlier runs before a new run writes storage and assigns unique identities', async () => {
    browserStorage();
    const session = makeSession();
    let runner = await import('./workflow-runner.js');
    const first = await runner.runWorkflow(session, workflowId, { assetId: 'one' });
    vi.resetModules();
    runner = await import('./workflow-runner.js');
    const second = await runner.runWorkflow(session, workflowId, { assetId: 'two' });
    expect(first.runId).not.toBe(second.runId);
    vi.resetModules();
    runner = await import('./workflow-runner.js');
    expect(runner.listParkedWorkflowRuns(session).map((run) => run.runId)).toEqual([
      first.runId,
      second.runId,
    ]);
  });

  it('reports session-only recovery when storage cannot save the checkpoint', async () => {
    const { storage } = browserStorage();
    storage.setItem = () => {
      throw new Error('Quota exceeded');
    };
    const runner = await import('./workflow-runner.js');
    const session = makeSession();
    expect(await runner.runWorkflow(session, workflowId, { assetId: 'one' })).toMatchObject({
      status: 'waiting_for_input',
      recovery: 'session-only',
    });
    expect(runner.listParkedWorkflowRuns(session)).toHaveLength(1);
  });

  it('ignores oversized storage without blocking the editor', async () => {
    const { values } = browserStorage();
    const runner = await import('./workflow-runner.js');
    values.set(runner.PARKED_RUNS_STORAGE_KEY, ' '.repeat(2 * 1024 * 1024 + 1));
    expect(runner.listParkedWorkflowRuns(makeSession())).toEqual([]);
  });
});
