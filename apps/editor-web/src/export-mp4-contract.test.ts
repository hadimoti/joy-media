import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const exportCallback = appSource.slice(
  appSource.indexOf('const handleExport = useCallback'),
  appSource.indexOf('const cancelExport = useCallback'),
);

describe('App MP4 export negotiation contract', () => {
  it('preflights with the shared selector before export mutation or capture', () => {
    const selector = exportCallback.indexOf('selectBrowserMp4MimeType()');
    expect(selector).toBeGreaterThanOrEqual(0);
    expect(selector).toBeLessThan(exportCallback.indexOf('new AbortController()'));
    expect(selector).toBeLessThan(exportCallback.indexOf('setExporting(true)'));
    expect(exportCallback).not.toContain('MediaRecorder.isTypeSupported');
    expect(exportCallback).not.toContain('BROWSER_MP4_MIME_TYPE');
  });

  it('threads selected or actual MP4 MIME through recorder and persisted history metadata', () => {
    expect(exportCallback.match(/mimeType: selectedMimeType/g)).toHaveLength(3);
    expect(exportCallback).toContain('mimeType: exportResult.mimeType');
    expect(exportCallback).not.toMatch(/webm/i);
  });

  it('persists the export preset only after preload consumers and a successful download', () => {
    const preload = exportCallback.indexOf("'fetching authored audio bytes'");
    const download = exportCallback.indexOf(
      'const exportResult: BrowserExportResult = await downloadBrowserMp4',
    );
    const persistPreset = exportCallback.indexOf('session.replaceVisualProject({');
    const progress = exportCallback.indexOf('setExportProgress(1)', persistPreset);

    expect(preload).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(preload);
    expect(persistPreset).toBeGreaterThan(download);
    expect(progress).toBeGreaterThan(persistPreset);
    expect(exportCallback.slice(0, persistPreset)).not.toContain('session.replaceVisualProject({');
    expect(exportCallback.slice(download, persistPreset)).toMatch(
      /signal: abortController\.signal,\s*}\);\s*$/,
    );
    expect(exportCallback.slice(persistPreset, progress)).toContain('exportPreset,');
  });

  it('keeps App ownership for authored audio, renderer, timers, and partial output cleanup', () => {
    expect(exportCallback).toContain('activeMixedAudioSource?.stop()');
    expect(exportCallback).toContain('activeAudioContext.close()');
    expect(exportCallback).toContain('activeRenderer?.destroy()');
    expect(exportCallback).toContain('window.clearTimeout(timer)');
    expect(exportCallback).toContain('cache.remove(entryId)');
  });
});
