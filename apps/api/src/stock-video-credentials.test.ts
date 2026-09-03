import { describe, expect, it } from 'vitest';
import {
  createStockVideoCredentialSource,
  DEFAULT_STOCK_VIDEO_CREDENTIAL_DIRECTORY,
  PEXELS_SYSTEMD_CREDENTIAL_ID,
  PIXABAY_SYSTEMD_CREDENTIAL_ID,
  STOCK_VIDEO_SECRET_REFS,
} from './stock-video-credentials.js';

describe('stock-video encrypted credential contract', () => {
  it('reads each code-owned credential once and exposes opaque refs only', () => {
    const reads: string[] = [];
    const source = createStockVideoCredentialSource((path) => {
      reads.push(path);
      return path.includes(PEXELS_SYSTEMD_CREDENTIAL_ID)
        ? 'fixture-pexels-secret\n'
        : 'fixture-pixabay-secret\n';
    }, '/run/credentials/fixture.service');
    expect(reads).toEqual([
      `/run/credentials/fixture.service/${PEXELS_SYSTEMD_CREDENTIAL_ID}`,
      `/run/credentials/fixture.service/${PIXABAY_SYSTEMD_CREDENTIAL_ID}`,
    ]);
    expect(source(STOCK_VIDEO_SECRET_REFS.pexels)).toBe('fixture-pexels-secret');
    expect(source(STOCK_VIDEO_SECRET_REFS.pixabay)).toBe('fixture-pixabay-secret');
    expect(source('/caller-chosen/path')).toBeUndefined();
    expect(JSON.stringify(STOCK_VIDEO_SECRET_REFS)).not.toContain('fixture-');
  });

  it('fails closed when credentials are absent and keeps the production path fixed by default', () => {
    const source = createStockVideoCredentialSource(() => {
      throw new Error('missing credential');
    });
    expect(source(STOCK_VIDEO_SECRET_REFS.pexels)).toBeUndefined();
    expect(source(STOCK_VIDEO_SECRET_REFS.pixabay)).toBeUndefined();
    expect(DEFAULT_STOCK_VIDEO_CREDENTIAL_DIRECTORY).toBe('/run/credentials/joy-media@api.service');
  });
});
