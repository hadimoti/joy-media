/**
 * Where to seek a detached video so that the frame on screen is the source frame that holds
 * `sourceUs`. The seek goes to the middle of that frame. A seek to a time a few microseconds short
 * of the next frame's edge can show the next frame instead: on the reversed-clip export, frames
 * whose index is a multiple of 3 came out one frame late (C11 fixture, 30 fps).
 */
export function frameCentreSeekUs(sourceUs: number, frameDurationUs: number): number {
  const index = Math.max(0, Math.floor(sourceUs / frameDurationUs + 1e-6));
  return (index + 0.5) * frameDurationUs;
}
