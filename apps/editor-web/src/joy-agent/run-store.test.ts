import { describe, expect, it } from 'vitest';
import { createJoyAgentRunController } from './run-controller.js';
import {
  createJoyAgentRunStore,
  joyAgentRunCheckpointStorageKey,
  parseJoyAgentRunCheckpoint,
  serializeJoyAgentRunCheckpoint,
} from './run-store.js';

function snapshot(projectId = 'project-1') {
  const controller = createJoyAgentRunController({
    projectId,
    conversationId: `conversation-${projectId}`,
  });
  controller.start({ runId: `run-${projectId}`, epoch: 1, at: '2026-09-06T00:00:00.000Z' });
  return controller.getSnapshot();
}

describe('JOY run checkpoint store', () => {
  it('uses a stable encoded project key for browser checkpoint persistence', () => {
    expect(joyAgentRunCheckpointStorageKey('project:one=two')).toBe(
      'joy-media.joy-agent-run-checkpoint.v1:project%3Aone%3Dtwo',
    );
    expect(() => joyAgentRunCheckpointStorageKey('project/unsafe')).toThrow(
      'JOY_AGENT_RUN_PROJECT_INVALID',
    );
  });

  it('round-trips only a defensive safe lifecycle checkpoint by project', () => {
    const store = createJoyAgentRunStore();
    const first = snapshot('project-1');
    const second = snapshot('project-2');
    const saved = store.save(first);
    store.save(second);

    expect(store.get('project-1')).toEqual(saved);
    expect(store.get('project-2')?.snapshot.projectId).toBe('project-2');
    const serialized = store.serialize('project-1');
    if (serialized === undefined) throw new Error('Missing stored checkpoint');
    expect(parseJoyAgentRunCheckpoint(serialized)).toEqual(saved);
    expect(serializeJoyAgentRunCheckpoint(saved)).toBe(serialized);

    const copy = store.get('project-1');
    if (copy === undefined) throw new Error('Missing defensive checkpoint copy');
    const mutable = copy as unknown as { snapshot: { projectId: string } };
    try {
      mutable.snapshot.projectId = 'mutated-project';
    } catch {
      // Frozen copies are expected; detached copies are also safe.
    }
    expect(store.get('project-1')?.snapshot.projectId).toBe('project-1');
  });

  it('rejects stored values that try to revive approval or provider-secret authority', () => {
    const safe = JSON.parse(
      serializeJoyAgentRunCheckpoint({ version: 1, snapshot: snapshot() }),
    ) as {
      version: number;
      snapshot: Record<string, unknown>;
    };
    expect(
      parseJoyAgentRunCheckpoint(
        JSON.stringify({ ...safe, snapshot: { ...safe.snapshot, approvalId: 'forged-approval' } }),
      ),
    ).toBeUndefined();
    expect(
      parseJoyAgentRunCheckpoint(
        JSON.stringify({ ...safe, snapshot: { ...safe.snapshot, apiKey: 'fixture-only' } }),
      ),
    ).toBeUndefined();
    expect(
      parseJoyAgentRunCheckpoint(
        JSON.stringify({ ...safe, snapshot: { ...safe.snapshot, provider: 'openrouter' } }),
      ),
    ).toBeUndefined();
  });

  it('imports a valid checkpoint without merging it into another project', () => {
    const source = createJoyAgentRunStore();
    source.save(snapshot('project-export'));
    const serialized = source.serialize('project-export');
    if (serialized === undefined) throw new Error('Missing checkpoint export');

    const destination = createJoyAgentRunStore();
    destination.save(snapshot('project-existing'));
    expect(destination.import(serialized)?.snapshot.projectId).toBe('project-export');
    expect(destination.get('project-existing')?.snapshot.projectId).toBe('project-existing');
    expect(destination.get('project-export')?.snapshot.projectId).toBe('project-export');
  });
});
