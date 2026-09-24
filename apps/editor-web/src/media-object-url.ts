/** Clear a media consumer before releasing the object URL it may still load. */
export function clearMediaSource(element: HTMLMediaElement | HTMLImageElement | null): void {
  if (element === null) return;
  if ('pause' in element && 'load' in element) {
    const media = element as HTMLMediaElement;
    media.pause();
    media.removeAttribute('src');
    media.load();
    return;
  }
  element.removeAttribute('src');
}

export function releaseMediaObjectUrl(
  element: HTMLMediaElement | HTMLImageElement | null,
  url: string,
  revoke: (url: string) => void = (value) => URL.revokeObjectURL(value),
): void {
  if (element?.getAttribute('src') === url) clearMediaSource(element);
  revoke(url);
}
