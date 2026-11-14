import { useEffect, useMemo, useState } from 'react';
import { timeToPixel, type TimelineViewport } from '@joy-media/timeline-engine';
import { TimelineElementMedia } from './TimelineElementVisual.js';
import { linkedAudioStrips, stackLinkedAudioStrips } from './timeline-linked-audio.js';
import { linkedStripMedia, type LinkedAudioLaneInputs } from './timeline-linked-audio-source.js';
import {
  decodeTimelineWaveform,
  getCachedWaveformPeaks,
  loadTimelineAssetBlob,
} from './timeline-media-cache.js';

/**
 * Which assets carry an audio stream, found with the same bounded waveform decode
 * that real audio clips use (so the work is shared, never repeated). An asset
 * whose file cannot be loaded stays unknown and draws nothing; an asset with no
 * decodable audio stream is recorded as silent and draws nothing.
 *
 * Assets are probed one at a time so a project with many videos never starts
 * many decodes at once.
 */
export function useAssetsWithAudio(
  assetIds: readonly string[],
  loadAssetBlob: ((assetId: string) => Promise<Blob | undefined>) | undefined,
): ReadonlyMap<string, boolean> {
  const [known, setKnown] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const idsKey = useMemo(() => [...new Set(assetIds)].sort().join('\n'), [assetIds]);

  useEffect(() => {
    if (loadAssetBlob === undefined || idsKey === '') return;
    let current = true;
    void (async () => {
      for (const assetId of idsKey.split('\n')) {
        if (!current) return;
        const blob = await loadTimelineAssetBlob(assetId, loadAssetBlob);
        if (!current || blob === undefined) continue;
        const peaks = await getCachedWaveformPeaks(assetId, () => decodeTimelineWaveform(blob));
        if (!current) return;
        const hasAudio = peaks !== undefined && peaks.length > 0;
        setKnown((previous) =>
          previous.get(assetId) === hasAudio ? previous : new Map(previous).set(assetId, hasAudio),
        );
      }
    })();
    return () => {
      current = false;
    };
  }, [idsKey, loadAssetBlob]);

  return known;
}

/** A clip counts as near when it touches the visible span or lies within one screen width of it. */
function clipIsNearRange(
  startUs: number,
  durationUs: number,
  range: { readonly startUs: number; readonly endUs: number } | undefined,
): boolean {
  if (range === undefined) return true;
  const margin = Math.max(0, range.endUs - range.startUs);
  return startUs + durationUs >= range.startUs - margin && startUs <= range.endUs + margin;
}

/**
 * Display-only strips on the A1 lane: the audio of each video clip that has an
 * audio stream, under the clip's time span. They read the timeline and write
 * nothing, take no pointer events and never become part of a selection.
 */
export function TimelineLinkedAudioStrips({
  inputs,
  viewport,
  loadAssetBlob,
  visibleRangeUs,
}: {
  readonly inputs: LinkedAudioLaneInputs;
  readonly viewport: TimelineViewport;
  readonly loadAssetBlob?: ((assetId: string) => Promise<Blob | undefined>) | undefined;
  /** The time span on screen. Only clips in (or near) it are probed; undefined probes every clip. */
  readonly visibleRangeUs?: { readonly startUs: number; readonly endUs: number } | undefined;
}) {
  const rangeStartUs = visibleRangeUs?.startUs;
  const rangeEndUs = visibleRangeUs?.endUs;
  const assetIds = useMemo(() => {
    const range =
      rangeStartUs === undefined || rangeEndUs === undefined
        ? undefined
        : { startUs: rangeStartUs, endUs: rangeEndUs };
    return inputs.videoClips
      .filter((clip) => clipIsNearRange(clip.startUs, clip.durationUs, range))
      .map((clip) => clip.assetId);
  }, [inputs.videoClips, rangeStartUs, rangeEndUs]);
  const withAudio = useAssetsWithAudio(assetIds, loadAssetBlob);
  const strips = useMemo(
    () =>
      linkedAudioStrips({
        videoClips: inputs.videoClips,
        a1Clips: inputs.a1Clips,
        hasAudioStream: (assetId) => withAudio.get(assetId),
      }),
    [inputs.videoClips, inputs.a1Clips, withAudio],
  );
  const { stacked, layerCount } = useMemo(() => stackLinkedAudioStrips(strips), [strips]);
  const clipsById = useMemo(
    () => new Map(inputs.videoClips.map((clip) => [clip.clipId, clip] as const)),
    [inputs.videoClips],
  );

  return (
    <>
      {stacked.map(({ strip, layer }) => {
        const clip = clipsById.get(strip.clipId);
        if (clip === undefined) return null;
        const leftPx = timeToPixel(strip.startUs, { ...viewport, originUs: 0 });
        const widthPx = Math.max(
          2,
          ((strip.endUs - strip.startUs) * viewport.pixelsPerSecond) / 1_000_000 - 1,
        );
        return (
          <span
            key={`${strip.clipId}-${strip.startUs}`}
            className="timeline-linked-audio-strip"
            data-linked-audio-clip={strip.clipId}
            data-start-us={strip.startUs}
            data-end-us={strip.endUs}
            aria-hidden="true"
            style={{
              left: `${leftPx}px`,
              width: `${widthPx}px`,
              ...(layerCount > 1
                ? {
                    top: `calc(0.2rem + (100% - 0.4rem) * ${layer} / ${layerCount})`,
                    height: `calc((100% - 0.4rem) / ${layerCount})`,
                    bottom: 'auto',
                  }
                : {}),
            }}
          >
            <TimelineElementMedia
              kind="audio"
              widthPx={widthPx}
              pixelsPerSecond={viewport.pixelsPerSecond}
              media={linkedStripMedia(clip, strip)}
              {...(loadAssetBlob === undefined ? {} : { loadAssetBlob })}
            />
          </span>
        );
      })}
    </>
  );
}
