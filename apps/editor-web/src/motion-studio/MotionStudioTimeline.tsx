import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MotionSceneDocument,
  MotionLayerId,
  MotionAnimation,
  MotionKeyframe,
} from '@joy-media/motion-core';
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
import { UI_ICONS } from '../ui-icons.js';
import type { SceneCommand } from './state/sceneCommands.js';
import { timelineContentWidthPx } from '../timeline-layout.js';

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
  readonly dispatch: (label: string, ...commands: SceneCommand[]) => void;
}

/** Visible lane width = scrollport minus the shared timeline track gutter. */
function measureLaneWidthPx(root: HTMLElement | null): number {
  if (root === null) return 0;
  const scroll = root.querySelector('.timeline-tracks');
  if (!(scroll instanceof HTMLElement)) return 0;
  // Never use .timeline-lane clientWidth — that grows with zoomed content.
  return timelineContentWidthPx(scroll.clientWidth);
}

/**
 * Same Dual Lens Time View chrome + TimelineCanvas geometry as the front app.
 * Extends the base timeline with per-layer keyframe rows and layer trim handles.
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
  dispatch,
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

  const applyFitToWidth = () => {
    const root = rootRef.current;
    const width = measureLaneWidthPx(root);
    if (width <= 0) return false;
    setViewport({
      originUs: 0,
      pixelsPerSecond: fitPixelsPerSecond(durationUs, width),
    });
    const scroll = root?.querySelector('.timeline-tracks');
    if (scroll instanceof HTMLElement) scroll.scrollLeft = 0;
    return true;
  };

  // Initial fit once layout is ready (Dual Lens leaves autoFit off; we still fit on open).
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const tryFit = () => {
      if (cancelled) return;
      attempts += 1;
      if (applyFitToWidth() || attempts > 60) return;
      requestAnimationFrame(tryFit);
    };
    requestAnimationFrame(tryFit);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot / duration change
  }, [durationUs]);

  const applyZoom = (nextPps: number) => {
    setViewport((prev) => ({
      ...prev,
      pixelsPerSecond: clampPixelsPerSecond(nextPps),
    }));
  };

  // ── Keyframe rows per selected layer ──
  const selectedLayer = useMemo(
    () =>
      selectedLayerIds.length === 1
        ? document.layers.find((l) => l.id === selectedLayerIds[0])
        : null,
    [document.layers, selectedLayerIds],
  );

  const keyframeRows = useMemo(() => {
    if (!selectedLayer) return [];
    return selectedLayer.animations.map((anim) => ({
      property: anim.property,
      keyframeCount: anim.curve.keyframes.length,
      firstTimeUs: anim.curve.keyframes[0]?.timeMs ?? 0,
      lastTimeUs: anim.curve.keyframes[anim.curve.keyframes.length - 1]?.timeMs ?? 0,
    }));
  }, [selectedLayer]);

  const handleAddKeyframe = useCallback(
    (property: string) => {
      if (!selectedLayer) return;
      const timeMs = playheadMs;
      const existing = selectedLayer.animations.find((a) => a.property === property);
      const newKeyframe: MotionKeyframe = {
        id: crypto.randomUUID(),
        timeMs,
        value: 0,
        easing: { kind: 'builtin' as const, name: 'ease' as const },
      };
      const nextAnimation: MotionAnimation = existing
        ? {
            ...existing,
            curve: {
              ...existing.curve,
              keyframes: [...existing.curve.keyframes, newKeyframe].sort(
                (a, b) => a.timeMs - b.timeMs,
              ),
            },
          }
        : {
            property,
            curve: { keyframes: [newKeyframe] },
          };
      const next = existing
        ? selectedLayer.animations.map((a) => (a.property === property ? nextAnimation : a))
        : [...selectedLayer.animations, nextAnimation];
      dispatch('Add keyframe', {
        type: 'scene.setLayerAnimations',
        payload: { layerId: selectedLayer.id, animations: next },
      });
    },
    [dispatch, selectedLayer, playheadMs],
  );

  // ── Layer trim (in/out point drag) ──
  const handleTrimIn = useCallback(
    (layerId: MotionLayerId, newInMs: number) => {
      const layer = document.layers.find((l) => l.id === layerId);
      if (!layer) return;
      const clamped = Math.max(0, Math.min(newInMs, layer.outTimeMs ?? document.durationMs));
      dispatch('Trim in', {
        type: 'scene.setLayerProperty',
        payload: { layerId, property: 'inTimeMs', value: clamped },
      });
    },
    [dispatch, document.layers, document.durationMs],
  );

  const handleTrimOut = useCallback(
    (layerId: MotionLayerId, newOutMs: number) => {
      const layer = document.layers.find((l) => l.id === layerId);
      if (!layer) return;
      const clamped = Math.max(layer.inTimeMs ?? 0, Math.min(newOutMs, document.durationMs));
      dispatch('Trim out', {
        type: 'scene.setLayerProperty',
        payload: { layerId, property: 'outTimeMs', value: clamped },
      });
    },
    [dispatch, document.layers, document.durationMs],
  );

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
              onClick={() => {
                applyFitToWidth();
              }}
            >
              <FitWidthIcon />
            </button>
          </div>
        </div>
      </div>

      {/* Keyframe property rows for selected layer */}
      {selectedLayer && keyframeRows.length > 0 && (
        <div className="ms-timeline-keyframes" aria-label="Keyframe properties">
          <div className="ms-timeline-kf-header">
            <span>Property</span>
            <span>Keyframes</span>
            <span>Add</span>
          </div>
          {keyframeRows.map((row) => (
            <div key={row.property} className="ms-timeline-kf-row">
              <span className="ms-timeline-kf-prop">{row.property}</span>
              <span className="ms-timeline-kf-count">{row.keyframeCount}</span>
              <button
                type="button"
                className="icon-button ms-timeline-kf-add"
                aria-label={`Add keyframe to ${row.property}`}
                title={`Add keyframe at ${playheadMs.toFixed(0)}ms`}
                onClick={() => handleAddKeyframe(row.property)}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <rect x="5" y="1" width="2" height="10" fill="currentColor" />
                  <rect x="1" y="5" width="10" height="2" fill="currentColor" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Trim controls for selected layer */}
      {selectedLayer && (
        <div className="ms-timeline-trim" aria-label="Layer trim">
          <span className="ms-timeline-trim-label">In</span>
          <input
            aria-label="Trim in"
            type="number"
            className="ms-timeline-trim-input"
            value={Math.round(selectedLayer.inTimeMs ?? 0)}
            min={0}
            max={Math.round(selectedLayer.outTimeMs ?? document.durationMs)}
            onChange={(event) => handleTrimIn(selectedLayer.id, event.currentTarget.valueAsNumber)}
          />
          <span className="ms-timeline-trim-label">Out</span>
          <input
            aria-label="Trim out"
            type="number"
            className="ms-timeline-trim-input"
            value={Math.round(selectedLayer.outTimeMs ?? document.durationMs)}
            min={Math.round(selectedLayer.inTimeMs ?? 0)}
            max={document.durationMs}
            onChange={(event) => handleTrimOut(selectedLayer.id, event.currentTarget.valueAsNumber)}
          />
        </div>
      )}

      <TimelineCanvas
        className="dual-time-canvas"
        durationUs={durationUs}
        playheadUs={playheadUs}
        viewport={viewport}
        onViewportChange={setViewport}
        autoFit={false}
        tracks={tracks}
        selectedClipIds={selectedClipIds}
        onSeek={(timeUs) => onSeek(timeUs / 1000)}
        onSelectClips={(clipIds) => onSelectLayer(clipIds[0] ?? null)}
        markers={markers}
        gutterLabel="Layers"
        gutterIconSrc={UI_ICONS.layers}
      />
    </section>
  );
}
