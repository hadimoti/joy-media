import { describe, expect, it } from 'vitest';

import { CanonicalJsonError, canonicalJson, computeRunKey } from './run-key.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively so key order never changes the serialization', () => {
    const a = canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } });
    const b = canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('rejects non-deterministic values instead of silently dropping them', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(10n)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(() => 1)).toThrow(CanonicalJsonError);
  });
});

describe('computeRunKey', () => {
  const base = {
    workflowId: 'wf-reels',
    workflowVersion: '1.0.0',
    nodeId: 'transcribe',
    nodeType: 'analysis.transcribe',
    params: { language: 'fa' },
    normalizedInputs: { assetId: 'asset-1' },
    projectRevision: 'rev-42',
  };

  it('is deterministic for equal ingredients regardless of key order', () => {
    const again = computeRunKey({
      projectRevision: 'rev-42',
      normalizedInputs: { assetId: 'asset-1' },
      params: { language: 'fa' },
      nodeType: 'analysis.transcribe',
      nodeId: 'transcribe',
      workflowVersion: '1.0.0',
      workflowId: 'wf-reels',
    });
    expect(computeRunKey(base)).toBe(again);
    expect(computeRunKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any §23.5 ingredient changes', () => {
    const key = computeRunKey(base);
    expect(computeRunKey({ ...base, workflowVersion: '1.0.1' })).not.toBe(key);
    expect(computeRunKey({ ...base, normalizedInputs: { assetId: 'asset-2' } })).not.toBe(key);
    expect(computeRunKey({ ...base, projectRevision: 'rev-43' })).not.toBe(key);
    expect(computeRunKey({ ...base, params: { language: 'en' } })).not.toBe(key);
    expect(computeRunKey({ ...base, providerVersion: 'whisper-3' })).not.toBe(key);
    expect(computeRunKey({ ...base, settings: { lufs: -16 } })).not.toBe(key);
  });
});
