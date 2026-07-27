/** Playhead / scrub gutter display: `0:00.00` (minutes:seconds.centiseconds). */
export function formatTime(timeUs: number): string {
  const seconds = Math.max(0, timeUs) / 1_000_000;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}
