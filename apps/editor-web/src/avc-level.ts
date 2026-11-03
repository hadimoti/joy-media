/**
 * H.264 level selection for the offline MP4 export.
 *
 * WebCodecs wants a full codec string (`avc1.PPCCLL`) whose level has to cover the frame size,
 * the frame rate and the bitrate, otherwise the encoder refuses the configuration. The limits below
 * are the ones from the H.264 specification (Table A-1), expressed in macroblocks (16x16 pixels)
 * and bits per second.
 */

/** The limits one H.264 level puts on a video stream. */
interface AvcLevelLimits {
  /** The `level_idc` value of the level. */
  readonly levelIdc: number;
  /** Maximum macroblocks per second the level allows. */
  readonly maxMacroblocksPerSecond: number;
  /** Maximum macroblocks per frame the level allows. */
  readonly maxFrameSizeInMacroblocks: number;
  /** Maximum bit rate in kbit/s for the Baseline, Constrained Baseline and Main profiles. */
  readonly maxBitrateKbps: number;
}

/** Every level the export may pick, in increasing order. */
const AVC_LEVELS: readonly AvcLevelLimits[] = [
  {
    levelIdc: 10,
    maxMacroblocksPerSecond: 1485,
    maxFrameSizeInMacroblocks: 99,
    maxBitrateKbps: 64,
  },
  {
    levelIdc: 11,
    maxMacroblocksPerSecond: 3000,
    maxFrameSizeInMacroblocks: 396,
    maxBitrateKbps: 192,
  },
  {
    levelIdc: 12,
    maxMacroblocksPerSecond: 6000,
    maxFrameSizeInMacroblocks: 396,
    maxBitrateKbps: 384,
  },
  {
    levelIdc: 13,
    maxMacroblocksPerSecond: 11880,
    maxFrameSizeInMacroblocks: 396,
    maxBitrateKbps: 768,
  },
  {
    levelIdc: 20,
    maxMacroblocksPerSecond: 11880,
    maxFrameSizeInMacroblocks: 396,
    maxBitrateKbps: 2000,
  },
  {
    levelIdc: 21,
    maxMacroblocksPerSecond: 19800,
    maxFrameSizeInMacroblocks: 792,
    maxBitrateKbps: 4000,
  },
  {
    levelIdc: 22,
    maxMacroblocksPerSecond: 20250,
    maxFrameSizeInMacroblocks: 1620,
    maxBitrateKbps: 4000,
  },
  {
    levelIdc: 30,
    maxMacroblocksPerSecond: 40500,
    maxFrameSizeInMacroblocks: 1620,
    maxBitrateKbps: 10000,
  },
  {
    levelIdc: 31,
    maxMacroblocksPerSecond: 108000,
    maxFrameSizeInMacroblocks: 3600,
    maxBitrateKbps: 14000,
  },
  {
    levelIdc: 32,
    maxMacroblocksPerSecond: 216000,
    maxFrameSizeInMacroblocks: 5120,
    maxBitrateKbps: 20000,
  },
  {
    levelIdc: 40,
    maxMacroblocksPerSecond: 245760,
    maxFrameSizeInMacroblocks: 8192,
    maxBitrateKbps: 20000,
  },
  {
    levelIdc: 41,
    maxMacroblocksPerSecond: 245760,
    maxFrameSizeInMacroblocks: 8192,
    maxBitrateKbps: 50000,
  },
  {
    levelIdc: 42,
    maxMacroblocksPerSecond: 522240,
    maxFrameSizeInMacroblocks: 8704,
    maxBitrateKbps: 50000,
  },
  {
    levelIdc: 50,
    maxMacroblocksPerSecond: 589824,
    maxFrameSizeInMacroblocks: 22080,
    maxBitrateKbps: 135000,
  },
  {
    levelIdc: 51,
    maxMacroblocksPerSecond: 983040,
    maxFrameSizeInMacroblocks: 36864,
    maxBitrateKbps: 240000,
  },
  {
    levelIdc: 52,
    maxMacroblocksPerSecond: 2073600,
    maxFrameSizeInMacroblocks: 36864,
    maxBitrateKbps: 240000,
  },
];

