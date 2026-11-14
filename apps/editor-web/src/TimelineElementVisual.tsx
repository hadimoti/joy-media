import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { WaveformBucket } from '@joy-media/audio-core';
import {
  AudioIcon,
  AutoCaptionIcon,
  CubeIcon,
  EffectsUiIcon,
  FilmIcon,
  FilterIcon,
  LayersIcon,
  SlidersIcon,
  TextTabIcon,
  WorkflowPathIcon,
} from './icons.js';
import type { TimelineElementKind } from './timeline-element-kind.js';
import {
  decodeTimelineFilmstripFrames,
  decodeTimelineWaveform,
  getCachedFilmstripFrames,
  getCachedWaveformPeaks,
  loadTimelineAssetBlob,
} from './timeline-media-cache.js';
import {
  scheduleFilmstripFrameTimes,
  visibleFilmstripTiles,
  type TimelineElementMediaSource,
} from './timeline-media.js';

function filmstripCellCount(widthPx: number): number {
  return Math.max(2, Math.min(24, Math.floor(widthPx / 28)));
}

function waveformBarCount(widthPx: number, pixelsPerSecond: number): number {
  const barPitchPx = Math.max(1.25, Math.min(8, 140 / Math.max(5, pixelsPerSecond)));
  return Math.max(8, Math.min(512, Math.round(widthPx / barPitchPx)));
}

export function TimelineElementGlyph({ kind }: { readonly kind: TimelineElementKind }) {
  switch (kind) {
    case 'text':
      return <TextTabIcon />;
    case 'caption':
      return <AutoCaptionIcon />;
    case 'motion':
      return <WorkflowPathIcon />;
    case 'effect':
      return <EffectsUiIcon />;
    case 'filter':
      return <FilterIcon />;
    case 'adjust':
      return <SlidersIcon />;
    case 'overlay':
      return <LayersIcon />;
    case 'scene3d':
      return <CubeIcon />;
    case 'audio':
      return <AudioIcon />;
    case 'video':
    default:
      return <FilmIcon />;
  }
}

function Filmstrip({
  widthPx,
  frameTimesUs,
  frames,
  hostRef,
}: {
  readonly widthPx: number;
  readonly frameTimesUs: readonly number[];
  readonly frames: ReadonlyMap<number, string> | undefined;
  readonly hostRef: RefObject<HTMLSpanElement | null>;
}) {
  const count = Math.min(
    frameTimesUs.length || filmstripCellCount(widthPx),
    visibleFilmstripTiles(widthPx),
  );
  return (
    <span className="timeline-clip-filmstrip" aria-hidden="true" ref={hostRef}>
      {Array.from({ length: count }, (_, index) => {
        const sourceTimeUs = frameTimesUs[index];
        const frame = sourceTimeUs === undefined ? undefined : frames?.get(sourceTimeUs);
        return (
          <span
            key={index}
            className={`timeline-clip-cell${frame === undefined ? ' is-placeholder' : ' has-frame'}`}
            data-source-time-us={sourceTimeUs}
            style={
              frame === undefined
                ? undefined
                : { backgroundImage: `url("${frame}")`, backgroundPosition: 'center' }
            }
          />
        );
      })}
    </span>
  );
}

function Waveform({
  widthPx,
  pixelsPerSecond,
  peaks,
  hostRef,
}: {
  readonly widthPx: number;
  readonly pixelsPerSecond: number;
  readonly peaks: readonly WaveformBucket[] | undefined;
  readonly hostRef: RefObject<HTMLSpanElement | null>;
}) {
  if (peaks === undefined || peaks.length === 0) {
    return (
      <span className="timeline-clip-waveform is-placeholder" aria-hidden="true" ref={hostRef} />
    );
  }

  const count = waveformBarCount(widthPx, pixelsPerSecond);
  return (
    <span className="timeline-clip-waveform" aria-hidden="true" ref={hostRef}>
      {Array.from({ length: count }, (_, index) => {
        const peak = peaks[Math.min(peaks.length - 1, Math.floor((index * peaks.length) / count))]!;
        const level = Math.max(Math.abs(peak.min), Math.abs(peak.max));
        const tone = level > 0.78 ? 'is-peak' : level > 0.48 ? '' : 'is-mid';
        return (
          <span
            key={index}
            className={`timeline-clip-wave-bar ${tone}`.trim()}
            style={{ height: `${Math.max(1, Math.round(level * 100))}%` }}
          />
        );
      })}
    </span>
  );
}

