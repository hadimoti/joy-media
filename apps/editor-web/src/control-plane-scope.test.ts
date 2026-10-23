import { describe, expect, it } from 'vitest';
import {
  captureControlPlaneScope,
  SESSION_LEFT_PROJECT_MESSAGE,
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

  it('refuses an operation that starts without a ready owner', () => {
    const session = liveScope({
      ownerKey: undefined,
      projectId: 'unbound-editor-1',
      generation: 1,
      token: 'token-1',
    });
    const check = captureControlPlaneScope(session.current);

    expect(() => check()).toThrow(SESSION_LEFT_PROJECT_MESSAGE);
  });

  it('refuses an operation that starts without a stored session token', () => {
    const session = liveScope({ ...READY, token: undefined });
    const check = captureControlPlaneScope(session.current);

    expect(() => check()).toThrow(SESSION_LEFT_PROJECT_MESSAGE);
  });
});
