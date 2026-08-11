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
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    createAnchor: () => window.document.createElement('a'),
    defer: (callback) => window.setTimeout(callback, 0),
  };
}

/**
 * Starts a browser text download and keeps the object URL alive until the
 * browser has had a task boundary in which to consume the anchor click.
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
