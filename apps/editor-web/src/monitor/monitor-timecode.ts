/**
 * Monitor timecode (T-M10): frame-accurate maths for the playhead. Pure
 * functions. A frame index is the source of truth; microseconds are derived
 * from it, so stepping never accumulates rounding error.
 */

export interface MonitorRate {
  readonly num: number;
  readonly den: number;
}

/** Frame rate used when a composition declares none (the editor default). */
export const MONITOR_DEFAULT_FPS = 30;

/** Frames per second from a rational rate; the default for a missing or broken rate. */
export function monitorFps(rate: MonitorRate | undefined): number {
  if (rate === undefined || !(rate.num > 0) || !(rate.den > 0)) return MONITOR_DEFAULT_FPS;
  return rate.num / rate.den;
}

/** The whole-frame count a timecode counts in (29.97 counts in 30). */
export function nominalFrames(fps: number): number {
  return Math.max(1, Math.round(fps));
}

/** The frame that contains `us`, counted from zero. */
export function usToFrameIndex(us: number, fps: number): number {
  return Math.round((Math.max(0, us) * fps) / 1_000_000);
}

/** The time of frame `index`, rounded to the nearest microsecond. */
export function frameIndexToUs(index: number, fps: number): number {
  return Math.round((Math.max(0, index) * 1_000_000) / fps);
}

/** `hh:mm:ss:ff` for the frame that contains `us`. */
export function formatMonitorTimecode(us: number, fps: number): string {
  const nominal = nominalFrames(fps);
  const frames = usToFrameIndex(us, fps);
  const frame = frames % nominal;
  const totalSeconds = Math.floor(frames / nominal);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds, frame].map((part) => part.toString().padStart(2, '0')).join(':');
}

/**
 * Reads a typed position: `hh:mm:ss:ff`, `mm:ss:ff`, `ss:ff`, or a plain
 * frame number. Returns undefined when the text is not a valid position
 * (non-digits, seconds or minutes of 60 or more after the first field, or a
 * frame number at or above the frame count of one second).
 */
export function parseMonitorTimecode(text: string, fps: number): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+(:\d+){0,3}$/.test(trimmed)) return undefined;
  const nominal = nominalFrames(fps);
  const parts = trimmed.split(':').map((part) => Number(part));
  if (parts.length === 1) return frameIndexToUs(parts[0] ?? 0, fps);
  const [hours, minutes, seconds, frame] =
    parts.length === 4
      ? [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0]
      : parts.length === 3
        ? [0, parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
        : [0, 0, parts[0] ?? 0, parts[1] ?? 0];
  if (parts.length === 4 && minutes >= 60) return undefined;
  if (seconds >= 60 || frame >= nominal) return undefined;
  const frames = ((hours * 60 + minutes) * 60 + seconds) * nominal + frame;
  return frameIndexToUs(frames, fps);
}

/**
 * The playhead after one frame step in `direction`, clamped to the timeline
 * (zero to its last frame). Stepping 30 times at 30 frames per second moves
 * exactly one second.
 */
export function stepFrameUs(
  playheadUs: number,
  direction: 1 | -1,
  fps: number,
  durationUs: number,
): number {
  const last = usToFrameIndex(durationUs, fps);
  const next = Math.min(last, Math.max(0, usToFrameIndex(playheadUs, fps) + direction));
  return frameIndexToUs(next, fps);
}
