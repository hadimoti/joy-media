/**
 * Shared px-based timeline surface (ruler + grid + lanes + clips).
 * TimelinePanel (edit) and Dual Lens Time View (inspect) both render this
 * geometry so zoom/fit and clip widths stay one source of truth.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  buildRulerTicks,
  fitPixelsPerSecond,
  timeToPixel,
  type TimelineViewport,
} from '@joy-media/timeline-engine';
import { TimelineRuler, TimelineTracksGrid } from './TimelineRuler.js';
import { formatTime } from './format-time.js';
import { useTimelineMarkerSelection } from './useTimelineMarkerSelection.js';
import {
  AiEffectIcon,
  AutoCaptionIcon,
  CloseIcon,
  CommandIcon,
  ImageIcon,
  ListIcon,
  LockIcon,
  MuteIcon,
  SearchIcon,
  SoloIcon,
  SpeakerOnIcon,
  TimelineAudioTrackIcon,
  TimelineMarkerIcon,
  TimelineScriptTrackIcon,
  TimelineVideoTrackIcon,
} from './icons.js';

export type TimelineCanvasIcon =
  'video' | 'audio' | 'text' | 'caption' | 'script' | 'prompt' | 'generation' | 'agent' | 'generic';

export interface TimelineCanvasItem {
  readonly id: string;
  readonly label: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly clipId?: string;
  readonly icon?: TimelineCanvasIcon;
  readonly unplaced?: boolean;
}

export interface TimelineCanvasTrack {
  readonly id: string;
  readonly label: string;
  readonly items: readonly TimelineCanvasItem[];
  readonly advanced?: boolean;
  /** When set, gutter uses the same kind-icon + code + name chrome as Timeline. */
  readonly header?: {
    readonly kind: TimelineCanvasIcon;
    readonly code: string;
    readonly name: string;
  };
  /** Lock / mute / solo — same controls as the main Timeline gutter. */
  readonly controls?: {
    readonly trackId: string;
    readonly locked: boolean;
    readonly muted: boolean;
    readonly solo: boolean;
    readonly onToggle: (flag: 'locked' | 'muted' | 'solo') => void;
  };
}

export interface TimelineCanvasMarker {
  readonly id: string;
  readonly timeUs: number;
  readonly label: string;
}

export interface TimelineCanvasProps {
  readonly durationUs: number;
  readonly playheadUs: number;
  readonly viewport: TimelineViewport;
  readonly onViewportChange: (next: TimelineViewport) => void;
  readonly autoFit?: boolean;
  readonly tracks: readonly TimelineCanvasTrack[];
  readonly selectedClipIds: ReadonlySet<string>;
  readonly onSeek: (timeUs: number) => void;
  readonly onSelectClips: (clipIds: readonly string[]) => void;
  /** Extra class on the scroll root (e.g. dual-time shell keeps section chrome). */
  readonly className?: string;
  readonly gutterLabel?: string;
  /** Optional PNG mask URL shown before the gutter label (e.g. Layers stack). */
  readonly gutterIconSrc?: string;
  readonly markers?: readonly TimelineCanvasMarker[];
  readonly onRemoveMarker?: (id: string) => void;
}

