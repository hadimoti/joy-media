import { BROWSER_DOWNLOAD_URL_RETENTION_MS } from '../../../packages/renderer-pixi/src/browser-export.js';
import { revokeDetachedObjectUrl } from './media-object-url.js';

export interface BrowserTextDownloadEnvironment {
  readonly createObjectUrl: (blob: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
  readonly createAnchor: () => {
    href: string;
    download: string;
    click: () => void;
  };
  readonly defer: (callback: () => void) => void;
}

function defaultEnvironment(): BrowserTextDownloadEnvironment {
  return {
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: revokeDetachedObjectUrl,
    createAnchor: () => window.document.createElement('a'),
    defer: (callback) => window.setTimeout(callback, BROWSER_DOWNLOAD_URL_RETENTION_MS),
  };
}

/**
 * Starts a browser text download and retains its object URL for the shared
 * browser download handoff window.
 */
export function downloadBrowserTextFile(
  fileName: string,
  text: string,
  environment = defaultEnvironment(),
): void {
  const url = environment.createObjectUrl(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = environment.createAnchor();
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  environment.defer(() => environment.revokeObjectUrl(url));
}
