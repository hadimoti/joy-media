import { useMemo, useRef, useState } from 'react';
import type { MotionSceneDocument, MotionLayerId } from '@joy-media/motion-core';
import {
  clampPixelsPerSecond,
  fitPixelsPerSecond,
  MIN_PIXELS_PER_SECOND,
  MAX_PIXELS_PER_SECOND,
  type TimelineViewport,
} from '@joy-media/timeline-engine';
import { TimelineCanvas } from '../TimelineCanvas.js';
import {
  FitWidthIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '../icons.js';
import {
  motionSceneDurationUs,
  motionSceneToTimelineTracks,
} from './motionSceneToTimelineTracks.js';

export interface MotionStudioTimelineProps {
  readonly document: MotionSceneDocument;
  readonly playheadMs: number;
  readonly playing: boolean;
  readonly selectedLayerIds: readonly MotionLayerId[];
  readonly onSeek: (timeMs: number) => void;
  readonly onTogglePlayback: () => void;
  readonly onSelectLayer: (layerId: MotionLayerId | null) => void;
  readonly onToggleVisibility: (layerId: MotionLayerId) => void;
  readonly onToggleLocked: (layerId: MotionLayerId) => void;
}

/**
 * Same Dual Lens Time View chrome + TimelineCanvas geometry as the front app.
 */
export function MotionStudioTimeline({
  document,
  playheadMs,
  playing,
  selectedLayerIds,
  onSeek,
  onTogglePlayback,
  onSelectLayer,
  onToggleVisibility,
  onToggleLocked,
}: MotionStudioTimelineProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [viewport, setViewport] = useState<TimelineViewport>({
    originUs: 0,
    pixelsPerSecond: 40,
  });

  const durationUs = motionSceneDurationUs(document);
  const playheadUs = Math.max(0, Math.min(durationUs, playheadMs * 1000));

  const tracks = useMemo(
    () =>
      motionSceneToTimelineTracks(document, {
        onToggleVisibility,
        onToggleLocked,
      }),
    [document, onToggleVisibility, onToggleLocked],
  );

  const selectedClipIds = useMemo(() => new Set(selectedLayerIds), [selectedLayerIds]);

  const markers = useMemo(
    () =>
      document.markers.map((m) => ({
        id: m.id,
        timeUs: m.timeMs * 1000,
        label: m.label,
      })),
    [document.markers],
  );

  const applyZoom = (nextPps: number) => {
    setViewport((prev) => ({ ...prev, pixelsPerSecond: clampPixelsPerSecond(nextPps) }));
  };

  const fitToWidth = () => {
    const scroll = rootRef.current?.querySelector('.timeline-tracks');
    const lane = rootRef.current?.querySelector('.timeline-lane');
    const scrollClientW = scroll instanceof HTMLElement ? scroll.clientWidth : 0;
    const laneW = lane instanceof HTMLElement ? lane.clientWidth : 0;
    const width = Math.max(0, scrollClientW - 152) || laneW;
    if (width <= 0) return;
    setViewport((prev) => ({
      ...prev,
      pixelsPerSecond: fitPixelsPerSecond(durationUs, width),
    }));
  };

  return (
    <section className="dual-time ms-dual-time" aria-label="Timeline" ref={rootRef}>
      <div className="dual-lens-section-heading">
        <div className="dual-time-transport" role="toolbar" aria-label="Timeline transport">
          <div className="timeline-toolbar-group">
            <button
              type="button"
              className="icon-button"
              onClick={onTogglePlayback}
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => onSeek(Math.max(0, playheadMs - 1000))}
              aria-label="Back one second"
              title="Back 1s"
            >
              <SkipBackIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => onSeek(Math.min(document.durationMs, playheadMs + 1000))}
              aria-label="Forward one second"
              title="Forward 1s"
            >
              <SkipForwardIcon />
            </button>
          </div>
        </div>
        <div className="dual-time-heading-end">
          <div
            className="timeline-toolbar-group timeline-toolbar-zoom"
            role="group"
            aria-label="Timeline zoom"
          >
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => applyZoom(viewport.pixelsPerSecond / 1.25)}
            >
              <ZoomOutIcon />
            </button>
            <input
              aria-label="Timeline zoom"
              className="timeline-zoom-slider"
              type="range"
              min={MIN_PIXELS_PER_SECOND}
              max={MAX_PIXELS_PER_SECOND}
              step={1}
              value={Math.round(viewport.pixelsPerSecond)}
              onChange={(event) => applyZoom(event.currentTarget.valueAsNumber)}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => applyZoom(viewport.pixelsPerSecond * 1.25)}
            >
              <ZoomInIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Fit timeline to width"
              title="Fit to width"
              onClick={fitToWidth}
            >
              <FitWidthIcon />
            </button>
          </div>
        </div>
      </div>
      <TimelineCanvas
        className="dual-time-canvas"
        durationUs={durationUs}
        playheadUs={playheadUs}
        viewport={viewport}
        onViewportChange={setViewport}
        autoFit
        tracks={tracks}
        selectedClipIds={selectedClipIds}
        onSeek={(timeUs) => onSeek(timeUs / 1000)}
        onSelectClips={(clipIds) => onSelectLayer(clipIds[0] ?? null)}
        markers={markers}
        gutterLabel="Layers"
      />
    </section>
  );
}
