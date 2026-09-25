import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_DOWNLOAD_URL_RETENTION_MS } from '../../../packages/renderer-pixi/src/browser-export.js';
import { createExportUrlRetention } from './export-url-retention.js';

describe('export URL retention', () => {
  afterEach(() => vi.useRealTimers());

  it('retains a replaced URL for the browser download handoff window', () => {
    vi.useFakeTimers();
    const currentUrl: string | null = 'blob:current';
    const revoke = vi.fn();
    const retention = createExportUrlRetention(
      () => currentUrl,
      BROWSER_DOWNLOAD_URL_RETENTION_MS,
      revoke,
    );

    retention.schedule('blob:previous');
    vi.advanceTimersByTime(BROWSER_DOWNLOAD_URL_RETENTION_MS - 1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:previous');
  });

  it('keeps a URL that became current again and revokes it after a later replacement', () => {
    vi.useFakeTimers();
    let currentUrl: string | null = 'blob:new';
    const revoke = vi.fn();
    const retention = createExportUrlRetention(
      () => currentUrl,
      BROWSER_DOWNLOAD_URL_RETENTION_MS,
      revoke,
    );

    retention.schedule('blob:previous');
    currentUrl = 'blob:previous';
    vi.advanceTimersByTime(BROWSER_DOWNLOAD_URL_RETENTION_MS);
    expect(revoke).not.toHaveBeenCalled();

    currentUrl = 'blob:latest';
    retention.schedule('blob:previous');
    vi.advanceTimersByTime(BROWSER_DOWNLOAD_URL_RETENTION_MS);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:previous');
  });

  it('revokes pending and current URLs on unmount', () => {
    vi.useFakeTimers();
    let currentUrl: string | null = 'blob:current';
    const revoke = vi.fn();
    const retention = createExportUrlRetention(
      () => currentUrl,
      BROWSER_DOWNLOAD_URL_RETENTION_MS,
      revoke,
    );

    retention.schedule('blob:previous');
    retention.dispose();
    currentUrl = null;
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith('blob:previous');
    expect(revoke).toHaveBeenCalledWith('blob:current');
    vi.advanceTimersByTime(BROWSER_DOWNLOAD_URL_RETENTION_MS);
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
