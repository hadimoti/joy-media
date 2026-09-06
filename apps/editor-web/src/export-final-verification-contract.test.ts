import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const exportCallback = appSource.slice(
  appSource.indexOf('const handleExport = useCallback'),
  appSource.indexOf('const cancelExport = useCallback'),
);

describe('App final encoded export verification contract', () => {
  it('injects only the actual final-encoded browser decoder', () => {
    expect(appSource).toContain("import('./media-observation/final-encoded-export-decoder.js')");
    expect(appSource).toContain("import('./media-observation/render-verification.js')");
    expect(appSource).toContain('decoder: decoderModule.createBrowserFinalEncodedExportDecoder()');
    expect(appSource).toContain(
      'maxPresentationPts: verifierModule.MAX_FINAL_ENCODED_PRESENTATION_PTS',
    );
    expect(appSource).not.toContain("from './media-observation/final-encoded-export-decoder.js';");
    expect(appSource).not.toContain("decoder: { kind: 'canvas-readback'");
  });

  it('verifies the Worker-remuxed final Blob before cache, completion, or download', () => {
    const remuxedBlob = exportCallback.indexOf(
      'const remuxedBlob = await mediaControlPlaneClient.derivativeBytes(',
    );
    const verificationStatus = exportCallback.indexOf(
      "setExportStatus('Inspecting final encoded MP4…')",
      remuxedBlob,
    );
    const loadVerifier = exportCallback.indexOf(
      'await loadFinalEncodedExportVerifier()',
      verificationStatus,
    );
    const verify = exportCallback.indexOf(
      'await finalVerifierRuntime.verifier.verify({',
      verificationStatus,
    );
    const finalBlob = exportCallback.indexOf('encoded: remuxedBlob', verify);
    const expectation = exportCallback.indexOf(
      'createFinalEncodedExportExpectation(finalEncodedVerificationManifest)',
      verify,
    );
    const gate = exportCallback.indexOf(
      'new FinalExportVerificationGateError(finalVerificationReceipt)',
      expectation,
    );
    const cache = exportCallback.indexOf('cache.putVerified(entryId, exportResult.blob)', gate);
    const completed = exportCallback.indexOf("status: 'completed'", cache);
    const download = exportCallback.indexOf(
      'triggerBrowserDownload(durableBlob, exportResult.filename)',
      completed,
    );

    for (const index of [
      remuxedBlob,
      verificationStatus,
      loadVerifier,
      verify,
      finalBlob,
      expectation,
      gate,
      cache,
      completed,
      download,
    ])
      expect(index).toBeGreaterThanOrEqual(0);
    expect(verificationStatus).toBeGreaterThan(remuxedBlob);
    expect(loadVerifier).toBeGreaterThan(verificationStatus);
    expect(finalBlob).toBeGreaterThan(verify);
    expect(expectation).toBeGreaterThan(verify);
    expect(gate).toBeGreaterThan(expectation);
    expect(cache).toBeGreaterThan(gate);
    expect(completed).toBeGreaterThan(cache);
    expect(download).toBeGreaterThan(completed);
  });

  it('derives structural expectations from the immutable manifest and refuses to invent creative predicates', () => {
    const frozenManifest = exportCallback.indexOf(
      'const finalEncodedVerificationManifest = Object.freeze({',
    );
    const expectation = exportCallback.indexOf(
      'createFinalEncodedExportExpectation(finalEncodedVerificationManifest)',
    );
    const expectedSource = exportCallback.slice(frozenManifest, expectation + 100);

    expect(frozenManifest).toBeGreaterThanOrEqual(0);
    expect(expectedSource).toContain('...manifest');
    expect(expectedSource).toContain('frameCount: totalFrames');
    expect(expectation).toBeGreaterThan(frozenManifest);
    expect(exportCallback).not.toContain('visualPredicates:');
    expect(exportCallback).not.toContain('audioSyncPredicates:');
  });

  it('keeps unavailable verification distinct from completed output and makes it retryable', () => {
    expect(exportCallback).toContain("verificationGate?.receipt.status === 'unavailable'");
    expect(exportCallback).toContain("? 'verification-required'");
    expect(exportCallback).toContain('verification: verificationGate.receipt');
    expect(appSource).toContain("entry.status === 'verification-required'");
    expect(appSource).toContain('Verification required — retry');
    expect(appSource).toContain('Completed — final MP4 verified');
  });

  it('converts an unexpected final-verifier exception into a sanitized failed receipt', () => {
    expect(exportCallback).toContain("{ status: 'failed', code: 'decoder-failed' }");
    expect(exportCallback).toContain('if (abortController.signal.aborted) throw error;');
  });

  it('quarantines cached bytes for every final-verification-required history row', () => {
    expect(appSource).toContain("entry.status === 'verification-required'");
    expect(appSource).toContain('const nonDownloadableIds = exportHistory');
    expect(appSource).toContain('nonDownloadableIds.map((id) => cache.removeVerified(id))');
  });

  it('does not attach an unavailable receipt when the user cancelled the same attempt', () => {
    expect(exportCallback).toContain('verificationGate === undefined || cancelled');
    expect(exportCallback).toContain("? 'interrupted-retryable'");
  });
});
