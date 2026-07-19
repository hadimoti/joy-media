/**
 * Permissions → Content-Security-Policy. The sandboxed preview iframe and the
 * headless export runtime both load a scene under this generated CSP (§20.4).
 * The policy is default-deny: only what the manifest declares is opened, and
 * network is confined to the declared origins (empty allowlist → no network).
 */

import type { ScenePermissionsV1 } from './manifest.js';

/**
 * Builds a strict CSP string from a scene's permissions. `connect-src` is the
 * only network surface a scene can reach, and only to its declared origins.
 */
export function generateSceneCsp(permissions: ScenePermissionsV1): string {
  const origins = [...new Set(permissions.network)].filter((origin) => origin.length > 0);
  const connectSrc = origins.length === 0 ? "'none'" : origins.join(' ');
  // Assets/fonts arrive as inlined data:/blob: handles from the resolver, never
  // by the scene reaching out on its own — so img/font/media stay off the network.
  const directives = [
    "default-src 'none'",
    // Preview packages are delivered by JOY as revocable blob: URLs. A data:
    // URL is accepted too for self-contained/offline packages. Neither opens a
    // network origin, and both still execute inside the allow-scripts-only
    // opaque-origin iframe. `unsafe-inline` is limited to JOY's generated
    // bootstrap bridge in that iframe.
    "script-src 'unsafe-inline' blob: data:",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data: blob:',
    'media-src data: blob:',
    `connect-src ${connectSrc}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
  ];
  return directives.join('; ');
}
