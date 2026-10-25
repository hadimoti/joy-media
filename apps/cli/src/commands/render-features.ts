/* global process */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadNotoSansArabicLibassFaces } from '@joy-media/html-scene-runtime';
import {
  CAPTION_FACE_UNUSABLE_REASON,
  judgeCaptionProbe,
  prepareCaptionProbe,
} from '../services/caption-face-pixels.js';
import { ffmpegBinary, ffprobeBinary } from '../utils/media-probe.js';

// ---------------------------------------------------------------------------
// Renderer refusal fragments (shared verbatim with render-media.ts)
// ---------------------------------------------------------------------------

export const RF_VISUAL_OBJECTS = 'visual objects, transforms, and effects';
export const RF_PROPERTY_ANIMATIONS = 'property animations';
export const RF_CLIP_COLOR_GRADES = 'clip color grades';
export const RF_COLOR_GRADING = 'color grading';
export const RF_AUDIO_EFFECTS = 'audio effects';
export const RF_AUDIO_BUS_ROUTING = 'audio bus routing';
export const RF_AUDIO_BUS_GAIN = 'audio bus gain';
export const RF_AUDIO_BUS_PAN = 'audio bus pan';
export const RF_AUDIO_BUS_MUTE = 'audio bus mute';
export const RF_AUDIO_BUS_SOLO = 'audio bus solo';
export const RF_AUDIO_PAN = 'audio pan on clip';
export const RF_AUDIO_SOLO = 'audio solo on clip';
export const RF_PROCESSED_AUDIO = 'processed audio source on clip';
export const RF_TRACK_MUTE_SOLO = 'uses mute or solo, which the CLI renderer does not support';
export const RF_ALPHA = 'uses alpha-bearing media';
export const RF_PLAYBACK_RATE = 'playback rate';
export const RF_REVERSE_TIME_REMAP = 'reverse / time remap';
export const RF_NOT_VIDEO_CLIP = 'the CLI renderer only supports video clips';
export const RF_TRANSITION_TYPE = 'only dissolve is rendered';
export const RF_CAPTION_STYLE = 'has its own style, which the CLI renderer does not draw yet';
export const RF_CAPTION_STYLE_OR_ANIMATION =
  'uses a caption style or animation, which the CLI renderer does not draw';
export const RF_CAPTION_RTL = 'is right-to-left, which the CLI renderer does not draw yet';
export const RF_DISSOLVE_HANDLE = 'for its dissolve, and its source';
export const RF_AUDIO_GAIN_RANGE = 'must be a number from 0 to';
export const RF_AUDIO_FADE_RANGE = 'must be zero or more microseconds';

// ---------------------------------------------------------------------------
// Stable feature IDs
// ---------------------------------------------------------------------------

export const FEATURE_IDS = [
  'render.real-media',
  'render.frame-rate.ntsc-and-fraction',
  'render.alpha-media',
  'render.playback-rate',
  'render.freeze-frame',
  'render.reverse',
  'render.time-remap',
  'render.nested-composition',
  'render.visual-objects',
  'render.property-animations',
  'render.color-grade',
  'render.audio-effects',
  'render.audio-bus-routing',
  'render.audio-bus-settings',
  'render.audio-pan',
  'render.audio-solo',
  'render.track-mute-solo',
  'render.audio-processed-source',
  'captions.drawtext',
  'captions.ass-basic',
  'captions.styling',
  'captions.rtl',
  'transitions.dissolve',
  'transitions.other',
  'audio.gain',
  'audio.fades',
  'audio.mute',
  'render.template-alpha',
] as const satisfies readonly string[];

export type FeatureId = (typeof FEATURE_IDS)[number];

export const REASON_CAPTION_FONT_MISSING =
  'Captions need a font file, and none was found. Set JOY_MEDIA_CAPTION_FONT to a .ttf or .otf file.';
export const REASON_RTL_CAPTION_FONT_MISSING =
  'RTL captions require the canonical Noto Sans Arabic Arabic 400 face and fail closed when FFmpeg libass cannot load or select it.';
export const REASON_CANONICAL_CAPTION_FACE_UNAVAILABLE =
  'FFmpeg libass cannot load or select the canonical Noto Sans Arabic Arabic 400 WOFF2 face; captions require this face and fail closed.';

