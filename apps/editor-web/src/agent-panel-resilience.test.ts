import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { legacyRecipeExecutionEnabled, noEditsAppliedFailureMessage } from './AgentPanel.js';

const panelSource = readFileSync(new URL('./AgentPanel.tsx', import.meta.url), 'utf8');

describe('AgentPanel durable execution boundary', () => {
  it('keeps the pre-receipt deterministic recipe executor permanently disabled', () => {
    expect(legacyRecipeExecutionEnabled()).toBe(false);
  });
});

describe('noEditsAppliedFailureMessage', () => {
  it('appends a no-edits-applied sentence to an Error message', () => {
    const result = noEditsAppliedFailureMessage(
      new Error('Provider returned 503.'),
      'The run failed safely.',
    );
    expect(result).toMatch(/no edits?\s+(?:were\s+)?applied/i);
    expect(result).toContain('Provider returned 503.');
    expect(result).not.toContain('The run failed safely.');
  });

  it('returns the supplied fallback when the argument is not an Error', () => {
    const result = noEditsAppliedFailureMessage('plain string', 'The run failed safely.');
    expect(result).toMatch(/no edits?\s+(?:were\s+)?applied/i);
    expect(result).toContain('The run failed safely.');
  });
});

describe('AgentPanel stop cancellation messaging', () => {
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
      'const commandRunId = agentRunId',
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
