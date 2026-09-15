import { describe, expect, it, vi } from 'vitest';
import {
  createJoyAgentRunController,
  isJoyAgentRunControllerSnapshot,
  type JoyAgentRunController,
} from './run-controller.js';
import type { JoyAgentRunArtifactReference, JoyAgentRunEvent } from './run-events.js';

const PROJECT_ID = 'project-1';
const CONVERSATION_ID = 'conversation-1';
const NOW = '2026-09-06T00:00:00.000Z';

function controller(): JoyAgentRunController {
  return createJoyAgentRunController({ projectId: PROJECT_ID, conversationId: CONVERSATION_ID });
}

function event(
  controllerInstance: JoyAgentRunController,
  seq: number,
  state: JoyAgentRunEvent['state'],
  overrides: Partial<JoyAgentRunEvent> = {},
): JoyAgentRunEvent {
  const run = controllerInstance.getSnapshot().run;
  if (run === undefined) throw new Error('Start a run before creating an event');
  return {
    version: 1,
    scope: { ...run.scope, seq },
    state,
    at: `2026-09-06T00:00:0${Math.min(seq, 9)}.000Z`,
    ...overrides,
  };
}

const prepared: JoyAgentRunArtifactReference = {
  kind: 'prepared-change',
  id: 'change-set-1',
  version: 1,
};
const receipt: JoyAgentRunArtifactReference = {
  kind: 'execution-receipt',
  id: 'receipt-1',
  version: 1,
};