// ---------------------------------------------------------------------------
// Feature descriptor
// ---------------------------------------------------------------------------

export type FeatureStatus = 'available' | 'setup-required' | 'unsupported' | 'unknown';

export interface FeatureEntry {
  readonly id: FeatureId;
  readonly area: string;
  readonly status: FeatureStatus;
  readonly reason: string;
  readonly refusal: readonly string[];
}

export interface FeatureProbes {
  readonly ffmpeg: boolean;
  readonly ffprobe: boolean;
  readonly captionFont: boolean;
  readonly libass?: boolean;
  readonly canonicalCaptionFace?: 'loadable' | 'unavailable' | 'unknown';
  readonly chromium?: boolean;
  readonly chromiumReason?: string;
  readonly titleFont?: boolean;
}

export interface WorkflowEntry {
  readonly id: 'design.title-video.v1';
  readonly status: 'available' | 'setup-required';
  readonly reason: string;
  readonly renderer: 'chromium-scene-surface';
  readonly templates: readonly ['joy.p0.lower-third', 'joy.p0.title'];
  readonly units: { readonly time: 'us'; readonly position: 'px' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function binaryAvailable(name: string): boolean {
  const result = spawnSync(name, ['-version'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return result.status === 0 && !result.error;
}

/** Caption font search shared with render-media.ts. */
export function captionFontFile(): string | null {
  const override = process.env['JOY_MEDIA_CAPTION_FONT']?.trim();
  if (override) return isTrueTypeOrOpenType(override) && existsSync(override) ? override : null;
  const candidates =
    process.platform === 'win32'
      ? [join(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts', 'arial.ttf')]
      : process.platform === 'darwin'
        ? ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf']
        : [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/TTF/DejaVuSans.ttf',
          ];
  return candidates.find((path) => existsSync(path) && isTrueTypeOrOpenType(path)) ?? null;
}

function isTrueTypeOrOpenType(path: string): boolean {
  return ['.ttf', '.otf'].includes(extname(path).toLowerCase());
}

export function captionFontFamily(fontPath: string): string {
  return basename(fontPath, extname(fontPath));
}

export function probeLibass(): boolean {
  const binary = ffmpegBinary();
  const build = spawnSync(binary, ['-buildconf'], { encoding: 'utf8', timeout: 5000 });
  const filters = spawnSync(binary, ['-filters'], { encoding: 'utf8', timeout: 5000 });
  if (build.status !== 0 || filters.status !== 0 || build.error || filters.error) return false;
  return (
    /--enable-libass\b/.test(build.stdout + build.stderr) &&
    /\bass\s/.test(filters.stdout) &&
    /\bsubtitles\s/.test(filters.stdout)
  );
}

export function probeChromium(): Promise<boolean> {
  return probeChromiumStatus().then((result) => result.launchable);
}

let lastChromiumProbeReason: string | undefined;
const chromiumProbeStatuses = new Map<
  string,
  Promise<{ readonly launchable: boolean; readonly reason?: string }>
>();

async function probeChromiumStatus(): Promise<{
  readonly launchable: boolean;
  readonly reason?: string;
}> {
  const runtime = await import('@joy-media/html-scene-runtime');
  const executable = runtime.findChromiumExecutable();
  if (executable === undefined) {
    lastChromiumProbeReason = 'Chromium executable was not found.';
    return { launchable: false, reason: lastChromiumProbeReason };
  }
  let identity: string;
  try {
    const info = statSync(executable);
    identity = `${executable}\0${info.size}\0${info.mtimeMs}`;
  } catch (error) {
    lastChromiumProbeReason = `Chromium executable could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
    return { launchable: false, reason: lastChromiumProbeReason };
  }
  const cached = chromiumProbeStatuses.get(identity);
  if (cached) return cached;
  const status = (async () => {
    let probeResult: { readonly version: string } | { readonly reason: string } | undefined;
    const launchable = await hasUsableChromium(executable, async (path) => {
      probeResult = await runtime.probeChromium({ executablePath: path });
      return probeResult;
    });
    if (probeResult && 'reason' in probeResult) lastChromiumProbeReason = probeResult.reason;
    return {
      launchable,
      ...(!launchable
        ? { reason: lastChromiumProbeReason ?? 'Chromium could not be launched.' }
        : {}),
    };
  })().catch((error) => {
    lastChromiumProbeReason = `Chromium could not be launched: ${error instanceof Error ? error.message : String(error)}`;
    return { launchable: false, reason: lastChromiumProbeReason };
  });
  chromiumProbeStatuses.set(identity, status);
  return status;
}

export function hasUsableChromium(
  executable: string | undefined,
  probeChromium: (
    path: string,
  ) => Promise<{ readonly version: string } | { readonly reason: string }>,
): Promise<boolean>;
export function hasUsableChromium(
  executable: string | undefined,
  readVersion: (path: string) => string,
): boolean;
export function hasUsableChromium(
  executable: string | undefined,
  probeChromium:
    | ((path: string) => string)
    | ((path: string) => Promise<{ readonly version: string } | { readonly reason: string }>),
): boolean | Promise<boolean> {
  if (executable === undefined) return false;
  const result = probeChromium(executable);
  if (typeof result === 'string') return result.trim().length > 0;
  return result.then((probe) => {
    if ('reason' in probe) lastChromiumProbeReason = probe.reason;
    return 'version' in probe && probe.version.trim().length > 0;
  });
}

/**
 * Checks whether this FFmpeg/libass build draws the canonical caption face. That is the bundled
 * TrueType companion: libass cannot open the WOFF2 file, so the WOFF2 is not what is checked.
 */
export async function probeCanonicalCaptionFaceStatus(
  libassAvailable = probeLibass(),
): Promise<'loadable' | 'unavailable' | 'unknown'> {
  if (!libassAvailable) return 'unknown';
  return probeCanonicalCaptionFace().usable ? 'loadable' : 'unavailable';
}

export interface CanonicalCaptionFaceProbe {
  readonly usable: boolean;
  readonly executablePath: string;
  readonly canonicalFace: 'Noto Sans Arabic Arabic 400';
  readonly reason?: string;
  readonly log: string;
  readonly libassVersion?: string;
  readonly shaperVersion?: string;
  readonly versionSource?: 'canonical-caption-face-ass-probe';
}

/**
 * The libass build named in the FFmpeg log. Some builds print a version number, others only a
 * meson source commit or the API version. The first form that matches is kept verbatim.
 */
function libassVersionFromLog(log: string): string | undefined {
  const numbered =
    /\blibass\s+(?:source|version)\s*:\s*([0-9][\w.-]*)/i.exec(log)?.[1] ??
    /\blibass\s+([0-9]+(?:\.[0-9]+)+)\b/i.exec(log)?.[1];
  if (numbered !== undefined) return numbered;
  const meson = /\blibass\s+source\s*:\s*meson,\s*commit\s*:\s*([0-9a-f]{7,40})\b/i.exec(log)?.[1];
  if (meson !== undefined) return `meson commit ${meson}`;
  const api = /\blibass\s+API\s+version\s*:\s*(0x[0-9a-f]+)/i.exec(log)?.[1];
  return api === undefined ? undefined : `API ${api}`;
}

export function captionEngineVersionsFromAssProbe(log: string): {
  readonly libassVersion: string;
  readonly shaperVersion: string;
  readonly versionSource: 'canonical-caption-face-ass-probe';
} {
  const libassVersion = libassVersionFromLog(log);
  const shaperVersion =
    /\bHarfBuzz(?:-ng)?(?:\s+version)?\s*[: ]+\s*v?([0-9]+(?:\.[0-9]+)+)\b/i.exec(log)?.[1];
  return {
    libassVersion: libassVersion ?? 'unavailable',
    shaperVersion: shaperVersion ?? 'unavailable',
    versionSource: 'canonical-caption-face-ass-probe',
  };
}

const canonicalCaptionProbeCache = new Map<string, CanonicalCaptionFaceProbe>();

/** Proves that FFmpeg/libass selects the bundled canonical Arabic 400 face. */
export function probeCanonicalCaptionFace(
  executablePath = ffmpegBinary(),
): CanonicalCaptionFaceProbe {
  const cached = canonicalCaptionProbeCache.get(executablePath);
  if (cached) return cached;
  const unavailable = (reason: string): CanonicalCaptionFaceProbe => {
    const result: CanonicalCaptionFaceProbe = {
      usable: false,
      executablePath,
      canonicalFace: 'Noto Sans Arabic Arabic 400',
      reason,
      log: '',
      ...captionEngineVersionsFromAssProbe(''),
    };
    canonicalCaptionProbeCache.set(executablePath, result);
    return result;
  };
  let face: ReturnType<typeof loadNotoSansArabicLibassFaces>[number] | undefined;
  try {
    face = loadNotoSansArabicLibassFaces().find(
      (item) => item.subset === 'arabic' && item.weight === 400,
    );
  } catch (error) {
    return unavailable(
      `Canonical Noto Sans Arabic Arabic 400 face could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!face) return unavailable('The canonical Noto Sans Arabic Arabic 400 face is missing.');
  const fontFile = 'noto-sans-arabic-arabic-400-normal.ttf';
  const directory = mkdtempSync(join(tmpdir(), 'joy-caption-canonical-'));
  try {
    const commands = prepareCaptionProbe(directory, fontFile, face.bytes);
    const runOptions = { cwd: directory, encoding: 'utf8', timeout: 15000 } as const;
    const canonical = spawnSync(executablePath, [...commands.canonical], runOptions);
    const missing = spawnSync(executablePath, [...commands.missing], runOptions);
    const judged = judgeCaptionProbe({
      directory,
      fontFile,
      canonical: { status: canonical.status, log: `${canonical.stdout}\n${canonical.stderr}` },
      missing: { status: missing.status },
    });
    const probe: CanonicalCaptionFaceProbe = {
      usable: judged.usable,
      executablePath,
      canonicalFace: 'Noto Sans Arabic Arabic 400',
      ...(!judged.usable ? { reason: CAPTION_FACE_UNUSABLE_REASON } : {}),
      log: judged.log,
      ...captionEngineVersionsFromAssProbe(judged.log),
    };
    canonicalCaptionProbeCache.set(executablePath, probe);
    return probe;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The static catalog: what the product supports, before this machine is probed. */
export function baseFeatureList(): FeatureEntry[] {
  return [
    {
      id: 'render.real-media',
      area: 'render',
      status: 'available',
      reason: 'Ordinary video, still images, and audio clips on enabled tracks.',
      refusal: [],
    },
    {
      id: 'render.frame-rate.ntsc-and-fraction',
      area: 'frame-rate',
      status: 'available',
      reason:
        'NTSC rates (23.976, 29.97, 59.94) and exact fractions (e.g. 30000/1001) are supported.',
      refusal: [],
    },
    {
      id: 'render.alpha-media',
      area: 'render',
      status: 'unsupported',
      reason: 'Clips with alpha-bearing media are refused.',
      refusal: [RF_ALPHA],
    },
    {
      id: 'render.playback-rate',
      area: 'render',
      status: 'unsupported',
      reason: 'Clips with playback-rate changes are refused.',
      refusal: [RF_PLAYBACK_RATE],
    },
    {
      id: 'render.freeze-frame',
      area: 'render',
      status: 'unsupported',
      reason:
        'The CLI project format has no freeze-frame model; any playback-rate change, including zero, is refused.',
      refusal: [RF_PLAYBACK_RATE],
    },
    {
      id: 'render.reverse',
      area: 'render',
      status: 'unsupported',
      reason: 'Clips with reverse playback are refused.',
      refusal: [RF_REVERSE_TIME_REMAP],
    },
    {
      id: 'render.time-remap',
      area: 'render',
      status: 'unsupported',
      reason: 'Clips with time remapping are refused.',
      refusal: [RF_REVERSE_TIME_REMAP],
    },
    {
      id: 'render.nested-composition',
      area: 'render',
      status: 'unsupported',
      reason: 'Nested compositions are refused as non-video clips.',
      refusal: [RF_NOT_VIDEO_CLIP],
    },
    {
      id: 'render.visual-objects',
      area: 'render',
      status: 'unsupported',
      reason: RF_VISUAL_OBJECTS,
      refusal: [RF_VISUAL_OBJECTS],
    },
    {
      id: 'render.property-animations',
      area: 'render',
      status: 'unsupported',
      reason: RF_PROPERTY_ANIMATIONS,
      refusal: [RF_PROPERTY_ANIMATIONS],
    },
    {
      id: 'render.color-grade',
      area: 'render',
      status: 'unsupported',
      reason: 'Color grading and clip color grades are refused.',
      refusal: [RF_COLOR_GRADING, RF_CLIP_COLOR_GRADES],
    },
    {
      id: 'render.audio-effects',
      area: 'audio',
      status: 'unsupported',
      reason: RF_AUDIO_EFFECTS,
      refusal: [RF_AUDIO_EFFECTS],
    },
    {
      id: 'render.audio-bus-routing',
      area: 'audio',
      status: 'unsupported',
      reason: RF_AUDIO_BUS_ROUTING,
      refusal: [RF_AUDIO_BUS_ROUTING],
    },
    {
      id: 'render.audio-bus-settings',
      area: 'audio',
      status: 'unsupported',
      reason:
        'Audio bus gain, pan, mute and solo are not supported by the CLI renderer; only the default bus is rendered.',
      refusal: [RF_AUDIO_BUS_GAIN, RF_AUDIO_BUS_PAN, RF_AUDIO_BUS_MUTE, RF_AUDIO_BUS_SOLO],
    },
    {
      id: 'render.audio-pan',
      area: 'audio',
      status: 'unsupported',
      reason: RF_AUDIO_PAN,
      refusal: [RF_AUDIO_PAN],
    },
    {
      id: 'render.audio-solo',
      area: 'audio',
      status: 'unsupported',
      reason: RF_AUDIO_SOLO,
      refusal: [RF_AUDIO_SOLO],
    },
    {
      id: 'render.track-mute-solo',
      area: 'render',
      status: 'unsupported',
      reason: RF_TRACK_MUTE_SOLO,
      refusal: [RF_TRACK_MUTE_SOLO],
    },
    {
      id: 'render.audio-processed-source',
      area: 'audio',
      status: 'unsupported',
      reason: RF_PROCESSED_AUDIO,
      refusal: [RF_PROCESSED_AUDIO],
    },
    {
      id: 'captions.drawtext',
      area: 'captions',
      status: 'available',
      reason: 'Captions render with ffmpeg drawtext when a caption font is available.',
      refusal: [],
    },
    {
      id: 'captions.ass-basic',
      area: 'captions',
      status: 'available',
      reason:
        'Basic captions render through FFmpeg libass when libass and a TrueType or OpenType caption face are available.',
      refusal: [],
    },
    {
      id: 'captions.styling',
      area: 'captions',
      status: 'unsupported',
      reason: 'Caption clips with their own style or a referenced style or animation are refused.',
      refusal: [RF_CAPTION_STYLE, RF_CAPTION_STYLE_OR_ANIMATION],
    },
    {
      id: 'captions.rtl',
      area: 'captions',
      status: 'available',
      reason:
        'Right-to-left captions are shaped by libass when libass and a supported caption face are available.',
      refusal: [],
    },
    {
      id: 'transitions.dissolve',
      area: 'transitions',
      status: 'available',
      reason:
        "Dissolves render between touching clips when each clip has handle media beyond its edge; otherwise the render refuses with a message containing 'for its dissolve, and its source'.",
      refusal: [],
    },
    {
      id: 'transitions.other',
      area: 'transitions',
      status: 'unsupported',
      reason: RF_TRANSITION_TYPE,
      refusal: [RF_TRANSITION_TYPE],
    },
    {
      id: 'audio.gain',
      area: 'audio',
      status: 'available',
      reason: 'Clip gain must be a number from 0 to 4 (0 to +12 dB); other values are refused.',
      refusal: [],
    },
    {
      id: 'audio.fades',
      area: 'audio',
      status: 'available',
      reason: 'Fade-in and fade-out must be zero or more microseconds; other values are refused.',
      refusal: [],
    },
    {
      id: 'audio.mute',
      area: 'audio',
      status: 'available',
      reason: 'Clip mute is rendered.',
      refusal: [],
    },
    {
      id: 'render.template-alpha',
      area: 'render',
      status: 'available',
      reason:
        'Template title layers render with alpha through Chromium when Chromium is available.',
      refusal: [],
    },
  ];
}

/** Apply environment probes without mutating the feature descriptors. */
export function applyProbes(
  features: readonly FeatureEntry[],
  probes: FeatureProbes,
): FeatureEntry[] {
  const missing: string[] = [];
  if (!probes.ffmpeg) missing.push('ffmpeg');
  if (!probes.ffprobe) missing.push('ffprobe');
  const missingReason = missing
    .map(
      (binary) =>
        `${binary} is not found; install it or set JOY_MEDIA_${binary.toUpperCase()} (see the render requirements)`,
    )
    .join('; ');
  return features.map((feature) => {
    if (feature.status !== 'available') return { ...feature };
    if (feature.id === 'captions.drawtext' && !probes.captionFont) {
      const reason =
        missing.length > 0
          ? `${missingReason}; ${REASON_CAPTION_FONT_MISSING}`
          : REASON_CAPTION_FONT_MISSING;
      return { ...feature, status: 'setup-required', reason };
    }
    if (
      feature.id === 'captions.ass-basic' &&
      (probes.libass === false || probes.canonicalCaptionFace !== 'loadable')
    ) {
      const prerequisiteReason =
        probes.libass === false
          ? 'FFmpeg libass is unavailable.'
          : REASON_CANONICAL_CAPTION_FACE_UNAVAILABLE;
      const reason =
        missing.length > 0 ? `${missingReason}; ${prerequisiteReason}` : prerequisiteReason;
      return { ...feature, status: 'setup-required', reason };
    }
    if (
      feature.id === 'captions.rtl' &&
      (probes.libass === false || probes.canonicalCaptionFace !== 'loadable')
    ) {
      return {
        ...feature,
        status: 'setup-required',
        reason:
          missing.length > 0
            ? `${missingReason}; ${REASON_RTL_CAPTION_FONT_MISSING}`
            : REASON_RTL_CAPTION_FONT_MISSING,
      };
    }
    if (feature.id === 'render.template-alpha' && probes.chromium === false) {
      return {
        ...feature,
        status: 'setup-required',
        reason: probes.chromiumReason ?? 'Chromium is not available.',
      };
    }
    if (missing.length > 0) {
      return { ...feature, status: 'setup-required', reason: missingReason };
    }
    return { ...feature };
  });
}

/** Build the catalog using the real machine probes. */
export async function buildFeatureList(
  overrides?: Partial<FeatureProbes>,
): Promise<FeatureEntry[]> {
  const libass = overrides?.libass ?? probeLibass();
  const [chromiumStatus, canonicalCaptionFace] = await Promise.all([
    overrides?.chromium === undefined
      ? probeChromiumStatus()
      : Promise.resolve({
          launchable: overrides.chromium,
          reason: overrides.chromiumReason ?? lastChromiumProbeReason,
        }),
    overrides?.canonicalCaptionFace === undefined
      ? probeCanonicalCaptionFaceStatus(libass)
      : Promise.resolve(overrides.canonicalCaptionFace),
  ]);
  return applyProbes(baseFeatureList(), {
    ffmpeg: binaryAvailable(ffmpegBinary()),
    ffprobe: binaryAvailable(ffprobeBinary()),
    captionFont: captionFontFile() !== null,
    libass,
    canonicalCaptionFace,
    chromium: chromiumStatus.launchable,
    ...(chromiumStatus.reason === undefined ? {} : { chromiumReason: chromiumStatus.reason }),
    titleFont: captionFontFile() !== null,
    ...overrides,
  });
}

export function buildTitleWorkflow(probes: FeatureProbes): WorkflowEntry {
  const missing: string[] = [];
  if (!probes.chromium) missing.push(probes.chromiumReason ?? 'Chromium is not available');
  if (!probes.libass) missing.push('FFmpeg libass is unavailable');
  if (!probes.titleFont) missing.push('title font is not available');
  return {
    id: 'design.title-video.v1',
    status: missing.length === 0 ? 'available' : 'setup-required',
    reason: missing.length === 0 ? 'All required probes passed' : `${missing.join('; ')}.`,
    renderer: 'chromium-scene-surface',
    templates: ['joy.p0.lower-third', 'joy.p0.title'],
    units: { time: 'us', position: 'px' },
  };
}
