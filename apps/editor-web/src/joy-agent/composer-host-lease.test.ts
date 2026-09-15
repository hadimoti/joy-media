import { describe, expect, it } from 'vitest';
import { resolveJoyAgentObservationAuthority } from './observation-run-authority.js';
import {
  createJoyAgentComposerHostLease,
  interruptJoyAgentComposerHostLease,
  isJoyAgentComposerHostLeaseCurrent,
  revokeJoyAgentComposerHostLease,
} from './composer-host-lease.js';
import { createJoyAgentRunController } from './run-controller.js';

const NOW = '2026-09-06T00:00:00.000Z';
const EXPECTED = {
  projectId: 'project-1',
  revision: 'revision-1',
  modelId: 'openrouter/model-a',
  promptPolicyDigest: 'a'.repeat(64),
} as const;

function controller() {
  return createJoyAgentRunController({
    projectId: EXPECTED.projectId,
    conversationId: 'conversation-1',
  });
}

function authorityFor(lease: ReturnType<typeof createJoyAgentComposerHostLease>) {
  return resolveJoyAgentObservationAuthority(EXPECTED, {
    ...EXPECTED,
    run: lease.run,
    terminal: !isJoyAgentComposerHostLeaseCurrent(lease),
  });
}

describe('JOY Composer host lease', () => {
  it('preserves App-owned lifecycle evidence across a Composer remount while stale host authority fails', () => {
    const subject = controller();
    subject.start({ runId: 'run-1', epoch: 1, at: NOW });
    const detachedComposer = createJoyAgentComposerHostLease(subject, {
      runId: 'run-1',
      epoch: 1,
    });

    expect(authorityFor(detachedComposer)).toMatchObject({ run: { runId: 'run-1', epoch: 1 } });
    revokeJoyAgentComposerHostLease(detachedComposer);

    // A Dockview remount reads the same App-owned controller. It must not
    // revive the detached closure's host authority or erase lifecycle state.
    expect(subject.getSnapshot()).toMatchObject({
      state: 'inspecting',
      run: { scope: { seq: 0 } },
    });
    const remountedComposer = createJoyAgentComposerHostLease(subject, {
      runId: 'run-1',
      epoch: 1,
    });
    expect(authorityFor(detachedComposer)).toBeUndefined();
    expect(authorityFor(remountedComposer)).toMatchObject({ run: { runId: 'run-1', epoch: 1 } });
  });

  it('does not let a stale teardown interrupt a newer controller run', () => {
    const subject = controller();
    subject.start({ runId: 'run-1', epoch: 1, at: NOW });
    const oldLease = createJoyAgentComposerHostLease(subject, { runId: 'run-1', epoch: 1 });
    expect(subject.interrupt('2026-09-06T00:00:01.000Z').accepted).toBe(true);
    subject.start({ runId: 'run-2', epoch: 1, at: '2026-09-06T00:00:02.000Z' });

    expect(
      interruptJoyAgentComposerHostLease(
        oldLease,
        '2026-09-06T00:00:03.000Z',
        'Old Composer teardown',
      ),
    ).toBe(false);
    expect(subject.getSnapshot()).toMatchObject({
      state: 'inspecting',
      run: { scope: { runId: 'run-2', epoch: 1 } },
    });
  });

  it('lets genuine workspace teardown interrupt the exact live run and revoke its host lease', () => {
    const subject = controller();
    subject.start({ runId: 'run-1', epoch: 1, at: NOW });
    const lease = createJoyAgentComposerHostLease(subject, { runId: 'run-1', epoch: 1 });

    expect(
      interruptJoyAgentComposerHostLease(lease, '2026-09-06T00:00:01.000Z', 'Workspace closed.'),
    ).toBe(true);
    expect(subject.getSnapshot()).toMatchObject({ state: 'interrupted' });
    expect(isJoyAgentComposerHostLeaseCurrent(lease)).toBe(false);
    expect(authorityFor(lease)).toBeUndefined();
  });
});