/** Shared clip interior used by Classic Timeline and Dual Lens Time View. */
export const TimelineElementMedia = memo(function TimelineElementMedia({
  kind,
  widthPx,
  pixelsPerSecond,
  media,
  loadAssetBlob,
}: {
  readonly kind: TimelineElementKind;
  readonly widthPx: number;
  readonly pixelsPerSecond: number;
  readonly media?: TimelineElementMediaSource;
  readonly loadAssetBlob?: (assetId: string) => Promise<Blob | undefined>;
}) {
  const mediaRef = useRef<HTMLSpanElement>(null);
  const [isInView, setIsInView] = useState(false);
  const [frameState, setFrameState] = useState<
    { readonly assetId: string; readonly frames: ReadonlyMap<number, string> } | undefined
  >(undefined);
  const [waveformState, setWaveformState] = useState<
    { readonly assetId: string; readonly peaks: readonly WaveformBucket[] } | undefined
  >(undefined);
  const frameTimesUs = useMemo(
    () =>
      media === undefined
        ? []
        : scheduleFilmstripFrameTimes({
            sourceInUs: media.sourceInUs,
            durationUs: media.durationUs,
            pixelsPerSecond,
            ...(media.playbackRate === undefined ? {} : { playbackRate: media.playbackRate }),
            ...(media.reversed === undefined ? {} : { reversed: media.reversed }),
          }),
    [media, pixelsPerSecond],
  );
  const assetId = media?.assetId;

  useEffect(() => {
    const host = mediaRef.current;
    if (host === null || assetId === undefined || typeof IntersectionObserver === 'undefined')
      return;
    const observer = new IntersectionObserver(
      (entries) => setIsInView(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '0px' },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [assetId, kind]);

  useEffect(() => {
    if (
      !isInView ||
      assetId === undefined ||
      loadAssetBlob === undefined ||
      (kind !== 'video' && kind !== 'overlay')
    )
      return;
    let current = true;
    void loadTimelineAssetBlob(assetId, loadAssetBlob)
      .then((blob) =>
        blob === undefined
          ? new Map<number, string>()
          : getCachedFilmstripFrames(assetId, frameTimesUs, (missingTimes) =>
              decodeTimelineFilmstripFrames(blob, missingTimes),
            ),
      )
      .then((frames) => {
        if (current) setFrameState({ assetId, frames });
      });
    return () => {
      current = false;
    };
  }, [assetId, frameTimesUs, isInView, kind, loadAssetBlob]);

  useEffect(() => {
    if (!isInView || assetId === undefined || loadAssetBlob === undefined || kind !== 'audio')
      return;
    let current = true;
    void loadTimelineAssetBlob(assetId, loadAssetBlob)
      .then((blob) =>
        blob === undefined
          ? undefined
          : getCachedWaveformPeaks(assetId, () => decodeTimelineWaveform(blob)),
      )
      .then((peaks) => {
        if (current && peaks !== undefined) setWaveformState({ assetId, peaks });
      });
    return () => {
      current = false;
    };
  }, [assetId, isInView, kind, loadAssetBlob]);

  if (kind === 'audio') {
    return (
      <Waveform
        widthPx={widthPx}
        pixelsPerSecond={pixelsPerSecond}
        peaks={
          waveformState !== undefined && waveformState.assetId === assetId
            ? waveformState.peaks
            : undefined
        }
        hostRef={mediaRef}
      />
    );
  }
  if (kind === 'overlay' || kind === 'video') {
    return (
      <Filmstrip
        widthPx={widthPx}
        frameTimesUs={frameTimesUs}
        frames={
          frameState !== undefined && frameState.assetId === assetId ? frameState.frames : undefined
        }
        hostRef={mediaRef}
      />
    );
  }
  return <span className="timeline-clip-kind-surface" aria-hidden="true" />;
});
