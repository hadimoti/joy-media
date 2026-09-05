import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalStagedExportMimeType } from './export-job-request.js';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const exportCallback = appSource.slice(
  appSource.indexOf('const handleExport = useCallback'),
  appSource.indexOf('const cancelExport = useCallback'),
);

describe('App MP4 export negotiation contract', () => {
  it('captures every simultaneous video and target-sized scenes with cancellation', () => {
    expect(exportCallback).toContain('activePreparedExportClipsAt(');
    expect(exportCallback).toContain('for (const clip of activeClips)');
    expect(exportCallback).toContain('withVideoFrameNodes(frame, nodes)');
    expect(exportCallback).toMatch(
      /captureFull\(exportVisualProject.visualObjects, timeUs,\s*\{\s*width,\s*height,\s*signal: abortController.signal/,
    );
    expect(exportCallback).toContain('exportSceneCache?.destroy()');
  });

  it('builds the audio mix from all timeline lanes while preparing only visual export clips for frames', () => {
    expect(exportCallback).toMatch(/selectExportAudioClips\(\s*allTimelineClips,/);
    expect(exportCallback).toContain('audioClipIds.has(media.clip.id)');
    expect(exportCallback).toContain('visualClipIds.has(clip.id) && assetKind');
    expect(exportCallback).toContain('visualClipIds.has(media.clip.id)');
    expect(exportCallback).toContain('channels: 2');
    expect(exportCallback).toContain('offlineAudio.channelData');
    expect(exportCallback).toContain('mutedAudioClipIds.has(clipId)');
  });

  it('preflights with the shared selector before export mutation or capture', () => {
    const selector = exportCallback.indexOf('selectBrowserMp4MimeType()');
    const sourcePreflight = exportCallback.indexOf('preflightExportClipSources(');
    expect(selector).toBeGreaterThanOrEqual(0);
    expect(sourcePreflight).toBeGreaterThanOrEqual(0);
    expect(selector).toBeLessThan(exportCallback.indexOf('new AbortController()'));
    expect(selector).toBeLessThan(exportCallback.indexOf('setExporting(true)'));
    expect(sourcePreflight).toBeLessThan(
      exportCallback.indexOf('const audioContext = new AudioContext()'),
    );
    expect(sourcePreflight).toBeLessThan(exportCallback.indexOf('recordExportEntry({'));
    expect(exportCallback).not.toContain('MediaRecorder.isTypeSupported');
    expect(exportCallback).not.toContain('BROWSER_MP4_MIME_TYPE');
  });

  it('threads selected or actual MP4 MIME through recorder and persisted history metadata', () => {
    expect(exportCallback.match(/mimeType: selectedMimeType/g)?.length ?? 0).toBeGreaterThanOrEqual(
      3,
    );
    expect(exportCallback).toContain('mimeType: exportResult.mimeType');
    expect(exportCallback).not.toMatch(/webm/i);
  });

  it('queues Worker exports against the opaque control-plane project identity', () => {
    expect(exportCallback).toContain('createRenderExportJobPayload({');
    expect(exportCallback).toContain(
      'controlPlaneProjectId: controlPlaneProject.controlPlaneProjectId',
    );
    expect(canonicalStagedExportMimeType('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe(
      'video/mp4',
    );
  });

  it('persists the export preset only after preload, Worker verification, and verified durable caching', () => {
    const preload = exportCallback.indexOf("'fetching authored audio bytes'");
    const download = exportCallback.indexOf(
      'const browserExportResult: BrowserExportResult = await downloadBrowserMp4',
    );
    const persistPreset = exportCallback.indexOf('session.synchronizeVisualProject({');
    const progress = exportCallback.indexOf('setExportProgress(1)', persistPreset);
    const durableCache = exportCallback.indexOf('cache.putVerified(entryId, exportResult.blob)');
    const workerEnqueue = exportCallback.indexOf('mediaControlPlaneClient.enqueueRenderExport(');
    const autoDownload = exportCallback.indexOf(
      'triggerBrowserDownload(durableBlob, exportResult.filename)',
    );

    expect(preload).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(preload);
    expect(persistPreset).toBeGreaterThan(download);
    expect(persistPreset).toBeGreaterThan(durableCache);
    expect(workerEnqueue).toBeGreaterThan(download);
    expect(workerEnqueue).toBeLessThan(durableCache);
    expect(autoDownload).toBeGreaterThan(persistPreset);
    expect(progress).toBeGreaterThan(persistPreset);
    expect(exportCallback.slice(0, persistPreset)).not.toContain(
      'session.synchronizeVisualProject({',
    );
    expect(exportCallback.slice(download, persistPreset)).toContain(
      'mediaControlPlaneClient.derivativeBytes',
    );
    expect(exportCallback.slice(persistPreset, progress)).toContain(
      'exportPreset: activeExportPreset',
    );
  });

  it('records callback-time media drift before decode and canvas work', () => {
    const sourceTime = appSource.indexOf('sourceTimeUs = clock.timeUs');
    const record = appSource.indexOf('playbackDiagnostics.current.recordFrame(', sourceTime);
    const suppliedTime = appSource.indexOf('sourceTimeUs,', record);

    expect(sourceTime).toBeGreaterThanOrEqual(0);
    expect(record).toBeGreaterThan(sourceTime);
    expect(suppliedTime).toBeGreaterThan(record);
    expect(appSource.slice(record, record + 240)).not.toContain('clock.timeUs,');
  });

  it('keeps App ownership for authored audio, renderer, timers, and partial output cleanup', () => {
    expect(exportCallback).toContain('activeMixedAudioSource?.stop()');
    expect(exportCallback).toContain('activeAudioContext.close()');
    expect(exportCallback).toContain('activeRenderer?.destroy()');
    expect(exportCallback).toContain('window.clearTimeout(timer)');
    expect(exportCallback).toContain('cache.removeVerified(entryId)');
    expect(exportCallback).toContain('activeExportAudioTrack?.stop()');
  });
});
