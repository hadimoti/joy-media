import { useContext, useEffect, useState } from 'react';
import { computeMeter } from '@joy-media/audio-core';
import { EditorPanelContext } from '../editor-panel-context.js';
import type { MonitorTransportControls } from './useMonitorTransportControls.js';
import { formatMonitorTimecode, parseMonitorTimecode } from './monitor-timecode.js';
import { clipHoldUntil, isClipHeld, jklSpeed, meterFill } from './monitor-transport-model.js';

/** How often the level meter reads the preview audio tap. */
const METER_INTERVAL_MS = 100;

function speedText(controls: MonitorTransportControls): string {
  if (controls.jkl.direction === 0) return '';
  const sign = controls.jkl.direction < 0 ? '-' : '';
  return `${sign}${jklSpeed(controls.jkl)}x`;
}

/** The typed timecode: `hh:mm:ss:ff`, `mm:ss:ff` or a frame number. Enter or leaving the field jumps there. */
function TimecodeField({ controls }: { readonly controls: MonitorTransportControls }) {
  const current = formatMonitorTimecode(controls.playheadUs, controls.fps);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [invalid, setInvalid] = useState(false);
  const shown = draft ?? current;
  const commit = () => {
    if (draft === undefined) return;
    const parsed = parseMonitorTimecode(draft, controls.fps);
    if (parsed === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(undefined);
    controls.seekTo(parsed);
  };
  return (
    <input
      className={`monitor-timecode${invalid ? ' is-invalid' : ''}`}
      type="text"
      inputMode="numeric"
      aria-label="Timecode"
      aria-invalid={invalid}
      title="Type hh:mm:ss:ff, mm:ss:ff or a frame number, then Enter to jump there"
      value={shown}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onBlur={() => {
        if (invalid) {
          setDraft(undefined);
          setInvalid(false);
          return;
        }
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(undefined);
          setInvalid(false);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** A small peak meter with a clip mark that stays lit for two seconds. */
function LevelMeter({ read }: { readonly read: () => AnalyserNode | null }) {
  const [fill, setFill] = useState(0);
  const [clipping, setClipping] = useState(false);
  useEffect(() => {
    let holdUntil = 0;
    const timer = window.setInterval(() => {
      const analyser = read();
      const now = performance.now();
      if (analyser === null) {
        setFill(0);
        setClipping(false);
        return;
      }
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      const reading = computeMeter(samples);
      holdUntil = clipHoldUntil(holdUntil, reading.clipping, now);
      setFill(meterFill(reading.peakDb));
      setClipping(isClipHeld(holdUntil, now));
    }, METER_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [read]);
  const percent = Math.round(fill * 100);
  return (
    <div
      className="monitor-meter"
      role="meter"
      aria-label="Audio level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      title="Audio level of the preview. The red mark lights when the signal clips."
    >
      <span className="monitor-meter-track" aria-hidden="true">
        <span className="monitor-meter-bar" style={{ width: `${percent}%` }} />
      </span>
      <span className={`monitor-meter-clip${clipping ? ' is-lit' : ''}`} aria-hidden="true">
        clip
      </span>
    </div>
  );
}

/**
 * The Monitor's frame, J K L, in and out, loop, timecode and level controls
 * (T-M10). Each control is driven by the shared transport controls; the key
 * table uses the same functions, so a button and its key never disagree.
 */
export function MonitorTimeControls() {
  const context = useContext(EditorPanelContext);
  const controls = context?.monitorTransport;
  const readMeter = context?.readPreviewMeterAnalyser;
  if (controls === undefined) return null;
  const speed = speedText(controls);
  const inText =
    controls.marks.inUs === undefined
      ? '--'
      : formatMonitorTimecode(controls.marks.inUs, controls.fps);
  const outText =
    controls.marks.outUs === undefined
      ? '--'
      : formatMonitorTimecode(controls.marks.outUs, controls.fps);
  return (
    <div className="monitor-time-controls">
      <TimecodeField controls={controls} />
      <div className="monitor-time-group" role="group" aria-label="Frame and speed">
        <button
          type="button"
          className="monitor-time-btn"
          aria-label="Step back one frame"
          title="Step back one frame (,)"
          onClick={() => controls.stepFrame(-1)}
        >
          {'<'}
        </button>
        <button
          type="button"
          className="monitor-time-btn"
          aria-label="Reverse, press again to go faster (J)"
          aria-pressed={controls.jkl.direction === -1}
          title="Reverse (J). Press again to double the speed, up to 8x."
          onClick={() => controls.pressJkl('j')}
        >
          J
        </button>
        <button
          type="button"
          className="monitor-time-btn"
          aria-label="Stop (K)"
          title="Stop (K)"
          onClick={() => controls.pressJkl('k')}
        >
          K
        </button>
        <button
          type="button"
          className="monitor-time-btn"
          aria-label="Play forward, press again to go faster (L)"
          aria-pressed={controls.jkl.direction === 1}
          title="Play forward (L). Press again to double the speed, up to 8x."
          onClick={() => controls.pressJkl('l')}
        >
          L
        </button>
        <button
          type="button"
          className="monitor-time-btn"
          aria-label="Step forward one frame"
          title="Step forward one frame (.)"
          onClick={() => controls.stepFrame(1)}
        >
          {'>'}
        </button>
        <span className="monitor-time-speed" aria-live="polite">
          {speed}
        </span>
      </div>
      <div className="monitor-time-group" role="group" aria-label="In and out points">
        <button
          type="button"
          className="monitor-time-btn"
          aria-label="Set in point (I)"
          title="Set in point at the playhead (I)"
          onClick={controls.setInPoint}
        >
          I
        </button>
        <button
          type="button"
          className="monitor-time-btn"
          aria-label="Set out point (O)"
          title="Set out point at the playhead (O)"
          onClick={controls.setOutPoint}
        >
          O
        </button>
        <span className="monitor-time-marks" title="In and out points">
          {inText} {outText}
        </span>
        <button
          type="button"
          className="monitor-time-btn"
          aria-label="Clear in and out points (Shift+X)"
          title="Clear in and out points (Shift+X)"
          onClick={controls.clearMarks}
        >
          clear
        </button>
        <button
          type="button"
          className="monitor-time-btn"
          aria-label="Play in to out (/)"
          title="Play in to out (/)"
          onClick={controls.playInToOut}
        >
          in-out
        </button>
        <button
          type="button"
          className="monitor-time-btn"
          aria-label="Loop on or off (\)"
          aria-pressed={controls.loop}
          title="Loop on or off (\)"
          onClick={controls.toggleLoop}
        >
          loop
        </button>
      </div>
      {readMeter !== undefined && <LevelMeter read={readMeter} />}
    </div>
  );
}
