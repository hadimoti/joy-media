import { describe, expect, it } from 'vitest';
import { createFileBoundary } from './file-boundary.js';
import { parseProjectDeepLink } from './deep-link.js';
import { isAllowedEditorOrigin } from './origin-policy.js';
import { isAllowedIpcRequest } from './ipc.js';
import { canSubmitWorkerJob, normalizeStartupPreference } from './worker-status.js';
describe('desktop shell boundaries', () => {
  it('allows only explicit editor origins and IPC channels', () => {
    expect(isAllowedEditorOrigin('https://joyst.ir')).toBe(true);
    expect(isAllowedEditorOrigin('https://evil.example')).toBe(false);
    expect(
      isAllowedIpcRequest({ origin: 'http://localhost:5173', channel: 'desktop.worker-status' }),
    ).toBe(true);
    expect(() =>
      isAllowedIpcRequest({ origin: 'https://evil.example', channel: 'desktop.worker-status' }),
    ).toThrow();
    expect(isAllowedIpcRequest({ origin: 'https://joyst.ir', channel: 'desktop.execute' })).toBe(
      false,
    );
  });
  it('keeps paths behind revocable opaque references', () => {
    const files = createFileBoundary(() => 'local-1');
    const ref = files.registerSelection('C:\\Media\\clip.mp4');
    expect(ref).toEqual({ kind: 'local-file', id: 'local-1', displayName: 'clip.mp4' });
    expect(files.requestDerivative(ref, 'thumbnail')).toEqual({
      refId: 'local-1',
      kind: 'thumbnail',
    });
    files.revoke(ref);
    expect(() => files.requestDerivative(ref, 'proxy')).toThrow();
  });
  it('normalizes caller-provided local display names before exposing them', () => {
    const files = createFileBoundary(() => 'local-2');
    expect(files.registerSelection('C:\\Media\\clip.mp4', 'C:\\private\\secret.mp4')).toEqual({
      kind: 'local-file',
      id: 'local-2',
      displayName: 'secret.mp4',
    });
  });
  it('accepts only project UUID deep links', () => {
    expect(
      parseProjectDeepLink('joy://open/project/123e4567-e89b-12d3-a456-426614174000')?.projectId,
    ).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(parseProjectDeepLink('joy://open/project/not-a-uuid')).toBeUndefined();
    expect(
      parseProjectDeepLink(
        'joy://open/project/123e4567-e89b-12d3-a456-426614174000?path=C:\\secret',
      ),
    ).toBeUndefined();
  });
  it('fails closed for startup and Worker readiness', () => {
    expect(normalizeStartupPreference('unexpected')).toBe('leave-worker-alone');
    expect(canSubmitWorkerJob({ connection: 'online', workerId: 'w1', capabilities: [] })).toBe(
      true,
    );
    expect(canSubmitWorkerJob({ connection: 'degraded', workerId: 'w1', capabilities: [] })).toBe(
      false,
    );
  });
});
