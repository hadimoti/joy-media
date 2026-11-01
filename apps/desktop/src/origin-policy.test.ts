import { describe, expect, it } from 'vitest';
import { isAllowedEditorOrigin, originOfPageUrl } from './origin-policy.js';

describe('originOfPageUrl', () => {
  it('reads the scheme and host of the packaged renderer page, query and path aside', () => {
    const origin = originOfPageUrl('joy-media-app://renderer/index.html?project=1');

    expect(origin).toBe('joy-media-app://renderer');
    expect(isAllowedEditorOrigin(origin ?? '')).toBe(true);
  });

  it('keeps the port of the dev server', () => {
    expect(originOfPageUrl('http://localhost:5173/projects/abc')).toBe('http://localhost:5173');
    expect(isAllowedEditorOrigin('http://localhost:5173')).toBe(true);
  });

  it('gives an origin no allowed editor origin matches for a page on another host', () => {
    const origin = originOfPageUrl('https://joyst.ir/app');

    expect(origin).toBe('https://joyst.ir');
    expect(isAllowedEditorOrigin(origin ?? '')).toBe(false);
  });

  it('gives no origin for a URL that does not parse', () => {
    expect(originOfPageUrl('')).toBeUndefined();
    expect(originOfPageUrl('not a url')).toBeUndefined();
  });
});
