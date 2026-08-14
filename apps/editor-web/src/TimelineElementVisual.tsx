import {
  AudioIcon,
  AutoCaptionIcon,
  CubeIcon,
  EffectsUiIcon,
  FilterIcon,
  LayersIcon,
  SlidersIcon,
  TextTabIcon,
  TimelineVideoTrackIcon,
  WorkflowPathIcon,
} from './icons.js';
import type { TimelineElementKind } from './timeline-element-kind.js';

function hashUnit(seed: string, salt: number): number {
  let hash = (salt + 1) * 0x9e3779b9;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

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
      return <TimelineVideoTrackIcon />;
  }
}

function Filmstrip({ seed, widthPx }: { readonly seed: string; readonly widthPx: number }) {
  return (
    <span className="timeline-clip-filmstrip" aria-hidden="true">
      {Array.from({ length: filmstripCellCount(widthPx) }, (_, index) => (
        <span
          key={index}
          className="timeline-clip-cell"
          style={{ opacity: 0.52 + hashUnit(seed, index) * 0.42 }}
        />
      ))}
    </span>
  );
}

function Waveform({
  seed,
  widthPx,
  pixelsPerSecond,
  compact = false,
}: {
  readonly seed: string;
  readonly widthPx: number;
  readonly pixelsPerSecond: number;
  readonly compact?: boolean;
}) {
  const count = waveformBarCount(widthPx, pixelsPerSecond);
  return (
    <span className={`timeline-clip-waveform${compact ? ' is-compact' : ''}`} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => {
        const amplitude = hashUnit(seed, index);
        const beat = index % 8 === 0 ? 0.22 : index % 4 === 0 ? 0.1 : 0;
        const level = Math.min(1, 0.28 + amplitude * 0.62 + beat);
        const tone = level > 0.78 ? 'is-peak' : level > 0.48 ? '' : 'is-mid';
        return (
          <span
            key={index}
            className={`timeline-clip-wave-bar ${tone}`.trim()}
            style={{ height: `${Math.round(level * 100)}%` }}
          />
        );
      })}
    </span>
  );
}

/** Shared clip interior used by Classic Timeline and Dual Lens Time View. */
export function TimelineElementMedia({
  kind,
  seed,
  widthPx,
  pixelsPerSecond,
}: {
  readonly kind: TimelineElementKind;
  readonly seed: string;
  readonly widthPx: number;
  readonly pixelsPerSecond: number;
}) {
  if (kind === 'audio') {
    return <Waveform seed={seed} widthPx={widthPx} pixelsPerSecond={pixelsPerSecond} />;
  }
  if (kind === 'overlay') {
    return (
      <>
        <Filmstrip seed={seed} widthPx={widthPx} />
        <Waveform
          seed={`${seed}-overlay-audio`}
          widthPx={widthPx}
          pixelsPerSecond={pixelsPerSecond}
          compact
        />
      </>
    );
  }
  if (kind === 'video') return <Filmstrip seed={seed} widthPx={widthPx} />;
  return <span className="timeline-clip-kind-surface" aria-hidden="true" />;
}
