/** The slice of Electron's `app` that protocol registration uses, so the rule can be tested alone. */
export interface ProtocolRegistrationApp {
  readonly isPackaged: boolean;
  setAsDefaultProtocolClient(protocol: string): boolean;
}

/**
 * Claims the `joy:` links for the installed app. Only a packaged build does so: a development
 * run would otherwise point the scheme at the Electron binary in the source tree.
 */
export function registerJoyProtocol(app: ProtocolRegistrationApp): boolean {
  if (!app.isPackaged) return false;
  return app.setAsDefaultProtocolClient('joy');
}
