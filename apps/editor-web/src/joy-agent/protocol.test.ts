import { describe, expect, it } from 'vitest';
import { isWorkerToMainMessage } from './protocol.js';

describe('JOY Agent Worker protocol', () => {
  it('rejects version mismatches and secret-bearing proposals', () => {
    expect(isWorkerToMainMessage({ protocolVersion: 2, type: 'event' })).toBe(false);
    expect(
      isWorkerToMainMessage({
        protocolVersion: 1,
        type: 'event',
        event: {
          protocolVersion: 1,
          runId: 'run-1',
          seq: 1,
          phase: 'previewing',
          proposal: {
            summary: 'x',
            baseRevision: 'r1',
            operations: [{ endpoint: 'https://secret.invalid' }],
          },
        },
      }),
    ).toBe(false);
  });

  it('accepts only bounded phases and public connection status', () => {
    expect(
      isWorkerToMainMessage({
        protocolVersion: 1,
        type: 'event',
        event: { protocolVersion: 1, runId: 'run-1', seq: 1, phase: 'thinking' },
      }),
    ).toBe(true);
    expect(
      isWorkerToMainMessage({
        protocolVersion: 1,
        type: 'event',
        event: { protocolVersion: 1, runId: 'run-1', seq: 1, phase: 'provider-secret' },
      }),
    ).toBe(false);
    expect(
      isWorkerToMainMessage({
        protocolVersion: 1,
        type: 'event',
        event: {
          protocolVersion: 1,
          runId: 'run-1',
          seq: 2,
          phase: 'failed',
          errorCode: 'JOY_AGENT_AUTH_FAILED',
          message: 'Provider authentication failed',
        },
      }),
    ).toBe(true);
    expect(
      isWorkerToMainMessage({
        protocolVersion: 1,
        type: 'event',
        event: {
          protocolVersion: 1,
          runId: 'run-1',
          seq: 3,
          phase: 'failed',
          errorCode: 'LEAKED_SECRET',
        },
      }),
    ).toBe(false);
    expect(
      isWorkerToMainMessage({
        protocolVersion: 1,
        type: 'test-result',
        status: {
          provider: 'openrouter',
          modelId: 'openrouter/auto',
          capability: 'tool-loop',
          apiKey: 'never-forward',
        },
      }),
    ).toBe(false);
    expect(
      isWorkerToMainMessage({
        protocolVersion: 1,
        type: 'event',
        event: {
          protocolVersion: 1,
          runId: 'brief-1',
          seq: 2,
          phase: 'completed',
          taskKind: 'creative-brief',
          result: { schemaVersion: 1, projectId: 'p', snapshotRevisionId: 'r' },
        },
      }),
    ).toBe(true);
    expect(
      isWorkerToMainMessage({
        protocolVersion: 1,
        type: 'event',
        event: {
          protocolVersion: 1,
          runId: 'brief-1',
          seq: 2,
          phase: 'completed',
          taskKind: 'creative-brief',
          result: { apiKey: 'secret' },
        },
      }),
    ).toBe(false);
  });
});
