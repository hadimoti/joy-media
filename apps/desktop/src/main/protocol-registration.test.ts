import { describe, expect, it, vi } from 'vitest';
import { installedExePath, registerJoyProtocol } from './protocol-registration.js';

const localAppData = 'C:\\Users\\HadiMoti\\AppData\\Local';
const installedExe = 'C:\\Users\\HadiMoti\\AppData\\Local\\Programs\\JOY Media\\joy-media.exe';
const distExe =
  'C:\\Users\\HadiMoti\\joy-media-worktrees\\v110-local-only\\apps\\desktop\\dist\\joy-media-win32-x64\\joy-media.exe';

function fakeApp(isPackaged: boolean) {
  return { isPackaged, setAsDefaultProtocolClient: vi.fn((_protocol: string) => true) };
}

describe('registerJoyProtocol', () => {
  it('claims the joy protocol for the installed copy', () => {
    const app = fakeApp(true);

    expect(registerJoyProtocol(app, { execPath: installedExe, localAppData })).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('joy');
  });

  it('matches the installed path regardless of letter case', () => {
    const app = fakeApp(true);

    expect(registerJoyProtocol(app, { execPath: installedExe.toUpperCase(), localAppData })).toBe(
      true,
    );
  });

  it('leaves the joy protocol alone for a packaged build run from a dist folder', () => {
    const app = fakeApp(true);

    expect(registerJoyProtocol(app, { execPath: distExe, localAppData })).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('leaves the joy protocol alone for a portable copy outside the install folder', () => {
    const app = fakeApp(true);

    expect(
      registerJoyProtocol(app, {
        execPath: 'D:\\Portable\\JOY Media\\joy-media.exe',
        localAppData,
      }),
    ).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('leaves the joy protocol alone when LOCALAPPDATA is unknown', () => {
    const app = fakeApp(true);

    expect(registerJoyProtocol(app, { execPath: installedExe, localAppData: undefined })).toBe(
      false,
    );
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('leaves the joy protocol alone in a development run', () => {
    const app = fakeApp(false);

    expect(registerJoyProtocol(app, { execPath: installedExe, localAppData })).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
});

describe('installedExePath', () => {
  it('is the folder the installer uses', () => {
    expect(installedExePath(localAppData)).toBe(installedExe);
  });
});