/** A macroblock is 16x16 pixels. */
const MACROBLOCK_SIZE = 16;

/** The highest level of the table, used when no level covers the requested format. */
const FALLBACK_LEVEL_IDC = 52;

/** The High profile allows 1.25 times the bit rate of the other profiles at the same level. */
const HIGH_PROFILE_BITRATE_FACTOR = 1.25;

/** The H.264 profiles the export may ask the encoder for. */
export type AvcProfile = 'high' | 'main' | 'constrainedBaseline';

/** The profile bytes (`profile_idc` + `constraint_set` flags) of each profile. */
const AVC_PROFILE_IDENTIFIERS: Record<AvcProfile, string> = {
  high: '6400',
  main: '4D00',
  constrainedBaseline: '42E0',
};

/**
 * Picks the H.264 levels that can carry `width` x `height` at `frameRate`, and `bitrate` when one
 * is given, for the given profile.
 *
 * The first entry is the lowest level that fits; the two entries after it are fallbacks for
 * encoders that refuse that exact level. Returns `[52]` when even the highest level cannot carry
 * the format, so callers always get a usable codec string.
 */
export function selectAvcLevels(
  width: number,
  height: number,
  frameRate: number,
  bitrate?: number,
  profile: AvcProfile = 'high',
): readonly number[] {
  if (!isPositiveFinite(width) || !isPositiveFinite(height) || !isPositiveFinite(frameRate))
    return [FALLBACK_LEVEL_IDC];
  const bitrateToCover = bitrate !== undefined && isPositiveFinite(bitrate) ? bitrate : undefined;
  const widthInMacroblocks = Math.ceil(width / MACROBLOCK_SIZE);
  const heightInMacroblocks = Math.ceil(height / MACROBLOCK_SIZE);
  const frameSizeInMacroblocks = widthInMacroblocks * heightInMacroblocks;
  const firstFitting = AVC_LEVELS.findIndex((level) =>
    levelCovers(
      level,
      widthInMacroblocks,
      heightInMacroblocks,
      frameSizeInMacroblocks,
      frameRate,
      bitrateToCover,
      profile,
    ),
  );
  if (firstFitting < 0) return [FALLBACK_LEVEL_IDC];
  return AVC_LEVELS.slice(firstFitting, firstFitting + 3).map((level) => level.levelIdc);
}

/** Whether the stream fits into the frame size, frame rate and bit rate limits of one level. */
function levelCovers(
  level: AvcLevelLimits,
  widthInMacroblocks: number,
  heightInMacroblocks: number,
  frameSizeInMacroblocks: number,
  frameRate: number,
  bitrate: number | undefined,
  profile: AvcProfile,
): boolean {
  if (frameSizeInMacroblocks > level.maxFrameSizeInMacroblocks) return false;
  // A level also caps how wide or tall a single frame may be.
  const maxSideInMacroblocks = Math.sqrt(level.maxFrameSizeInMacroblocks * 8);
  if (widthInMacroblocks > maxSideInMacroblocks) return false;
  if (heightInMacroblocks > maxSideInMacroblocks) return false;
  if (frameSizeInMacroblocks * frameRate > level.maxMacroblocksPerSecond) return false;
  return bitrate === undefined || bitrate <= maxBitsPerSecond(level, profile);
}

/** The most bits per second one level allows for one profile. */
function maxBitsPerSecond(level: AvcLevelLimits, profile: AvcProfile): number {
  const factor = profile === 'high' ? HIGH_PROFILE_BITRATE_FACTOR : 1;
  return level.maxBitrateKbps * 1000 * factor;
}

/**
 * Builds the WebCodecs codec string (`avc1.PPCCLL`) for a profile and a `level_idc`.
 */
export function avcCodecString(profile: AvcProfile, level: number): string {
  const levelHex = level.toString(16).toUpperCase().padStart(2, '0');
  return `avc1.${AVC_PROFILE_IDENTIFIERS[profile]}${levelHex}`;
}

/** Whether the value is a usable positive, finite number. */
function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
