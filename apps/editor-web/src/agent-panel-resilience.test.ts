import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as agentPanel from './AgentPanel.js';

const panelSource = readFileSync(new URL('./AgentPanel.tsx', import.meta.url), 'utf8');

describe('AgentPanel durable execution boundary', () => {
  it('keeps the pre-receipt deterministic recipe executor permanently disabled', () => {
    expect(agentPanel.legacyRecipeExecutionEnabled()).toBe(false);
  });
});

describe('noEditsAppliedFailureMessage', () => {
  it('appends a no-edits-applied sentence to an Error message', () => {
    const result = agentPanel.noEditsAppliedFailureMessage(
      new Error('Provider returned 503.'),
      'The run failed safely.',
    );
    expect(result).toMatch(/no edits?\s+(?:were\s+)?applied/i);
    expect(result).toContain('Provider returned 503.');
    expect(result).not.toContain('The run failed safely.');
  });

  it('returns the supplied fallback when the argument is not an Error', () => {
    const result = agentPanel.noEditsAppliedFailureMessage(
      'plain string',
      'The run failed safely.',
    );
    expect(result).toMatch(/no edits?\s+(?:were\s+)?applied/i);
    expect(result).toContain('The run failed safely.');
  });
});

describe('AgentPanel stop cancellation messaging', () => {
  it('does not target a run that remains only in terminal presence and lifecycle state', () => {
    expect(
      agentPanel.selectActiveJoyAgentRunId(
        'completed-run',
        { runId: 'completed-run', status: 'completed' },
        { scope: { runId: 'completed-run' }, state: 'completed' },
      ),
    ).toBeUndefined();
  });

  it('uses the active presence run when the stored agent id belongs to a completed run', () => {
    expect(
      agentPanel.selectActiveJoyAgentRunId(
        'completed-run',
        { runId: 'active-run', status: 'active' },
        { scope: { runId: 'completed-run' }, state: 'completed' },
      ),
    ).toBe('active-run');
  });

  it('prefers the new active run over a stale id when its lifecycle has moved on', () => {
    expect(
      agentPanel.selectActiveJoyAgentRunId(
        'completed-run',
        { runId: 'active-run', status: 'active' },
        { scope: { runId: 'active-run' }, state: 'inspecting' },
      ),
    ).toBe('active-run');
  });

  it('prefers the active presence run over a stale id before lifecycle state exists', () => {
    expect(
      agentPanel.selectActiveJoyAgentRunId(
        'completed-run',
        { runId: 'active-run', status: 'active' },
        undefined,
      ),
    ).toBe('active-run');
  });

  it('does not resurrect an older id after a later run has completed', () => {
    expect(
      agentPanel.selectActiveJoyAgentRunId(
        'older-run',
        { runId: 'newer-run', status: 'completed' },
        { scope: { runId: 'newer-run' }, state: 'completed' },
      ),
    ).toBeUndefined();
  });

  it('does not select a stored id when presence is idle without an active lifecycle', () => {
    expect(
      agentPanel.selectActiveJoyAgentRunId(
        'stale-run',
        { runId: undefined, status: 'idle' },
        undefined,
      ),
    ).toBeUndefined();
  });

  it('keeps the current run stoppable during presence warm-up', () => {
    expect(
      agentPanel.selectActiveJoyAgentRunId(
        'starting-run',
        { runId: 'starting-run', status: 'idle' },
        undefined,
      ),
    ).toBe('starting-run');
  });

  it('keeps Stop confirmation immediate because cancelling revokes the async event stream', () => {
    expect(panelSource).toContain('if (recipeCancelled || commandRunId !== undefined) {');
    expect(panelSource).toContain('if (recipeCancelled || activeRunId !== undefined) {');
    expect(panelSource).toContain(
      "if (event.phase === 'cancelled')\n              appendMessage(threadId, 'assistant', 'JOY run cancelled. No edits were applied.');",
    );
  });

  it('rejects a pending proposal before reaching engine cancellation', () => {
    const pendingStopStart = panelSource.indexOf(
      "if (command.type === 'stop' && pending !== undefined) {",
    );
    const runCancellationStart = panelSource.indexOf(
      'const commandRunId = selectActiveJoyAgentRunId',
      pendingStopStart,
    );
    const pendingStop = panelSource.slice(pendingStopStart, runCancellationStart);

    expect(pendingStopStart).toBeGreaterThanOrEqual(0);
    expect(runCancellationStart).toBeGreaterThan(pendingStopStart);
    expect(pendingStop).toContain('setPending(undefined);');
    expect(pendingStop).toContain('clearAgentPreviewForSourceRun(pending.runId);');
    expect(pendingStop).toContain('return;');
    expect(panelSource).toMatch(/pending === undefined &&\s*\(liveAgentPhase === 'thinking'/);
  });
});
