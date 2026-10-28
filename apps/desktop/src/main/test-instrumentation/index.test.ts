import { describe, expect, it, vi } from 'vitest';

// Electron is replaced, so the wiring can be checked without a runtime.
const electron = vi.hoisted(() => ({
  app: {
    setAsDefaultProtocolClient: (): boolean => true,
    setPath: (): void => undefined,
    on: (): void => undefined,
    commandLine: { appendSwitch: (): void => undefined },
    whenReady: (): Promise<void> => Promise.resolve(),
    getPath: (): string => '/test/user-data',
    getGPUInfo: async (): Promise<unknown> => ({}),
    getGPUFeatureStatus: (): unknown => ({}),
  },
  crashReporter: { start: (): void => undefined },
}));

vi.mock('electron', () => electron);

import { installTestInstrumentation } from './index.js';

describe('installTestInstrumentation', () => {
  it('stops the joy:// registration before the app can make it', () => {
    expect(electron.app.setAsDefaultProtocolClient('joy')).toBe(true);
    installTestInstrumentation([]);
    expect(electron.app.setAsDefaultProtocolClient('joy', 'C:/app/joy-media.exe', [])).toBe(false);
  });
});
