import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  MonitorAspectRatioSelector,
  type MonitorAspectRatio,
} from '../MonitorAspectRatioSelector.js';
import type { BrowserGpuPreviewSession } from '../control-plane-client.js';
import { previewQualityLabel, type PreviewQuality } from '../preview-quality.js';
import {
  CloseIcon,
  FullscreenIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  ZoomInIcon,
} from '../icons.js';
import {
  MONITOR_ZOOM_PRESETS,
  type MonitorGpuPreviewStatus,
  type MonitorPreviewRenderer,
  type MonitorViewerZoom,
} from './monitor-view.js';

/** Props are the monitor's own state and setters, passed through unchanged. */
export interface MonitorTransportProps {
  readonly transportRef: RefObject<HTMLDivElement | null>;
  readonly zoomDrawerOpen: boolean;
  readonly setZoomDrawerOpen: Dispatch<SetStateAction<boolean>>;
  readonly viewerZoom: MonitorViewerZoom;
  readonly setViewerZoom: Dispatch<SetStateAction<MonitorViewerZoom>>;
  readonly zoomLabel: string;
  readonly fullscreen: boolean;
  readonly toggleFullscreen: () => void;
  readonly playing: boolean;
  readonly playheadUs: number;
  readonly durationUs: number;
  readonly hasTimelineContent: boolean;
  readonly seek: (timeUs: number) => void;
  readonly togglePlayback: () => void;
  readonly previewQuality: PreviewQuality;
  readonly setPreviewQuality: Dispatch<SetStateAction<PreviewQuality>>;
  readonly previewRenderer: MonitorPreviewRenderer;
  readonly setPreviewRenderer: Dispatch<SetStateAction<MonitorPreviewRenderer>>;
  readonly gpuPreviewStatus: MonitorGpuPreviewStatus;
  readonly gpuSession: BrowserGpuPreviewSession | undefined;
  readonly monitorAspectRatio: MonitorAspectRatio;
  readonly width: number;
  readonly height: number;
  readonly changeMonitorAspectRatio: (nextAspectRatio: MonitorAspectRatio) => void;
}

/** The bar under the monitor: scale drawer, play controls, quality, renderer, ratio. */
export function MonitorTransport({
  transportRef,
  zoomDrawerOpen,
  setZoomDrawerOpen,
  viewerZoom,
  setViewerZoom,
  zoomLabel,
  fullscreen,
  toggleFullscreen,
  playing,
  playheadUs,
  durationUs,
  hasTimelineContent,
  seek,
  togglePlayback,
  previewQuality,
  setPreviewQuality,
  previewRenderer,
  setPreviewRenderer,
  gpuPreviewStatus,
  gpuSession,
  monitorAspectRatio,
  width,
  height,
  changeMonitorAspectRatio,
}: MonitorTransportProps) {
  return (
    <div className="monitor-transport" ref={transportRef}>
      {zoomDrawerOpen && (
        <div
          className="monitor-zoom-drawer"
          id="monitor-zoom-drawer"
          role="dialog"
          aria-label="Preview scale"
        >
          <div className="monitor-zoom-drawer-head">
            <strong>Preview scale</strong>
            <button
              type="button"
              className="monitor-transport-btn"
              aria-label="Close scale options"
              title="Close"
              onClick={() => setZoomDrawerOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>
          <div className="monitor-zoom-group" role="group" aria-label="Preview zoom">
            {MONITOR_ZOOM_PRESETS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="monitor-zoom-chip"
                aria-pressed={viewerZoom === id}
                aria-label={`Zoom ${label}`}
                title={`Zoom ${label}`}
                onClick={() => {
                  setViewerZoom(id);
                  setZoomDrawerOpen(false);
                }}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className="monitor-transport-btn"
              aria-pressed={fullscreen}
              aria-label="Fullscreen preview"
              data-guide="Full"
              onClick={() => {
                toggleFullscreen();
                setZoomDrawerOpen(false);
              }}
            >
              <FullscreenIcon />
            </button>
          </div>
        </div>
      )}
      <div className="monitor-transport-controls">
        <button
          type="button"
          className="monitor-transport-btn"
          aria-label="Seek back 1s"
          title="Seek back 1s (←)"
          onClick={() => seek(Math.max(0, playheadUs - 1_000_000))}
        >
          <SkipBackIcon />
        </button>
        <button
          type="button"
          className="monitor-transport-btn"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={togglePlayback}
          disabled={!hasTimelineContent}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          className="monitor-transport-btn"
          aria-label="Seek forward 1s"
          title="Seek forward 1s (→)"
          onClick={() => seek(Math.min(durationUs, playheadUs + 1_000_000))}
        >
          <SkipForwardIcon />
        </button>
      </div>
      <div className="monitor-transport-end">
        <label className="monitor-preview-control">
          <span>Quality</span>
          <select
            aria-label="Monitor preview quality"
            value={previewQuality}
            onChange={(event) => setPreviewQuality(event.target.value as PreviewQuality)}
          >
            {(['quarter', 'half', 'full'] as const).map((quality) => (
              <option key={quality} value={quality}>
                {previewQualityLabel(quality)}
              </option>
            ))}
          </select>
        </label>
        <label className="monitor-preview-control">
          <span>Renderer</span>
          <select
            aria-label="Monitor preview renderer"
            value={previewRenderer}
            onChange={(event) =>
              setPreviewRenderer(event.target.value as 'auto' | 'gpu-worker' | 'local')
            }
          >
            <option value="auto">Auto</option>
            <option value="gpu-worker">GPU Worker</option>
            <option value="local">Local</option>
          </select>
        </label>
        <span
          className={`monitor-preview-status is-${gpuPreviewStatus}`}
          title={gpuSession === undefined ? undefined : `Worker ${gpuSession.workerId}`}
        >
          {gpuPreviewStatus === 'hardware-gpu'
            ? 'GPU'
            : gpuPreviewStatus === 'connecting'
              ? 'Connecting'
              : gpuPreviewStatus === 'fallback'
                ? 'Local fallback'
                : 'Local'}
        </span>
        <button
          type="button"
          className="monitor-transport-btn"
          aria-label={`Preview scale (${zoomLabel})`}
          aria-expanded={zoomDrawerOpen}
          aria-controls="monitor-zoom-drawer"
          aria-pressed={zoomDrawerOpen}
          data-guide="Scale"
          onClick={() => setZoomDrawerOpen((open) => !open)}
        >
          <ZoomInIcon />
        </button>
        <MonitorAspectRatioSelector
          selectedAspectRatio={monitorAspectRatio}
          authoredWidth={width}
          authoredHeight={height}
          onAspectRatioChange={changeMonitorAspectRatio}
        />
      </div>
    </div>
  );
}
