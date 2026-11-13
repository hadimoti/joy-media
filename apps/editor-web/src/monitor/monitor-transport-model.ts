/**
 * Transport maths for the Monitor (T-M10): J K L speed, the in and out points,
 * loop, play in to out, and the audio meter's clip mark. Pure functions; the
 * controls hook and the transport bar both read these.
 */

/** Where the J K L speed stands: -1 reverse, 0 stopped, 1 forward. */
export type JklDirection = -1 | 0 | 1;
export type JklLevel = 0 | 1 | 2 | 3;
export type JklKey = 'j' | 'k' | 'l';

export interface JklState {
  readonly direction: JklDirection;
  readonly level: JklLevel;
}

export const JKL_IDLE: JklState = { direction: 0, level: 0 };
/** Repeated J or L doubles the speed until this level (8 times). */
export const JKL_MAX_LEVEL: JklLevel = 3;

/** The speed multiplier for each level: 1, 2, 4, 8. */
export function jklSpeedTable(): readonly number[] {
  return [1, 2, 4, 8];
}

/** The speed multiplier of a J K L state (0 when stopped). */
export function jklSpeed(state: JklState): number {
  if (state.direction === 0) return 0;
  return 2 ** state.level;
}

/** One key of J K L. J or L pressed again doubles the speed; K stops. */
export function nextJklState(state: JklState, key: JklKey): JklState {
  if (key === 'k') return JKL_IDLE;
  const direction: JklDirection = key === 'l' ? 1 : -1;
  if (state.direction === direction) {
    return { direction, level: Math.min(JKL_MAX_LEVEL, state.level + 1) as JklLevel };
  }
  return { direction, level: 0 };
}

/**
 * True when the engine's own forward play does the moving (1x forward).
 * Every other J K L state is driven by stepping the playhead.
 */
export function jklUsesEnginePlayback(state: JklState): boolean {
  return state.direction === 1 && state.level === 0;
}

/** The in and out points of the timeline. Undefined means not set. */
export interface RangeMarks {
  readonly inUs?: number;
  readonly outUs?: number;
}

/** Sets the in point. An out point at or before it is dropped (no empty range). */
export function withInPoint(marks: RangeMarks, us: number): RangeMarks {
  const time = Math.max(0, us);
  if (marks.outUs !== undefined && marks.outUs <= time) return { inUs: time };
  return { ...marks, inUs: time };
}

/** Sets the out point. An in point at or after it is dropped (no empty range). */
export function withOutPoint(marks: RangeMarks, us: number): RangeMarks {
  const time = Math.max(0, us);
  if (marks.inUs !== undefined && marks.inUs >= time) return { outUs: time };
  return { ...marks, outUs: time };
}

export interface RangeEndInput {
  readonly playing: boolean;
  readonly playheadUs: number;
  readonly marks: RangeMarks;
  readonly loop: boolean;
  /** True while Play in to out is running. */
  readonly rangeRun: boolean;
  readonly durationUs: number;
}

/**
 * What the playhead must do at the out point while playing: `wrap` back to the
 * in point (loop), `stop` (play in to out finished), or `none`. Without a
 * loop or a range run, the out point is a marker and playback continues.
 */
export function rangeEndAction(input: RangeEndInput): 'none' | 'wrap' | 'stop' {
  if (!input.playing) return 'none';
  if (!input.loop && !input.rangeRun) return 'none';
  const out = input.marks.outUs ?? (input.rangeRun ? input.durationUs : undefined);
  if (out === undefined || out <= 0) return 'none';
  if (input.playheadUs < out) return 'none';
  if (input.loop) return 'wrap';
  return 'stop';
}

/**
 * Window event that asks the Monitor to toggle its full-screen preview. The
 * key F and the palette both send it, so the Monitor owns the fullscreen call.
 */
export const MONITOR_FULLSCREEN_EVENT = 'joy-media:monitor-fullscreen';

/** How long the clip mark stays lit after a clipped sample, in milliseconds. */
export const METER_CLIP_HOLD_MS = 2000;
/** The quietest level the meter shows, in dBFS. */
export const METER_FLOOR_DB = -60;

/** The meter bar fill (0 to 1) for a peak level in dBFS. */
export function meterFill(peakDb: number): number {
  if (!Number.isFinite(peakDb)) return 0;
  const fill = (peakDb - METER_FLOOR_DB) / -METER_FLOOR_DB;
  return Math.min(1, Math.max(0, fill));
}

/**
 * The time until which the clip mark stays lit. A clipped sample lights it for
 * `METER_CLIP_HOLD_MS` from `nowMs`; otherwise the earlier hold carries on.
 */
export function clipHoldUntil(previousUntilMs: number, clipping: boolean, nowMs: number): number {
  if (clipping) return nowMs + METER_CLIP_HOLD_MS;
  return previousUntilMs;
}

/** True while the clip mark is lit at `nowMs`. */
export function isClipHeld(untilMs: number, nowMs: number): boolean {
  return nowMs < untilMs;
}
