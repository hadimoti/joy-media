import { win32 } from 'node:path';

/** The slice of Electron's `app` that protocol registration uses, so the rule can be tested alone. */
export interface ProtocolRegistrationApp {
  readonly isPackaged: boolean;
  setAsDefaultProtocolClient(protocol: string): boolean;
}

/** Where the installer puts the app: `%LOCALAPPDATA%\Programs\JOY Media\joy-media.exe` (installer/Setup.cs). */
export function installedExePath(localAppData: string): string {
  return win32.join(localAppData, 'Programs', 'JOY Media', 'joy-media.exe');
}

/**
 * Claims the `joy:` links for the installed copy only. A packaged build run from anywhere else, such as a dist
 * folder or a portable copy, would take the scheme away from the installed app, so it leaves the scheme alone.
 * A development run never claims it.
 */
export function registerJoyProtocol(
  app: ProtocolRegistrationApp,
  running: { readonly execPath: string; readonly localAppData: string | undefined },
): boolean {
  if (!app.isPackaged) return false;
  if (running.localAppData === undefined || running.localAppData === '') return false;
  if (!sameWindowsPath(running.execPath, installedExePath(running.localAppData))) return false;
  return app.setAsDefaultProtocolClient('joy');
}

function sameWindowsPath(a: string, b: string): boolean {
  return win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
}
