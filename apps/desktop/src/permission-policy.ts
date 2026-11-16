import { isAllowedEditorOrigin, originOfPageUrl } from './origin-policy.js';

/**
 * The desktop shell denies every permission request it has no product reason to grant. The one it does
 * have a reason for is `fullscreen`: the editor's own page asks for it when the owner presses F or chooses
 * View > Toggle Full Screen. Any other page, and any other permission, stays denied.
 */
export function isPermissionGranted(permission: string, requestingUrl: string): boolean {
  if (permission !== 'fullscreen') return false;
  const origin = originOfPageUrl(requestingUrl);
  return origin !== undefined && isAllowedEditorOrigin(origin);
}
