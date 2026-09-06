import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const historySource = readFileSync(new URL('./export-history.ts', import.meta.url), 'utf8');
const exportStart = appSource.indexOf('const handleExport = useCallback');
const exportEnd = appSource.indexOf('const cancelExport = useCallback');
if (exportStart < 0 || exportEnd <= exportStart)
  throw new Error(
    'App.tsx no longer contains the handleExport/cancelExport markers this test slices between.',
  );
const exportCallback = appSource.slice(exportStart, exportEnd);

describe('App export recovery contract', () => {
  it('hydrates canonical project audio before deriving clip rows on reload', () => {
    const migration = appSource.indexOf('const audioMigrationRef = useRef(false)');
    const hydrated = appSource.indexOf('setAudioHydrated(true)', migration);
    const derive = appSource.indexOf('const next = ensureClipAudio(audioState, timelineClipIds)');
    const hydrationGuard = appSource.lastIndexOf('if (!audioHydrated) return;', derive);

    expect(migration).toBeGreaterThanOrEqual(0);
    expect(hydrated).toBeGreaterThan(migration);
    expect(hydrationGuard).toBeGreaterThan(hydrated);
    expect(derive).toBeGreaterThan(hydrationGuard);
  });

  it('hydrates and persists project-scoped v2 history while reconciling the export ledger', () => {
    expect(historySource).toContain(
      "export const PROJECT_EXPORT_HISTORY_KEY = 'joy-media.export-history.v2'",
    );
    expect(appSource).toContain('recoverInterruptedProjectExports(storage, projectId)');
    expect(appSource).toContain("operationLedger.recoverInterrupted('export')");
    expect(appSource).toContain('const next = upsertProjectEntry(exportHistoryRef.current, entry)');
    expect(appSource).toContain('saveProjectExportHistory(storage, projectId, next)');

    const runningEntry = exportCallback.indexOf("status: 'running'");
    const runningEntryStart = exportCallback.lastIndexOf('recordExportEntry({', runningEntry);
    const runningEntrySource = exportCallback.slice(runningEntryStart, runningEntry + 500);
    expect(runningEntry).toBeGreaterThanOrEqual(0);
    expect(runningEntryStart).toBeGreaterThanOrEqual(0);
    expect(runningEntrySource).toContain('projectId,');
    expect(runningEntrySource).toContain('fingerprint: exportFingerprint');
    expect(runningEntrySource).toContain('presetId: activeExportPreset');
    expect(runningEntrySource).toContain('manifest: retryManifest');
  });

  it('threads one AbortSignal through encoding, Worker staging, and durable cache verification', () => {
    const encode = exportCallback.indexOf('downloadBrowserMp4({');
    const encodeSignal = exportCallback.indexOf('signal: abortController.signal', encode);
    const stage = exportCallback.indexOf(
      "setExportStatus('Staging export for Worker verification…')",
      encodeSignal,
    );
    const workerEnqueue = exportCallback.indexOf(
      'mediaControlPlaneClient.enqueueRenderExport(',
      stage,
    );
    const workerAbortCheck = exportCallback.indexOf(
      'abortController.signal.throwIfAborted()',
      workerEnqueue,
    );
    const verifiedPut = exportCallback.indexOf('cache.putVerified(entryId, exportResult.blob)');
    const cacheAbortCheck = exportCallback.indexOf(
      'abortController.signal.throwIfAborted()',
      verifiedPut,
    );

    for (const index of [
      encode,
      encodeSignal,
      stage,
      workerEnqueue,
      workerAbortCheck,
      verifiedPut,
    ]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(encodeSignal).toBeGreaterThan(encode);
    expect(stage).toBeGreaterThan(encodeSignal);
    expect(workerEnqueue).toBeGreaterThan(stage);
    expect(workerAbortCheck).toBeGreaterThan(workerEnqueue);
    expect(verifiedPut).toBeGreaterThan(workerAbortCheck);
    expect(cacheAbortCheck).toBeGreaterThan(verifiedPut);
  });

  it('publishes only a fully committed durable blob and removes incomplete cache output', () => {
    const verifiedPut = exportCallback.indexOf('cache.putVerified(entryId, exportResult.blob)');
    const preview = exportCallback.indexOf('pendingExportUrl = URL.createObjectURL(durableBlob)');
    const metadata = exportCallback.indexOf('session.synchronizeVisualProject({', preview);
    const completedHistory = exportCallback.indexOf('recordExportEntry({', metadata);
    const completed = exportCallback.indexOf("status: 'completed'", completedHistory);
    const ledgerFinish = exportCallback.indexOf(
      "operationLedger.finish(entryId, 'completed'",
      completed,
    );
    const publish = exportCallback.indexOf('lastExportRef.current = { entryId, url:', ledgerFinish);
    const revokePrevious = exportCallback.indexOf(
      'URL.revokeObjectURL(previousExport.url)',
      publish,
    );
    const prune = exportCallback.indexOf('cache.prune(undefined, [entryId])', revokePrevious);
    const download = exportCallback.indexOf(
      'triggerBrowserDownload(durableBlob, exportResult.filename)',
      prune,
    );

    expect(verifiedPut).toBeGreaterThanOrEqual(0);
    expect(preview).toBeGreaterThan(verifiedPut);
    expect(metadata).toBeGreaterThan(preview);
    expect(completedHistory).toBeGreaterThan(metadata);
    expect(completed).toBeGreaterThan(completedHistory);
    expect(ledgerFinish).toBeGreaterThan(completed);
    expect(publish).toBeGreaterThan(ledgerFinish);
    expect(revokePrevious).toBeGreaterThan(publish);
    expect(prune).toBeGreaterThan(revokePrevious);
    expect(download).toBeGreaterThan(ledgerFinish);
    expect(exportCallback.slice(verifiedPut, completed + 600)).toContain('sha256: exportSha256');
    expect(exportCallback).toContain('cache.removeVerified(entryId)');
    expect(exportCallback).not.toContain('triggerBrowserDownload(exportResult.blob');
  });

  it('revalidates the immutable source immediately before committing export metadata', () => {
    const digest = exportCallback.indexOf('const exportSha256 = await sha256Hex(');
    const finalRevisionCheck = exportCallback.indexOf(
      'session.projectRevisionId !== sourceProjectRevisionId',
      digest,
    );
    const metadataCommit = exportCallback.indexOf(
      'session.synchronizeVisualProject({',
      finalRevisionCheck,
    );

    expect(digest).toBeGreaterThanOrEqual(0);
    expect(finalRevisionCheck).toBeGreaterThan(digest);
    expect(metadataCommit).toBeGreaterThan(finalRevisionCheck);
    expect(exportCallback.slice(metadataCommit, metadataCommit + 180)).toContain(
      '...session.visualProject',
    );
  });

  it('keeps the prior re-download through revision, history-quota, and ledger failures', () => {
    const verifiedPut = exportCallback.indexOf('cache.putVerified(entryId, exportResult.blob)');
    const finalRevisionCheck = exportCallback.indexOf(
      'session.projectRevisionId !== sourceProjectRevisionId',
      verifiedPut,
    );
    const metadataCommit = exportCallback.indexOf(
      'session.synchronizeVisualProject({',
      finalRevisionCheck,
    );
    const completedHistory = exportCallback.indexOf('recordExportEntry({', metadataCommit);
    const completedLedger = exportCallback.indexOf(
      "operationLedger.finish(entryId, 'completed'",
      completedHistory,
    );
    const publish = exportCallback.indexOf(
      'lastExportRef.current = { entryId, url:',
      completedLedger,
    );
    const revokePrevious = exportCallback.indexOf(
      'URL.revokeObjectURL(previousExport.url)',
      publish,
    );
    const prune = exportCallback.indexOf('cache.prune(undefined, [entryId])', publish);
    const catchBlock = exportCallback.indexOf('} catch (error) {', completedLedger);
    const partialUrlCleanup = exportCallback.indexOf(
      'URL.revokeObjectURL(pendingExportUrl)',
      catchBlock,
    );
    const partialCacheCleanup = exportCallback.indexOf(
      'cache.removeVerified(entryId)',
      partialUrlCleanup,
    );

    expect(finalRevisionCheck).toBeGreaterThan(verifiedPut);
    expect(metadataCommit).toBeGreaterThan(finalRevisionCheck);
    expect(completedHistory).toBeGreaterThan(metadataCommit);
    expect(completedLedger).toBeGreaterThan(completedHistory);
    expect(publish).toBeGreaterThan(completedLedger);
    expect(revokePrevious).toBeGreaterThan(publish);
    expect(prune).toBeGreaterThan(publish);
    expect(exportCallback.slice(verifiedPut, completedLedger)).not.toContain(
      'URL.revokeObjectURL(previousExport.url)',
    );
    expect(exportCallback.slice(verifiedPut, completedLedger)).not.toContain(
      'cache.prune(undefined, [entryId])',
    );
    expect(partialUrlCleanup).toBeGreaterThan(catchBlock);
    expect(partialCacheCleanup).toBeGreaterThan(partialUrlCleanup);
    expect(exportCallback.slice(catchBlock, partialCacheCleanup)).not.toContain(
      'lastExportRef.current = null',
    );

    const historyPersistence = appSource.indexOf(
      'saveProjectExportHistory(storage, projectId, next)',
    );
    const historyStatePublication = appSource.indexOf('setExportHistory(next)', historyPersistence);
    expect(historyPersistence).toBeGreaterThanOrEqual(0);
    expect(historyStatePublication).toBeGreaterThan(historyPersistence);
  });

  it('retries the same logical export identity and refuses changed retry inputs', () => {
    expect(exportCallback).toContain('const activeExportPreset = retryPreset ?? exportPreset');
    expect(exportCallback).toContain('const entryId = retryEntry?.id ?? `export-${Date.now()}`');
    expect(exportCallback).toContain(
      'const startedAt = retryEntry?.startedAt ?? new Date().toISOString()',
    );
    expect(exportCallback).toContain(
      'const exportFilename = retryEntry?.filename ?? `joy-media-export-${Date.now()}.mp4`',
    );
    expect(exportCallback).toContain(
      'exportFingerprint = `${sourceProjectRevisionId}:${activeExportPreset}:${width}x${height}:${durationUs}:${frameRate}`',
    );
    expect(exportCallback).toContain('retryEntry.projectId !== projectId');
    expect(exportCallback).toContain('retryEntry.fingerprint !== exportFingerprint');
    expect(exportCallback).toContain(
      'JSON.stringify(retryEntry.manifest) !== JSON.stringify(retryManifest)',
    );
    expect(exportCallback).toContain(
      "throw new Error('The project changed since this export attempt. Start a new export.')",
    );

    const inputGuard = exportCallback.indexOf('let retryInputsAccepted = retryEntry === undefined');
    const inputAccepted = exportCallback.indexOf('retryInputsAccepted = true', inputGuard);
    const catchBlock = exportCallback.indexOf('} catch (error) {', inputAccepted);
    const guardedFailure = exportCallback.indexOf('retryInputsAccepted &&', catchBlock);
    // The guarded failure entry records a cancelled retry as interrupted-retryable,
    // an unavailable final-export verification receipt as verification-required, and
    // any other error as failed.
    const failedEntry = exportCallback.indexOf('status: cancelled', guardedFailure);
    const interruptedBranch = exportCallback.indexOf("'interrupted-retryable'", failedEntry);
    const verificationRequiredBranch = exportCallback.indexOf(
      "verificationGate?.receipt.status === 'unavailable'",
      failedEntry,
    );
    const failedBranch = exportCallback.indexOf("'failed'", verificationRequiredBranch);

    expect(inputGuard).toBeGreaterThanOrEqual(0);
    expect(inputAccepted).toBeGreaterThan(inputGuard);
    expect(catchBlock).toBeGreaterThan(inputAccepted);
    expect(guardedFailure).toBeGreaterThan(catchBlock);
    expect(failedEntry).toBeGreaterThan(guardedFailure);
    expect(interruptedBranch).toBeGreaterThan(failedEntry);
    expect(verificationRequiredBranch).toBeGreaterThan(interruptedBranch);
    expect(failedBranch).toBeGreaterThan(verificationRequiredBranch);
  });
});
