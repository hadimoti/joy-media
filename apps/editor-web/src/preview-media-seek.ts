/**
 * Seek preview media and resolve only when the browser has a frame for the
 * requested time. Assigning currentTime updates synchronously while decoding
 * continues asynchronously, so an equal timestamp is not ready while the
 * element still reports `seeking`.
 */
export function seekPreviewMedia(video: HTMLVideoElement, timeUs: number): Promise<void> {
  const seconds = timeUs / 1_000_000;
  const alreadyAtTarget = Math.abs(video.currentTime - seconds) < 0.001;
  if (alreadyAtTarget && !video.seeking) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Unable to seek preview media to ${seconds}s`));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    if (!alreadyAtTarget) video.currentTime = seconds;
  });
}
