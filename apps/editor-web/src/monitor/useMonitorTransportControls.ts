import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { scopedKeyTable, type ScopedKeyEvent } from '../keyboard-shortcuts.js';
import { MONITOR_KEY_SCOPE } from './MonitorViewport.js';
import { stepFrameUs } from './monitor-timecode.js';
import {
  JKL_IDLE,
  jklSpeed,
  jklUsesEnginePlayback,
  nextJklState,
  rangeEndAction,
  withInPoint,
  withOutPoint,
  type JklKey,
  type JklState,
  type RangeMarks,
} from './monitor-transport-model.js';

/** What the controls need from the playback engine and the timeline. */
export interface MonitorTransportInput {
  readonly playheadUs: number;
  readonly playing: boolean;
  readonly durationUs: number;
  /** Frames per second of the root composition. */
  readonly fps: number;
  readonly seek: (timeUs: number) => void;
  readonly togglePlayback: () => void;
}

/** The transport controls the Monitor bar and the key table share. */
export interface MonitorTransportControls {
  readonly fps: number;
  readonly playheadUs: number;
  readonly durationUs: number;
  readonly playing: boolean;
  readonly marks: RangeMarks;
  readonly loop: boolean;
  readonly rangeRun: boolean;
  readonly jkl: JklState;
  readonly stepFrame: (direction: 1 | -1) => void;
  readonly pressJkl: (key: JklKey) => void;
  readonly toggleLoop: () => void;
  readonly setInPoint: () => void;
  readonly setOutPoint: () => void;
  readonly clearMarks: () => void;
  readonly playInToOut: () => void;
  readonly seekTo: (timeUs: number) => void;
}

/** How often the reverse or fast stepper seeks the media (it draws every frame). */
const STEP_SEEK_INTERVAL_MS = 80;

function isPlainArrow(event: ScopedKeyEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  return event.key === 'ArrowLeft' || event.key === 'ArrowRight';
}

/**
 * The Monitor transport (T-M10): one frame step, J K L speed, the in and out
 * points, loop, play in to out, and typed seeks. It owns no media itself: it
 * drives the playback engine through `seek` and `togglePlayback`. Reverse and
 * faster-than-1x motion step the playhead with seeks; 1x forward uses the
 * engine's own play.
 */
export function useMonitorTransportControls(
  input: MonitorTransportInput,
): MonitorTransportControls {
  const { playheadUs, playing, durationUs, fps } = input;
  const latest = useRef(input);
  latest.current = input;
  const [jkl, setJkl] = useState<JklState>(JKL_IDLE);
  const jklRef = useRef<JklState>(JKL_IDLE);
  const [loop, setLoop] = useState(false);
  const [marks, setMarks] = useState<RangeMarks>({});
  const [rangeRun, setRangeRun] = useState(false);

  const applyJkl = useCallback((next: JklState) => {
    jklRef.current = next;
    setJkl(next);
  }, []);

  const stepFrame = useCallback(
    (direction: 1 | -1) => {
      const current = latest.current;
      applyJkl(JKL_IDLE);
      if (current.playing) current.togglePlayback();
      current.seek(stepFrameUs(current.playheadUs, direction, current.fps, current.durationUs));
    },
    [applyJkl],
  );

  const pressJkl = useCallback(
    (key: JklKey) => {
      const current = latest.current;
      const next = nextJklState(jklRef.current, key);
      applyJkl(next);
      if (key === 'k') {
        if (current.playing) current.togglePlayback();
        return;
      }
      if (jklUsesEnginePlayback(next) && !current.playing) current.togglePlayback();
    },
    [applyJkl],
  );

  // Reverse and faster-than-1x motion: move the playhead by speed x elapsed
  // time and seek to it, at most every STEP_SEEK_INTERVAL_MS. Stops at either end.
  useEffect(() => {
    if (jkl.direction === 0 || jklUsesEnginePlayback(jkl)) return undefined;
    const direction = jkl.direction;
    const speed = jklSpeed(jkl);
    const start = latest.current;
    if (start.playing) start.togglePlayback();
    let position = start.playheadUs;
    let previous: number | undefined;
    let lastSeek = Number.NEGATIVE_INFINITY;
    let frame = 0;
    const tick = (now: number) => {
      const elapsedMs = previous === undefined ? 0 : now - previous;
      previous = now;
      const limit = Math.max(0, latest.current.durationUs);
      position = Math.min(limit, Math.max(0, position + direction * speed * elapsedMs * 1000));
      const atEnd = direction < 0 ? position <= 0 : position >= limit;
      if (atEnd || now - lastSeek >= STEP_SEEK_INTERVAL_MS) {
        latest.current.seek(position);
        lastSeek = now;
      }
      if (atEnd) {
        applyJkl(JKL_IDLE);
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [jkl, applyJkl]);

  // The out point while playing: loop back to the in point, or stop at the end
  // of a play in to out run. A plain out point is only a marker.
  useEffect(() => {
    const current = latest.current;
    const action = rangeEndAction({
      playing,
      playheadUs,
      marks,
      loop,
      rangeRun,
      durationUs,
    });
    if (action === 'wrap') current.seek(marks.inUs ?? 0);
    else if (action === 'stop') {
      setRangeRun(false);
      current.togglePlayback();
    }
  }, [playing, playheadUs, durationUs, marks, loop, rangeRun]);

  // Frame stepping and the other arrow keys are scoped to the Monitor (the
  // pointer is over it or focus is in it). Elsewhere the global 1 s step applies.
  useEffect(
    () =>
      scopedKeyTable.register({
        scope: MONITOR_KEY_SCOPE,
        match: isPlainArrow,
        run: (event) => stepFrame(event.key === 'ArrowLeft' ? -1 : 1),
      }),
    [stepFrame],
  );

  const setInPoint = useCallback(() => {
    setMarks((previous) => withInPoint(previous, latest.current.playheadUs));
  }, []);

  const setOutPoint = useCallback(() => {
    setMarks((previous) => withOutPoint(previous, latest.current.playheadUs));
  }, []);

  const clearMarks = useCallback(() => {
    setMarks({});
    setRangeRun(false);
  }, []);

  const toggleLoop = useCallback(() => setLoop((on) => !on), []);

  const playInToOut = useCallback(() => {
    const current = latest.current;
    const from = marks.inUs ?? 0;
    const to = marks.outUs ?? current.durationUs;
    if (to <= from) return;
    applyJkl(JKL_IDLE);
    setRangeRun(true);
    current.seek(from);
    if (!current.playing) current.togglePlayback();
  }, [marks, applyJkl]);

  const seekTo = useCallback((timeUs: number) => {
    const current = latest.current;
    const limit = Math.max(0, current.durationUs);
    current.seek(Math.min(limit, Math.max(0, timeUs)));
  }, []);

  return useMemo(
    () => ({
      fps,
      playheadUs,
      durationUs,
      playing,
      marks,
      loop,
      rangeRun,
      jkl,
      stepFrame,
      pressJkl,
      toggleLoop,
      setInPoint,
      setOutPoint,
      clearMarks,
      playInToOut,
      seekTo,
    }),
    [
      fps,
      playheadUs,
      durationUs,
      playing,
      marks,
      loop,
      rangeRun,
      jkl,
      stepFrame,
      pressJkl,
      toggleLoop,
      setInPoint,
      setOutPoint,
      clearMarks,
      playInToOut,
      seekTo,
    ],
  );
}
