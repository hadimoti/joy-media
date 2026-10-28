/**
 * The shipped app registers the joy:// protocol on every launch. On Windows that writes HKCU\Software\Classes\joy with the
 * path of the running executable. The instrumented build must not change the owner's registration, so it replaces the call
 * with a no-op (plan section 10d; the G1 safety rules). The shipped build is not changed by this module.
 */
export interface ProtocolRegistrationTarget {
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
}

/** Makes every later registration a no-op that reports that none was made. Called before the app is ready. */
export function disableProtocolRegistration(target: ProtocolRegistrationTarget): void {
  target.setAsDefaultProtocolClient = () => false;
}
