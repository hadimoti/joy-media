import { describe, expect, it } from 'vitest';
import { isPermissionGranted } from './permission-policy.js';

describe('desktop permission policy', () => {
  it('grants full screen to the editor page only', () => {
    expect(isPermissionGranted('fullscreen', 'joy-media-app://renderer/index.html')).toBe(true);
    expect(isPermissionGranted('fullscreen', 'http://localhost:5173/')).toBe(true);
    expect(isPermissionGranted('fullscreen', 'https://example.com/')).toBe(false);
    expect(isPermissionGranted('fullscreen', 'not a url')).toBe(false);
  });

  it('denies every other permission, even for the editor page', () => {
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read']) {
      expect(isPermissionGranted(permission, 'joy-media-app://renderer/index.html')).toBe(false);
    }
  });
});
