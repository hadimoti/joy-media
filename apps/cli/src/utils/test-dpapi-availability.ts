import { createDpapiProtector } from './dpapi-protector.js';

/** Checks the capability the CLI actually uses without storing or printing the probe value. */
export const DPAPI_UNAVAILABLE_REASON = (() => {
  if (process.platform !== 'win32') return undefined;
  try {
    createDpapiProtector().protect('JOY Media test capability probe');
    return undefined;
  } catch {
    return 'Windows CurrentUser DPAPI is unavailable because this test process has no loaded user profile';
  }
})();
