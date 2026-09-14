// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkForDesktopUpdate,
  getDesktopWorkerStatus,
  isDesktopHost,
  selectDesktopFile,
  type DesktopUpdateCheckRequest,
} from './desktop-client.js';

afterEach(() => {
  delete window.joyDesktop;
});

describe('isDesktopHost', () => {
  it('is false when window.joyDesktop is absent (every browser context)', () => {
    expect(isDesktopHost()).toBe(false);
  });

  it('is true once the preload bridge has installed window.joyDesktop', () => {
    window.joyDesktop = { channels: [], invoke: vi.fn() };
    expect(isDesktopHost()).toBe(true);
  });
});

describe('getDesktopWorkerStatus', () => {
  it('rejects outside the desktop host instead of touching window.joyDesktop', async () => {
    await expect(getDesktopWorkerStatus()).rejects.toThrow('unavailable outside the desktop host');
  });

  it('invokes desktop.worker-status with no payload and returns the bridge data verbatim', async () => {
    const status = {
      connection: 'online' as const,
      workerId: 'worker-1',
      capabilities: ['transcode'],
      lastSeenAt: '2026-09-15T00:00:00.000Z',
    };
    const invoke = vi.fn().mockResolvedValue(status);
    window.joyDesktop = { channels: ['desktop.worker-status'], invoke };

    await expect(getDesktopWorkerStatus()).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith('desktop.worker-status');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('selectDesktopFile', () => {
  it('rejects outside the desktop host', async () => {
    await expect(selectDesktopFile()).rejects.toThrow('unavailable outside the desktop host');
  });

  it('invokes desktop.select-file and returns the selected file reference', async () => {
    const ref = { kind: 'local-file' as const, id: 'ref-1', displayName: 'clip.mp4' };
    const invoke = vi.fn().mockResolvedValue(ref);
    window.joyDesktop = { channels: ['desktop.select-file'], invoke };

    await expect(selectDesktopFile()).resolves.toEqual(ref);
    expect(invoke).toHaveBeenCalledWith('desktop.select-file');
  });

  it('resolves to undefined when the user cancels the native dialog', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    window.joyDesktop = { channels: ['desktop.select-file'], invoke };

    await expect(selectDesktopFile()).resolves.toBeUndefined();
  });
});

describe('checkForDesktopUpdate', () => {
  const request: DesktopUpdateCheckRequest = {
    manifest: {
      payload: {
        channel: 'stable',
        version: '1.2.3',
        downloadUrl: 'https://joyst.ir/releases/1.2.3.exe',
        sha256: 'a'.repeat(64),
      },
      signature: 'sig',
    },
    subscriptionActive: true,
  };

  it('rejects outside the desktop host', async () => {
    await expect(checkForDesktopUpdate(request)).rejects.toThrow(
      'unavailable outside the desktop host',
    );
  });

  it('forwards the manifest and subscription flag to desktop.check-for-update', async () => {
    const decision = { status: 'current' as const, reason: 'not-newer' as const };
    const invoke = vi.fn().mockResolvedValue(decision);
    window.joyDesktop = { channels: ['desktop.check-for-update'], invoke };

    await expect(checkForDesktopUpdate(request)).resolves.toEqual(decision);
    expect(invoke).toHaveBeenCalledWith('desktop.check-for-update', request);
  });
});
