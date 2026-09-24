import { describe, expect, it, vi } from 'vitest';
import { clearMediaSource, releaseMediaObjectUrl } from './media-object-url.js';

describe('media object URL lifecycle', () => {
  it('clears a pending image source before revoking its URL', () => {
    const events: string[] = [];
    const image = {
      getAttribute: () => 'blob:preview',
      removeAttribute: (name: string) => events.push(`remove:${name}`),
    } as unknown as HTMLImageElement;

    releaseMediaObjectUrl(image, 'blob:preview', (url) => events.push(`revoke:${url}`));

    expect(events).toEqual(['remove:src', 'revoke:blob:preview']);
  });

  it('pauses and unloads a video before revoking its URL', () => {
    const events: string[] = [];
    const video = {
      getAttribute: () => 'blob:video',
      pause: vi.fn(() => events.push('pause')),
      removeAttribute: (name: string) => events.push(`remove:${name}`),
      load: vi.fn(() => events.push('load')),
    } as unknown as HTMLVideoElement;

    releaseMediaObjectUrl(video, 'blob:video', (url) => events.push(`revoke:${url}`));

    expect(events).toEqual(['pause', 'remove:src', 'remove:poster', 'load', 'revoke:blob:video']);
  });

  it('does nothing for an absent element and clears media sources on demand', () => {
    expect(() => clearMediaSource(null)).not.toThrow();
    const removeAttribute = vi.fn();
    clearMediaSource({ removeAttribute } as unknown as HTMLImageElement);
    expect(removeAttribute).toHaveBeenCalledWith('src');
  });

  it('does not clear a newer source during an old effect cleanup', () => {
    const removeAttribute = vi.fn();
    const revoke = vi.fn();
    const image = {
      getAttribute: () => 'blob:newer',
      removeAttribute,
    } as unknown as HTMLImageElement;

    releaseMediaObjectUrl(image, 'blob:older', revoke);

    expect(removeAttribute).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:older');
  });
});