function hashUnit(seed: string, salt: number): number {
  let h = (salt + 1) * 0x9e3779b9;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function filmstripCellCount(widthPx: number): number {
  return Math.max(2, Math.min(24, Math.floor(widthPx / 28)));
}

function ItemGlyph({ icon }: { readonly icon: TimelineCanvasIcon | undefined }) {
  switch (icon) {
    case 'audio':
      return <TimelineAudioTrackIcon />;
    case 'text':
      return <ListIcon />;
    case 'caption':
      return <AutoCaptionIcon />;
    case 'script':
      return <TimelineScriptTrackIcon />;
    case 'prompt':
      return <SearchIcon />;
    case 'generation':
      return <ImageIcon />;
    case 'agent':
      return <AiEffectIcon />;
    case 'generic':
      return <CommandIcon />;
    case 'video':
    case undefined:
    default:
      return <TimelineVideoTrackIcon />;
  }
}

function TrackHeaderChrome({
  header,
  fallbackLabel,
  controls,
}: {
  readonly header:
    | {
        readonly kind: TimelineCanvasIcon;
        readonly code: string;
        readonly name: string;
      }
    | undefined;
  readonly fallbackLabel: string;
  readonly controls:
    | {
        readonly trackId: string;
        readonly locked: boolean;
        readonly muted: boolean;
        readonly solo: boolean;
        readonly onToggle: (flag: 'locked' | 'muted' | 'solo') => void;
      }
    | undefined;
}) {
  const label =
    header === undefined ? (
      <strong title={fallbackLabel}>{fallbackLabel}</strong>
    ) : (
      <>
        <span
          className="timeline-track-kind-icon"
          title={`${header.kind[0]?.toUpperCase() ?? ''}${header.kind.slice(1)} track`}
        >
          <ItemGlyph icon={header.kind} />
        </span>
        <div className="timeline-track-label">
          <span className="track-code" dir="ltr">
            {header.code}
          </span>
          <span className="track-name" dir="ltr" title={header.name}>
            {header.name}
          </span>
        </div>
      </>
    );

  if (controls === undefined) return label;

  return (
    <>
      {label}
      <button
        type="button"
        className="icon-button"
        aria-pressed={controls.locked}
        aria-label={`Lock ${controls.trackId}`}
        title={controls.locked ? 'Unlock track' : 'Lock track'}
        onClick={() => controls.onToggle('locked')}
      >
        <LockIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-pressed={controls.muted}
        aria-label={`Mute ${controls.trackId}`}
        title={controls.muted ? 'Unmute track' : 'Mute track'}
        onClick={() => controls.onToggle('muted')}
      >
        {controls.muted ? <MuteIcon /> : <SpeakerOnIcon />}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-pressed={controls.solo}
        aria-label={`Solo ${controls.trackId}`}
        title={controls.solo ? 'Unsolo track' : 'Solo track'}
        onClick={() => controls.onToggle('solo')}
      >
        <SoloIcon />
      </button>
    </>
  );
}

function InspectClip({
  item,
  viewport,
  selected,
  onSelect,
  onSeek,
}: {
  readonly item: TimelineCanvasItem;
  readonly viewport: TimelineViewport;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onSeek: (timeUs: number) => void;
}) {
  const durationUs = Math.max(1, item.endUs - item.startUs);
  const leftPx = timeToPixel(item.startUs, { ...viewport, originUs: 0 });
  const widthPx = Math.max(8, durationUs * (viewport.pixelsPerSecond / 1_000_000));
  const gapPx = 1;
  const layoutWidthPx = Math.max(6, widthPx - gapPx);
  const showChrome = layoutWidthPx >= 48;
  const showDuration = layoutWidthPx >= 100;
  const cellCount = filmstripCellCount(layoutWidthPx);
  const durationLabel = `${(durationUs / 1_000_000).toFixed(1)}s`;

  return (
    <button
      type="button"
      className="timeline-clip timeline-clip--video timeline-clip--lane-0"
      aria-pressed={item.clipId === undefined ? undefined : selected}
      title={
        item.clipId === undefined
          ? item.label
          : `${item.label} — click to select, double-click to go to it`
      }
      style={{
        left: `${leftPx}px`,
        width: `${layoutWidthPx}px`,
      }}
      onClick={() => {
        if (item.clipId !== undefined) onSelect();
        else onSeek(item.startUs);
      }}
      onDoubleClick={() => onSeek(item.startUs)}
    >
      <span className="timeline-clip-filmstrip" aria-hidden="true">
        {Array.from({ length: cellCount }, (_, index) => {
          const t = hashUnit(item.id, index);
          const u = hashUnit(item.id, index + 17);
          const r = 244 + t * (139 - 244);
          const g = 183 + t * (108 - 183);
          const b = 47 + t * (255 - 47);
          const lift = 0.22 + u * 0.28;
          return (
            <span
              key={index}
              className="timeline-clip-cell"
              style={{
                backgroundColor: `rgb(${Math.round(r + (255 - r) * lift)} ${Math.round(g + (255 - g) * lift)} ${Math.round(b + (255 - b) * lift)})`,
              }}
            />
          );
        })}
      </span>
      {showChrome && (
        <span className="timeline-clip-chrome">
          <span className="timeline-clip-icon" aria-hidden="true">
            <ItemGlyph icon={item.icon} />
          </span>
          <span className="timeline-clip-label">{item.label}</span>
          {showDuration && <span className="timeline-clip-duration">{durationLabel}</span>}
        </span>
      )}
    </button>
  );
}

export function TimelineCanvas({
  durationUs,
  playheadUs,
  viewport,
  onViewportChange,
  autoFit = true,
  tracks,
  selectedClipIds,
  onSeek,
  onSelectClips,
  className,
  gutterLabel,
  gutterIconSrc,
  markers = [],
  onRemoveMarker,
}: TimelineCanvasProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const laneMeasureRef = useRef<HTMLDivElement | null>(null);
  const { selectedMarkerId, selectMarker, removeMarker } = useTimelineMarkerSelection(markers, {
    clipSelected: selectedClipIds.size > 0,
    ...(onRemoveMarker === undefined ? {} : { onRemoveMarker }),
  });
  const safeDurationUs = Math.max(1, durationUs);

  const laneWidthPx = Math.max(64, timeToPixel(safeDurationUs, { ...viewport, originUs: 0 }));
  const rulerTicks = useMemo(
    () =>
      buildRulerTicks({
        durationUs: safeDurationUs,
        pixelsPerSecond: viewport.pixelsPerSecond,
        originUs: 0,
      }),
    [safeDurationUs, viewport.pixelsPerSecond],
  );

  useEffect(() => {
    const root = scrollRef.current;
    if (root === null || !autoFit) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const lane = laneMeasureRef.current;
      const width = lane?.clientWidth ?? Math.max(0, entry.contentRect.width - 152);
      if (width > 0) {
        onViewportChange({
          ...viewport,
          pixelsPerSecond: fitPixelsPerSecond(safeDurationUs, width),
        });
      }
    });
    observer.observe(root);
    return () => observer.disconnect();
    // Intentionally depend on duration/autoFit; viewport is written, not read for equality.
  }, [autoFit, safeDurationUs, onViewportChange]);

  const playheadLeft = `calc(9.5rem + ${timeToPixel(playheadUs, { ...viewport, originUs: 0 })}px)`;

  return (
    <div className={['timeline-tracks', className].filter(Boolean).join(' ')} ref={scrollRef}>
      <div className="timeline-scrub-row" style={{ minWidth: `calc(9.5rem + ${laneWidthPx}px)` }}>
        <div className="timeline-scrub-gutter">
          <output className="timeline-timecode" aria-live="polite">
            {gutterIconSrc !== undefined ? (
              <span className="timeline-timecode-label">
                <span
                  className="png-mask-icon timeline-timecode-icon"
                  style={{
                    WebkitMaskImage: `url(${gutterIconSrc})`,
                    maskImage: `url(${gutterIconSrc})`,
                  }}
                  aria-hidden="true"
                />
                <span>{gutterLabel ?? formatTime(playheadUs)}</span>
              </span>
            ) : (
              (gutterLabel ?? formatTime(playheadUs))
            )}
          </output>
        </div>
        <TimelineRuler
          durationUs={safeDurationUs}
          playheadUs={playheadUs}
          viewport={{ ...viewport, originUs: 0 }}
          widthPx={laneWidthPx}
          ticks={rulerTicks}
          onSeek={onSeek}
        />
        <span
          className="timeline-playhead timeline-playhead--scrub"
          style={{ left: playheadLeft }}
          aria-hidden="true"
        />
      </div>
      <div className="timeline-tracks-inner" ref={laneMeasureRef}>
        <TimelineTracksGrid ticks={rulerTicks} widthPx={laneWidthPx} />
        <span className="timeline-playhead" style={{ left: playheadLeft }} aria-hidden="true" />
        {tracks.map((track, index) => (
          <div
            className={`timeline-track${track.advanced === true ? ' is-data' : ''}`}
            key={track.id}
            style={{ height: 44 }}
          >
            <div className="timeline-track-header">
              <TrackHeaderChrome
                header={track.header}
                fallbackLabel={track.label}
                controls={track.controls}
              />
            </div>
            <div className="timeline-lane" style={{ minWidth: laneWidthPx }}>
              {index === 0 &&
                markers.map((marker) => {
                  const selected = selectedMarkerId === marker.id;
                  return (
                    <div
                      key={marker.id}
                      className={selected ? 'timeline-marker is-selected' : 'timeline-marker'}
                      style={{
                        left: `${timeToPixel(marker.timeUs, { ...viewport, originUs: 0 })}px`,
                      }}
                    >
                      <button
                        type="button"
                        className="timeline-marker-hit"
                        aria-pressed={selected}
                        title={`${marker.label} — Delete to remove`}
                        aria-label={`${marker.label}. Delete to remove.`}
                        onClick={() => {
                          onSelectClips([]);
                          selectMarker(marker.id);
                          onSeek(marker.timeUs);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          removeMarker(marker.id);
                        }}
                      >
                        <TimelineMarkerIcon />
                      </button>
                      <button
                        type="button"
                        className="timeline-marker-remove"
                        aria-label={`Remove ${marker.label}`}
                        title="Remove marker"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          removeMarker(marker.id);
                        }}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  );
                })}
              {track.items.length === 0 ? (
                <span className="timeline-lane-empty">No data</span>
              ) : (
                track.items.map((item) => {
                  if (item.unplaced === true) {
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="timeline-clip timeline-clip--video timeline-clip--lane-0 is-unplaced"
                        title={item.label}
                        onClick={() => {
                          if (item.startUs !== undefined) onSeek(item.startUs);
                        }}
                      >
                        <span className="timeline-clip-chrome">
                          <span className="timeline-clip-icon" aria-hidden="true">
                            <ItemGlyph icon={item.icon} />
                          </span>
                          <span className="timeline-clip-label">{item.label}</span>
                        </span>
                      </button>
                    );
                  }
                  const selected = item.clipId !== undefined && selectedClipIds.has(item.clipId);
                  return (
                    <InspectClip
                      key={item.id}
                      item={item}
                      viewport={viewport}
                      selected={selected}
                      onSelect={() => {
                        if (item.clipId !== undefined) onSelectClips([item.clipId]);
                      }}
                      onSeek={onSeek}
                    />
                  );
                })
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
