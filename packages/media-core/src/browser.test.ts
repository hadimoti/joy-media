import { describe, expect, it } from 'vitest';
import * as browserMediaCore from './browser.js';

describe('browser media-core entry', () => {
  it('exposes only the browser-safe observation primitives', () => {
    expect(browserMediaCore.PACKAGE_NAME).toBe('@joy-media/media-core');
    expect(browserMediaCore.createObservationCacheKey).toBeTypeOf('function');
    expect(browserMediaCore.assertFrameIdentity).toBeTypeOf('function');
    expect(browserMediaCore.summarizeEvidenceCoverage).toBeTypeOf('function');

    // Node-only local bridge/proxy exports must stay behind the default entry.
    expect('LocalAssetBridge' in browserMediaCore).toBe(false);
    expect('derivativeCacheKey' in browserMediaCore).toBe(false);
    expect('normalizeProbe' in browserMediaCore).toBe(false);
  });
});
