import { describe, expect, it, vi } from 'vitest';
import {
  captureControlPlaneScope,
  scopeStillHeld,
  SESSION_LEFT_PROJECT_MESSAGE,
  SESSION_REQUIRED_MESSAGE,
  startProjectScopeCheck,
  type ControlPlaneScope,
} from './control-plane-scope.js';

function liveScope(initial: ControlPlaneScope) {
  let scope = initial;
  return {
    current: () => scope,
    set: (next: ControlPlaneScope) => {
      scope = next;
    },
  };
}

const READY: ControlPlaneScope = {
  ownerKey: 'owner-1',
  projectId: 'project-1',
  generation: 1,
  token: 'token-1',
};

describe('captureControlPlaneScope', () => {
  it('passes while the owner, project, token and readiness are unchanged', () => {
    const session = liveScope(READY);
    const check = captureControlPlaneScope(session.current);

    expect(() => check()).not.toThrow();
  });

  it('refuses once the session signs out', () => {
    const session = liveScope(READY);
    const check = captureControlPlaneScope(session.current);
    session.set({
      ownerKey: undefined,
      projectId: 'unbound-editor-1',
      generation: 2,
      token: undefined,
    });

    expect(() => check()).toThrow(SESSION_LEFT_PROJECT_MESSAGE);
  });

  it('refuses once another owner takes the session', () => {
    const session = liveScope(READY);
    const check = captureControlPlaneScope(session.current);
    session.set({ ownerKey: 'owner-2', projectId: 'project-2', generation: 2, token: 'token-2' });

    expect(() => check()).toThrow(SESSION_LEFT_PROJECT_MESSAGE);
  });

  it('refuses when the stored token changes before the editor has probed the session again', () => {
    const session = liveScope(READY);
    const check = captureControlPlaneScope(session.current);
    session.set({ ...READY, token: 'token-other' });

    expect(() => check()).toThrow(SESSION_LEFT_PROJECT_MESSAGE);
  });

  it('refuses after the same owner signs out and back in to the same project', () => {
    const session = liveScope(READY);
    const check = captureControlPlaneScope(session.current);
    session.set({
      ownerKey: undefined,
      projectId: 'unbound-editor-1',
      generation: 2,
      token: undefined,
    });
    session.set({ ...READY, generation: 3 });

    expect(() => check()).toThrow(SESSION_LEFT_PROJECT_MESSAGE);
  });

  it('refuses an operation that starts without a ready owner, as a missing session', () => {
    const session = liveScope({
      ownerKey: undefined,
      projectId: 'unbound-editor-1',
      generation: 1,
      token: 'token-1',
    });
    const check = captureControlPlaneScope(session.current);

    expect(() => check()).toThrow(SESSION_REQUIRED_MESSAGE);
  });

  it('refuses an operation that starts without a stored session token, as a missing session', () => {
    const session = liveScope({ ...READY, token: undefined });
    const check = captureControlPlaneScope(session.current);

    expect(() => check()).toThrow(SESSION_REQUIRED_MESSAGE);
  });
});

describe('startProjectScopeCheck', () => {
  it('runs the check captured from the live scope', () => {
    const session = liveScope(READY);
    const check = startProjectScopeCheck(
      (projectId) => captureControlPlaneScope(() => ({ ...session.current(), projectId })),
      'project-1',
    );

    expect(() => check()).not.toThrow();
    session.set({ ...READY, token: 'token-other' });
    expect(() => check()).toThrow(SESSION_LEFT_PROJECT_MESSAGE);
  });

  it('refuses every request when the editor does not hold the named project', () => {
    const capture = vi.fn((_projectId: string) => {
      throw new Error('another project');
    });
    const check = startProjectScopeCheck(capture, 'project-2');

    expect(capture).toHaveBeenCalledWith('project-2');
    expect(() => check()).toThrow(SESSION_LEFT_PROJECT_MESSAGE);
  });

  it('refuses every request when no capture is available', () => {
    const check = startProjectScopeCheck(undefined, 'project-1');

    expect(() => check()).toThrow(SESSION_LEFT_PROJECT_MESSAGE);
  });
});

describe('scopeStillHeld', () => {
  it('reports a held scope without throwing', () => {
    expect(scopeStillHeld(() => undefined)).toBe(true);
  });

  it('reports a left scope as not held', () => {
    expect(
      scopeStillHeld(() => {
        throw new Error(SESSION_LEFT_PROJECT_MESSAGE);
      }),
    ).toBe(false);
  });
});