describe('JOY project run controller', () => {
  it('owns a project/run/epoch scope and ignores stale, wrong-project and wrong-epoch events', () => {
    const subject = controller();
    const subscriber = vi.fn();
    subject.subscribe(subscriber);
    subject.start({ runId: 'run-1', epoch: 4, at: NOW });
    expect(subject.getSnapshot()).toMatchObject({
      state: 'inspecting',
      run: { scope: { seq: 0 } },
    });

    expect(subject.accept(event(subject, 1, 'preparing')).accepted).toBe(true);
    expect(
      subject.accept(
        event(subject, 2, 'preview-ready', {
          scope: { projectId: 'project-2', runId: 'run-1', epoch: 4, seq: 2 },
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'scope-mismatch' });
    expect(
      subject.accept(
        event(subject, 2, 'preview-ready', {
          scope: { projectId: PROJECT_ID, runId: 'run-1', epoch: 5, seq: 2 },
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'scope-mismatch' });
    expect(subject.accept(event(subject, 1, 'preview-ready'))).toMatchObject({
      accepted: false,
      reason: 'non-monotonic-sequence',
    });
    expect(subject.accept(event(subject, 5, 'preview-ready')).accepted).toBe(true);
    expect(subject.getSnapshot().run?.scope.seq).toBe(5);
    expect(subscriber).toHaveBeenCalledTimes(3);
  });

  it('keeps change-set versions monotonic and rejects a forged replacement under the same version', () => {
    const subject = controller();
    subject.start({ runId: 'run-1', epoch: 1, at: NOW });
    subject.accept(event(subject, 1, 'preparing'));
    expect(
      subject.accept(
        event(subject, 2, 'preview-ready', {
          changeSetVersion: 1,
          artifacts: [prepared],
        }),
      ).accepted,
    ).toBe(true);
    expect(
      subject.accept(
        event(subject, 3, 'preview-ready', {
          changeSetVersion: 1,
          artifacts: [{ kind: 'prepared-change', id: 'change-set-forged', version: 1 }],
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'prepared-change-conflict' });
    expect(
      subject.accept(event(subject, 3, 'preview-ready', { changeSetVersion: 0 })),
    ).toMatchObject({ accepted: false, reason: 'change-set-regression' });
    expect(
      subject.accept(
        event(subject, 3, 'preview-ready', {
          changeSetVersion: 2,
          artifacts: [{ kind: 'prepared-change', id: 'change-set-2', version: 2 }],
        }),
      ).accepted,
    ).toBe(true);
    expect(subject.getSnapshot().run?.changeSetVersion).toBe(2);
  });

  it('records cancellation without claiming a committed receipt did not happen', () => {
    const subject = controller();
    subject.start({ runId: 'run-1', epoch: 1, at: NOW });
    subject.accept(event(subject, 1, 'preparing'));
    subject.accept(
      event(subject, 2, 'preview-ready', { changeSetVersion: 1, artifacts: [prepared] }),
    );
    subject.accept(event(subject, 3, 'awaiting-approval'));
    subject.accept(event(subject, 4, 'committing', { artifacts: [receipt] }));

    expect(subject.requestCancel('2026-09-06T00:00:05.000Z').accepted).toBe(true);
    expect(subject.getSnapshot()).toMatchObject({ state: 'cancel-requested' });
    expect(subject.getSnapshot().run?.artifacts).toEqual(expect.arrayContaining([receipt]));
    expect(subject.accept(event(subject, 6, 'cancelled'))).toMatchObject({
      accepted: false,
      reason: 'false-cancel-after-commit',
    });
    expect(subject.accept(event(subject, 6, 'verifying')).accepted).toBe(true);
    expect(subject.accept(event(subject, 7, 'completed')).accepted).toBe(true);
  });

  it('interrupts receipt-bearing verification instead of falsely cancelling a committed edit', () => {
    const subject = controller();
    subject.start({ runId: 'run-1', epoch: 1, at: NOW });
    subject.accept(event(subject, 1, 'preparing'));
    subject.accept(
      event(subject, 2, 'preview-ready', { changeSetVersion: 1, artifacts: [prepared] }),
    );
    subject.accept(event(subject, 3, 'awaiting-approval'));
    subject.accept(event(subject, 4, 'committing', { artifacts: [receipt] }));
    subject.accept(event(subject, 5, 'verifying'));

    expect(
      subject.interrupt(
        '2026-09-06T00:00:06.000Z',
        'JOY’s connection changed while verification was pending. Reconnect before continuing.',
      ),
    ).toMatchObject({ accepted: true });
    expect(subject.getSnapshot()).toMatchObject({
      state: 'interrupted',
      run: { state: 'interrupted', artifacts: expect.arrayContaining([receipt]) },
    });
  });

  it('rejects a late cancellation event that tries to attach a commit receipt', () => {
    const subject = controller();
    subject.start({ runId: 'run-1', epoch: 1, at: NOW });
    subject.accept(event(subject, 1, 'preparing'));
    subject.accept(
      event(subject, 2, 'preview-ready', { changeSetVersion: 1, artifacts: [prepared] }),
    );
    subject.accept(event(subject, 3, 'awaiting-approval'));
    expect(subject.requestCancel('2026-09-06T00:00:04.000Z').accepted).toBe(true);

    expect(subject.accept(event(subject, 5, 'cancelled', { artifacts: [receipt] }))).toMatchObject({
      accepted: false,
      reason: 'false-cancel-after-commit',
    });
  });

  it('turns a restored nonterminal checkpoint into interrupted and requires a new epoch to restart', () => {
    const original = controller();
    original.start({ runId: 'run-1', epoch: 3, at: NOW });
    original.accept(event(original, 1, 'preparing'));
    original.accept(
      event(original, 2, 'preview-ready', { changeSetVersion: 1, artifacts: [prepared] }),
    );
    original.accept(event(original, 3, 'awaiting-approval'));
    const checkpoint = original.getSnapshot();
    expect(isJoyAgentRunControllerSnapshot(checkpoint)).toBe(true);
    expect(checkpoint).not.toHaveProperty('approvalId');

    const remounted = controller();
    expect(remounted.restore(checkpoint, '2026-09-06T00:01:00.000Z')).toBe(true);
    expect(remounted.getSnapshot()).toMatchObject({
      state: 'interrupted',
      run: { state: 'interrupted', errorCode: 'JOY_AGENT_INTERRUPTED' },
    });
    expect(remounted.accept(event(remounted, 4, 'committing'))).toMatchObject({
      accepted: false,
      reason: 'invalid-transition',
    });
    expect(() =>
      remounted.start({ runId: 'run-1', epoch: 3, at: '2026-09-06T00:02:00.000Z' }),
    ).toThrow('JOY_AGENT_RUN_EPOCH_REUSED');
    expect(
      remounted.start({ runId: 'run-1', epoch: 4, at: '2026-09-06T00:02:00.000Z' }),
    ).toMatchObject({
      state: 'inspecting',
      run: { scope: { epoch: 4, seq: 0 } },
    });
  });

  it('rejects a safe checkpoint owned by a different project conversation', () => {
    const original = controller();
    original.start({ runId: 'run-1', epoch: 1, at: NOW });
    const foreignConversationCheckpoint = {
      ...original.getSnapshot(),
      conversationId: 'conversation-2',
    };
    const remounted = controller();

    expect(remounted.restore(foreignConversationCheckpoint, '2026-09-06T00:01:00.000Z')).toBe(
      false,
    );
    expect(remounted.getSnapshot()).toMatchObject({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      state: 'idle',
    });
  });
});
