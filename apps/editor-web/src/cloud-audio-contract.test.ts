import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('Cloud audio application contract', () => {
  it('reconciles cloud-audio ledger records that earlier builds left behind, and creates none', () => {
    // The remote denoise flow is gone in the local build (PLAN-v4 §4a). Its startup reconciliation
    // stays, so a record from an earlier build is never left in a running state.
    expect(appSource).toContain("operationLedger.recoverUncertain('cloud-audio')");
    expect(appSource).not.toContain('denoiseAudioOperation(');
    expect(appSource).not.toContain("type: 'cloud-audio'");
  });

  it('uses each project rootCompositionId instead of a hard-coded root key', () => {
    expect(appSource).not.toContain('compositions.root');
  });
});
