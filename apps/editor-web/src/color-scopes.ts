/**
 * Scope maths for the colour workspace (T-K05).
 *
 * The canvas draws these numbers and the numbers live here, so a patch frame
 * of known colours can be checked without a browser: the waveform, the RGB
 * parade, the vectorscope and the histogram must all report the documented
 * values for pure red, green, blue, white and black.
 */

/** The four scopes the colour panel can show. */
export type ScopeKind = 'waveform' | 'parade' | 'vectorscope' | 'histogram';

/** A frame read back from the monitor, in RGBA order. */
export interface ScopePixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Rec.709 luma weights — the ones the scopes have always used. */
export const SCOPE_LUMA_WEIGHTS = {
  red: 0.2126,
  green: 0.7152,
  blue: 0.0722,
} as const;

/** Scopes sample the picture on a 2px grid so a 4K monitor stays cheap. */
export const SCOPE_SAMPLE_STEP = 2;

/** One sampled pixel, with its channels and luma normalised to 0..1. */
export interface ScopeSample {
  readonly column: number;
  readonly row: number;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly luma: number;
}

export function scopeLuma(red: number, green: number, blue: number): number {
  return (
    SCOPE_LUMA_WEIGHTS.red * red + SCOPE_LUMA_WEIGHTS.green * green + SCOPE_LUMA_WEIGHTS.blue * blue
  );
}

/** Reads the frame on a coarse grid; incomplete trailing pixels are ignored. */
export function sampleScopePixels(
  pixels: ScopePixels,
  step: number = SCOPE_SAMPLE_STEP,
): readonly ScopeSample[] {
  const stride = Math.max(1, Math.floor(step));
  const samples: ScopeSample[] = [];
  for (let row = 0; row < pixels.height; row += stride) {
    for (let column = 0; column < pixels.width; column += stride) {
      const offset = (row * pixels.width + column) * 4;
      if (offset + 2 >= pixels.data.length) break;
      const red = pixels.data[offset]! / 255;
      const green = pixels.data[offset + 1]! / 255;
      const blue = pixels.data[offset + 2]! / 255;
      samples.push({
        column,
        row,
        red,
        green,
        blue,
        luma: scopeLuma(red, green, blue),
      });
    }
  }
  return samples;
}

/** One column of the plot: where it sits and the levels it spans. */
export interface ScopeColumn {
  /** 0..1 across the plot. */
  readonly x: number;
  /** Lowest level in the column, 0..1. */
  readonly low: number;
  /** Highest level in the column, 0..1. */
  readonly high: number;
}

function columnExtent(
  samples: readonly ScopeSample[],
  width: number,
  level: (sample: ScopeSample) => number,
): readonly ScopeColumn[] {
  const extents = new Map<number, { low: number; high: number }>();
  for (const sample of samples) {
    const value = level(sample);
    const existing = extents.get(sample.column);
    if (existing === undefined) {
      extents.set(sample.column, { low: value, high: value });
      continue;
    }
    if (value < existing.low) existing.low = value;
    if (value > existing.high) existing.high = value;
  }
  const denominator = Math.max(1, width - 1);
  return [...extents.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([column, extent]) => ({
      x: column / denominator,
      low: extent.low,
      high: extent.high,
    }));
}

/** The waveform: luma per image column, as a low and a high level. */
export function computeWaveformColumns(
  samples: readonly ScopeSample[],
  width: number,
): readonly ScopeColumn[] {
  return columnExtent(samples, width, (sample) => sample.luma);
}

/** One column of one parade panel: red, green or blue. */
export interface ParadeColumn extends ScopeColumn {
  /** 0 is the red panel, 1 the green panel, 2 the blue panel. */
  readonly panel: 0 | 1 | 2;
}

/**
 * The RGB parade: three panels side by side, each showing one channel across
 * the whole picture. The panel decides the channel, not the picture column.
 */
export function computeParadeColumns(
  samples: readonly ScopeSample[],
  width: number,
): readonly ParadeColumn[] {
  const channels: readonly ((sample: ScopeSample) => number)[] = [
    (sample) => sample.red,
    (sample) => sample.green,
    (sample) => sample.blue,
  ];
  const columns: ParadeColumn[] = [];
  for (const panel of [0, 1, 2] as const) {
    const level = channels[panel]!;
    for (const column of columnExtent(samples, width, level)) {
      columns.push({ ...column, panel });
    }
  }
  return columns;
}

/** A point on the vectorscope, relative to its centre. */
export interface ScopeVector {
  /** -1..1 across the scope. */
  readonly x: number;
  /** -1..1 down the scope. */
  readonly y: number;
}

/**
 * Chroma radius that counts as 100 % on the vectorscope: the magenta and green
 * primaries are the furthest from neutral in this projection.
 */
export const VECTORSCOPE_FULL_SCALE = 0.7152 * Math.SQRT2;

/**
 * The vectorscope plots chroma, not brightness: neutral colours sit in the
 * centre and saturated colours sit further out. X follows red against luma and
 * Y follows blue against luma, so white, black and every grey land in the
 * centre.
 */
export function vectorscopeOffset(red: number, green: number, blue: number): ScopeVector {
  const luma = scopeLuma(red, green, blue);
  return {
    x: (red - luma) / VECTORSCOPE_FULL_SCALE,
    y: (blue - luma) / VECTORSCOPE_FULL_SCALE,
  };
}

export function computeVectorscopePoints(samples: readonly ScopeSample[]): readonly ScopeVector[] {
  return samples.map((sample) => vectorscopeOffset(sample.red, sample.green, sample.blue));
}

/** A hue mark: a named primary and where it plots. */
export interface HueMark {
  readonly label: string;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/** The six marks the vectorscope labels, in hue order. */
export const VECTORSCOPE_HUE_MARKS: readonly HueMark[] = [
  { label: 'R', red: 1, green: 0, blue: 0 },
  { label: 'Yl', red: 1, green: 1, blue: 0 },
  { label: 'G', red: 0, green: 1, blue: 0 },
  { label: 'Cy', red: 0, green: 1, blue: 1 },
  { label: 'B', red: 0, green: 0, blue: 1 },
  { label: 'Mg', red: 1, green: 0, blue: 1 },
];

/** The histogram: how many pixels land in each luma bin. */
export function computeHistogram(samples: readonly ScopeSample[], bins = 64): readonly number[] {
  const count = Math.max(1, Math.floor(bins));
  const counts = new Array<number>(count).fill(0);
  for (const sample of samples) {
    const index = Math.min(count - 1, Math.max(0, Math.round(sample.luma * (count - 1))));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

/** What the two axes of a scope mean. */
export interface ScopeAxis {
  readonly horizontal: string;
  readonly vertical: string;
}

export function scopeAxisLabels(scope: ScopeKind): ScopeAxis {
  switch (scope) {
    case 'waveform':
      return {
        horizontal: 'image columns',
        vertical: 'level, 0 to 100 per cent',
      };
    case 'parade':
      return {
        horizontal: 'image columns, red, green and blue panels',
        vertical: 'level, 0 to 100 per cent',
      };
    case 'vectorscope':
      return {
        horizontal: 'hue marks: red, yellow, green, cyan, blue, magenta',
        vertical: 'saturation, 0 to 100 per cent',
      };
    case 'histogram':
      return {
        horizontal: 'luminance, 0 to 100 per cent',
        vertical: 'relative pixel count',
      };
  }
}

/** The name a scope is known by in the interface. */
export function scopeLabel(scope: ScopeKind): string {
  return scope === 'parade' ? 'RGB Parade' : `${scope[0]!.toUpperCase()}${scope.slice(1)}`;
}
