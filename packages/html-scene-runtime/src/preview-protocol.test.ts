import { describe, expect, it } from 'vitest';
import { starterManifest } from './template.js';
import {
  createSandboxedIframeDescriptor,
  ScenePreviewSession,
  validateScenePreviewEvent,
  validateScenePreviewMessage,
} from './preview-protocol.js';
import type { ScenePreviewMessage } from './preview-protocol.js';

describe('sandboxed scene preview protocol', () => {
  it('generates an allow-scripts-only iframe document with a manifest CSP', () => {
    const descriptor = createSandboxedIframeDescriptor(starterManifest(), 'blob:joy-scene-bundle');
    expect(descriptor.sandbox).toBe('allow-scripts');
    expect(descriptor.srcDoc).toContain('Content-Security-Policy');
    expect(descriptor.srcDoc).toContain('blob:joy-scene-bundle');
    expect(descriptor.srcDoc).toContain("window.addEventListener('message', receive)");
    expect(descriptor.srcDoc).toContain('event.source !== window.parent');
    expect(descriptor.srcDoc).toContain('joy.scene.update.v1');
    expect(descriptor.csp).toContain('script-src');
    expect(descriptor.csp).toContain('blob:');
    expect(descriptor.csp).toContain("connect-src 'none'");
    expect(() =>
      createSandboxedIframeDescriptor(starterManifest(), 'https://untrusted.invalid/a.js'),
    ).toThrow('controlled blob:');
  });

  it('accepts only well-formed preview messages and events', () => {
    expect(
      validateScenePreviewMessage({
        type: 'joy.scene.update.v1',
        instanceId: 'scene-1',
        timeUs: 100,
        variables: { title: 'JOY', enabled: true },
      }),
    ).toMatchObject({ type: 'joy.scene.update.v1', timeUs: 100 });
    expect(
      validateScenePreviewMessage({ type: 'joy.scene.update.v1', instanceId: 'x' }),
    ).toBeUndefined();
    expect(validateScenePreviewMessage({ type: 'other', instanceId: 'x' })).toBeUndefined();
    expect(
      validateScenePreviewEvent({
        type: 'joy.scene.failure.v1',
        instanceId: 'scene-1',
        diagnostic: { code: 'SCENE_RUNTIME', message: 'bad scene', path: 'source' },
      }),
    ).toMatchObject({ type: 'joy.scene.failure.v1' });
    expect(validateScenePreviewEvent({ type: 'joy.scene.ready.v1' })).toBeUndefined();
  });

  it('accepts capture messages and surface events', () => {
    expect(
      validateScenePreviewMessage({
        type: 'joy.scene.capture.v1',
        instanceId: 'scene-1',
        requestId: 'r1',
        width: 64,
        height: 64,
      }),
    ).toMatchObject({ type: 'joy.scene.capture.v1', requestId: 'r1' });
    expect(
      validateScenePreviewEvent({
        type: 'joy.scene.surface.v1',
        instanceId: 'scene-1',
        requestId: 'r1',
        width: 2,
        height: 2,
        rgba: new ArrayBuffer(16),
      }),
    ).toMatchObject({ type: 'joy.scene.surface.v1', width: 2 });
  });

  it('suspends offscreen instances and suppresses time updates until resumed', () => {
    const sent: ScenePreviewMessage[] = [];
    const session = new ScenePreviewSession('scene-1', {
      postMessage: (message) => sent.push(message),
    });
    expect(session.update(0, { title: 'JOY' })).toBe(true);
    session.suspend();
    expect(session.suspended).toBe(true);
    expect(session.update(1, { title: 'hidden' })).toBe(false);
    session.resume();
    expect(session.update(2, { title: 'back' })).toBe(true);
    expect(() => session.update(-1, {})).toThrow('non-negative safe integer');
    expect(sent.map((message) => message.type)).toEqual([
      'joy.scene.update.v1',
      'joy.scene.suspend.v1',
      'joy.scene.resume.v1',
      'joy.scene.update.v1',
    ]);
    expect(() => new ScenePreviewSession('', { postMessage: () => undefined })).toThrow(
      'non-empty',
    );
    const captureSent: ScenePreviewMessage[] = [];
    const captureSession = new ScenePreviewSession('scene-1', {
      postMessage: (message) => captureSent.push(message),
    });
    expect(captureSession.capture('req-1', 32, 48)).toBe(true);
    expect(captureSent[0]).toMatchObject({
      type: 'joy.scene.capture.v1',
      requestId: 'req-1',
      width: 32,
      height: 48,
    });
  });
});
