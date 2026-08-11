import { describe, expect, it } from 'vitest';
import {
  downloadBrowserTextFile,
  type BrowserTextDownloadEnvironment,
} from './browser-text-download.js';

describe('downloadBrowserTextFile', () => {
  it('defers URL revocation until after the anchor click task', () => {
    const events: string[] = [];
    let deferred: (() => void) | undefined;
    const anchor = {
      href: '',
      download: '',
      click: () => events.push('click'),
    };
    const environment: BrowserTextDownloadEnvironment = {
      createObjectUrl: () => {
        events.push('create');
        return 'blob:caption';
      },
      revokeObjectUrl: (url) => events.push(`revoke:${url}`),
      createAnchor: () => anchor,
      defer: (callback) => {
        events.push('defer');
        deferred = callback;
      },
    };

    downloadBrowserTextFile('captions.srt', 'hello', environment);

    expect(anchor).toMatchObject({ href: 'blob:caption', download: 'captions.srt' });
    expect(events).toEqual(['create', 'click', 'defer']);

    deferred?.();
    expect(events).toEqual(['create', 'click', 'defer', 'revoke:blob:caption']);
  });
});
