import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { PopupControl } from '../popup-manager.js';
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
import type { MonitorGpuPreviewStatus, MonitorPreviewRenderer } from './monitor-view.js';
import { MONITOR_ZOOM_PRESETS, formatZoomPercent, parseZoomPercent } from './monitor-view-state.js';

/** Props are the monitor's own state and setters, passed through unchanged. */
export interface MonitorTransportProps {
  readonly zoomDrawer: PopupControl;
  /** True while the view follows the panel size. */
  readonly zoomFit: boolean;
  /** The zoom shown now (1 = 100 %), also while Fit. */
  readonly zoom: number;
  readonly onZoomFit: () => void;
  readonly onZoomSet: (zoom: number) => void;
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

/** The bar under the monitor: zoom drawer, play controls, quality, renderer, ratio. */
export function MonitorTransport({
  zoomDrawer,
  zoomFit,
  zoom,
  onZoomFit,
  onZoomSet,
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
  const zoomText = formatZoomPercent(zoom);
  const [typedZoom, setTypedZoom] = useState(zoomText);
  useEffect(() => setTypedZoom(zoomText), [zoomText]);
  const commitTypedZoom = () => {
    const parsed = parseZoomPercent(typedZoom);
    if (parsed === undefined) {
      setTypedZoom(zoomText);
      return;
    }
    setTypedZoom(formatZoomPercent(parsed));
    onZoomSet(parsed);
  };
  return (
    <div className="monitor-transport" ref={zoomDrawer.rootRef}>
      {zoomDrawer.open && (
        <div
          className="monitor-zoom-drawer"
          id="monitor-zoom-drawer"
          role="dialog"
          aria-label="Preview scale"
        >
          <div className="monitor-zoom-drawer-head">
            <strong>Zoom</strong>
            <button
              type="button"
              className="monitor-transport-btn"
              aria-label="Close scale options"
              title="Close"
              onClick={() => zoomDrawer.close()}
            >
              <CloseIcon />
            </button>
          </div>
          <div className="monitor-zoom-group" role="group" aria-label="Preview zoom">
            <button
              type="button"
              className="monitor-zoom-chip"
              aria-pressed={zoomFit}
              aria-label="Zoom Fit"
              title="Fit the whole frame (Ctrl+0)"
              onClick={() => {
                onZoomFit();
                zoomDrawer.close();
              }}
            >
              Fit
            </button>
            {MONITOR_ZOOM_PRESETS.map((preset) => {
              const label = formatZoomPercent(preset);
              return (
                <button
                  key={preset}
                  type="button"
                  className="monitor-zoom-chip"
                  aria-pressed={!zoomFit && Math.abs(zoom - preset) < 1e-6}
                  aria-label={`Zoom ${label}`}
                  title={preset === 1 ? `Zoom ${label} (Ctrl+1)` : `Zoom ${label}`}
                  onClick={() => {
                    onZoomSet(preset);
                    zoomDrawer.close();
                  }}
                >
                  {label}
                </button>
              );
            })}
            <input
              className="monitor-zoom-input"
              type="text"
              inputMode="decimal"
              aria-label="Zoom percent"
              title="Type a zoom from 10% to 800%. Ctrl+plus and Ctrl+minus also zoom."
              value={typedZoom}
              onChange={(event) => setTypedZoom(event.target.value)}
              onBlur={commitTypedZoom}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitTypedZoom();
                }
              }}
            />
            <button
              type="button"
              className="monitor-transport-btn"
              aria-pressed={fullscreen}
              aria-label="Fullscreen preview"
              data-guide="Full"
              onClick={() => {
                toggleFullscreen();
                zoomDrawer.close();
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
          aria-expanded={zoomDrawer.open}
          aria-controls="monitor-zoom-drawer"
          aria-pressed={zoomDrawer.open}
          data-guide="Scale"
          onClick={(event) => zoomDrawer.toggle(event.currentTarget)}
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
