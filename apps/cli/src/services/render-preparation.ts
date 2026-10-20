import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, sha256Identity } from './prepared-edit.js';
import {
  loadNotoSansArabicFaces,
  missingCanonicalFontCodePoints,
  type NotoSansArabicFace,
} from '@joy-media/html-scene-runtime';
import { CommandFailure, type CliProjectDocument } from '../utils/project-loader.js';
import { ffmpegBinary } from '../utils/media-probe.js';
import { compileCaptionAss } from './captions-ass.js';
import {
  captionEngineVersionsFromAssProbe,
  type CanonicalCaptionFaceProbe,
} from '../commands/render-features.js';

export const RENDER_PREPARATION_KEY = 'joy.renderPreparation';
export const RENDER_PREPARATION_VERSION = 'RenderPreparationV1';
const SUPPORTED_POLICY_VERSIONS = {
  renderer: '1',
  adapter: '1',
  compiler: '1',
  coverage: '1',
  layout: '1',
  timingPolicy: 'rational-centisecond-v1',
} as const;

export interface RenderPreparationFacts {
  readonly libassProbe: CanonicalCaptionFaceProbe;
  readonly libassAvailable: boolean;
  readonly canonicalFaces: readonly NotoSansArabicFace[];
  readonly chromium: {
    readonly launchable: boolean;
    readonly executablePath: string | null;
    readonly executableSha256: string | null;
    readonly version: string | null;
    readonly reason?: string;
  };
  readonly ffmpeg: {
    readonly executablePath: string;
    readonly executableSha256: string | null;
    readonly version: string;
    readonly buildConfiguration: string;
    readonly requiredFilters: readonly string[];
    readonly libassVersion: string;
    readonly shaperVersion: string;
    readonly versionSource?: 'canonical-caption-face-ass-probe';
  };
  readonly measureText?: (text: string, fontSizePx: number, weight: 400 | 700) => number;
}

export interface RenderPreparationV1 {
  readonly version: typeof RENDER_PREPARATION_VERSION;
  readonly renderers: {
    readonly title: 'chromium-scene-surface' | 'none';
    readonly caption: 'ass-basic' | 'none';
  };
  readonly versions: {
    readonly renderer: string;
    readonly adapter: string;
    readonly compiler: string;
    readonly coverage: string;
    readonly layout: string;
    readonly timingPolicy: string;
  };
  readonly ffmpeg: RenderPreparationFacts['ffmpeg'] & {
    readonly canonicalFaceProbe: CanonicalCaptionFaceProbe;
    readonly versionSource: 'canonical-caption-face-ass-probe';
  };
  readonly chromium: RenderPreparationFacts['chromium'] & {
    readonly locale: string;
    readonly deviceScaleFactor: number;
    readonly captureSettings: { readonly transparent: true; readonly animation: 'frozen' };
  };
  readonly fonts: readonly {
    readonly family: string;
    readonly weight: 400 | 700;
    readonly subset: 'arabic' | 'latin';
    readonly length: number;
    readonly sha256: string;
  }[];
  readonly coverage: {
    readonly result: 'passed';
    readonly checkedTextDigest: string;
    readonly checkedTextLength: number;
    readonly supportedControls: readonly ['newline', 'space', 'ZWNJ', 'ZWJ'];
  };
  readonly composition: {
    readonly width: number;
    readonly height: number;
    readonly fps: { readonly num: number; readonly den: number };
  };
  readonly captions: {
    readonly sourceDigest: string;
    readonly cues: readonly {
      readonly lines: readonly string[];
      readonly startUs: number;
      readonly endUs: number;
      readonly direction: 'ltr' | 'rtl' | 'auto';
      readonly measuredWidthsPx: readonly number[];
      readonly maxWidthPx: number;
    }[];
    readonly fontSizePx: number;
    readonly placement: { readonly alignment: 'bottom-center'; readonly marginBottomPx: number };
    readonly direction: 'ltr' | 'rtl' | 'auto';
    readonly wrapping: 'measured-hard-breaks';
    readonly assDigest: string | null;
  };
  readonly renderInputsDigest: string;
}

type RenderPreparationFactsOptions = {
  title: boolean;
  captions: boolean;
  signal?: AbortSignal;
  chromiumExecutablePath?: string;
  expectedChromiumSha256?: string;
  expectedFFmpegSha256?: string;
};
let factsProvider:
  ((options: RenderPreparationFactsOptions) => Promise<RenderPreparationFacts>) | undefined;
const validatedChromiumSha256 = new Map<string, string>();

export function getValidatedChromiumSha256(executablePath: string): string | undefined {
  return validatedChromiumSha256.get(executablePath);
}

export function pinChromiumExecutableSha256ForTests(
  executablePath: string,
  sha256: string | undefined,
): void {
  if (sha256 === undefined) validatedChromiumSha256.delete(executablePath);
  else validatedChromiumSha256.set(executablePath, sha256);
}

type ChromiumProbe = (
  executablePath: string,
  signal?: AbortSignal,
) => Promise<{ readonly version: string } | { readonly reason: string }>;
let chromiumProbeForTests: ChromiumProbe | undefined;
export function setRenderPreparationChromiumProbeForTests(probe: ChromiumProbe | undefined): void {
  chromiumProbeForTests = probe;
}
export type PreparationCommandResult = { readonly status: number | null; readonly output: string };
export type PreparationCommandRunner = (
  binary: string,
  args: readonly string[],
  options: { readonly signal?: AbortSignal; readonly timeoutMs: number; readonly cwd?: string },
) => Promise<PreparationCommandResult>;
let preparationCommandRunner: PreparationCommandRunner = (binary, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      signal: options.signal,
      timeout: options.timeoutMs,
      windowsHide: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    let output = '';
    let settled = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (output += chunk));
    child.stderr?.on('data', (chunk: string) => (output += chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (status) => {
      if (settled) return;
      settled = true;
      resolve({ status, output });
    });
  });

export function setRenderPreparationCommandRunnerForTests(
  runner: PreparationCommandRunner | undefined,
): void {
  preparationCommandRunner = runner ?? defaultPreparationCommandRunner;
}
const defaultPreparationCommandRunner = preparationCommandRunner;
export function setRenderPreparationFactsProviderForTests(
  provider:
    ((options: RenderPreparationFactsOptions) => Promise<RenderPreparationFacts>) | undefined,
): void {
  factsProvider = provider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function preparationInputDigest(
  project: unknown,
  recordWithoutDigest: Omit<RenderPreparationV1, 'renderInputsDigest'>,
): string {
  return sha256Identity({
    project: renderInputsDigest(project),
    record: recordWithoutDigest,
  });
}

function captionSourceDigest(
  cues: RenderPreparationV1['captions']['cues'],
  fontSizePx: number,
  placement: RenderPreparationV1['captions']['placement'],
  direction: RenderPreparationV1['captions']['direction'],
): string {
  return sha256Identity({
    cues: cues.map(({ lines, startUs, endUs, direction: cueDirection }) => ({
      lines,
      startUs,
      endUs,
      direction: cueDirection,
    })),
    fontSizePx,
    placement,
    direction,
    wrapping: 'measured-hard-breaks',
  });
}

function titleWeights(project: unknown, title: boolean): Array<400 | 700> {
  if (!title) return [];
  const pluginData =
    isRecord(project) && isRecord(project['pluginData']) ? project['pluginData'] : {};
  const templates = isRecord(pluginData['joy.contentTemplates'])
    ? pluginData['joy.contentTemplates']
    : {};
  const instances = isRecord(templates['instances']) ? Object.values(templates['instances']) : [];
  const weights = new Set<400 | 700>();
  for (const instance of instances) {
    if (!isRecord(instance) || !isRecord(instance['font'])) continue;
    const weight = instance['font']['weight'];
    if (weight === 400 || weight === 700) weights.add(weight);
  }
  if (weights.size === 0)
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Title preparation requires a supported font weight in each frozen title instance.',
    );
  return [...weights];
}

async function command(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  try {
    const result = await preparationCommandRunner(binary, args, {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 5_000,
    });
    signal?.throwIfAborted();
    return result.status === 0 ? result.output : '';
  } catch {
    signal?.throwIfAborted();
    return '';
  }
}

function resolveExecutable(binary: string): string {
  try {
    return (
      spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [binary], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      })
        .stdout.split(/\r?\n/, 1)[0]
        ?.trim() || binary
    );
  } catch {
    return binary;
  }
}

async function chromiumFacts(
  signal?: AbortSignal,
  frozenExecutablePath?: string,
  expectedSha256?: string,
): Promise<RenderPreparationFacts['chromium']> {
  try {
    const runtime = (await import('@joy-media/html-scene-runtime')) as {
      findChromiumExecutable(): string | undefined;
      probeChromium(options?: {
        executablePath?: string;
        signal?: AbortSignal;
      }): Promise<{ readonly version: string } | { readonly reason: string }>;
    };
    const configuredExecutablePath = process.env['JOY_CHROMIUM_PATH']?.trim();
    const executablePath =
      frozenExecutablePath ?? configuredExecutablePath ?? runtime.findChromiumExecutable();
    if (!executablePath || !existsSync(executablePath))
      return {
        launchable: false,
        executablePath: executablePath ?? null,
        executableSha256: null,
        version: null,
        reason: executablePath
          ? `Chromium executable was not found at ${executablePath}.`
          : 'Chromium executable was not found.',
      };
    const executableSha256 = hashBytes(await readFile(executablePath));
    if (expectedSha256 !== undefined && executableSha256 !== expectedSha256)
      throw new CommandFailure(
        'RENDER_ENVIRONMENT_DRIFT',
        `Frozen Chromium hash changed before its probe (${JSON.stringify(executablePath)}). Re-prepare the project.`,
      );
    const result = chromiumProbeForTests
      ? await chromiumProbeForTests(executablePath, signal)
      : await runtime.probeChromium({
          executablePath,
          ...(signal === undefined ? {} : { signal }),
        });
    signal?.throwIfAborted();
    const afterProbeSha256 = hashBytes(await readFile(executablePath));
    if (afterProbeSha256 !== executableSha256)
      throw new CommandFailure(
        'RENDER_ENVIRONMENT_DRIFT',
        `Chromium changed while its probe was running (${JSON.stringify(executablePath)}). Re-prepare the project.`,
      );
    if ('reason' in result)
      return {
        launchable: false,
        executablePath,
        executableSha256,
        version: null,
        reason: result.reason,
      };
    const version = result.version.trim();
    if (!version) throw new Error('Chromium did not report a browser version.');
    return {
      launchable: true,
      executablePath,
      executableSha256,
      version,
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof CommandFailure) throw error;
    return {
      launchable: false,
      executablePath: null,
      executableSha256: null,
      version: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readRenderPreparationFacts(options: {
  title: boolean;
  captions: boolean;
  signal?: AbortSignal;
  chromiumExecutablePath?: string;
  expectedChromiumSha256?: string;
  expectedFFmpegSha256?: string;
}): Promise<RenderPreparationFacts> {
  options.signal?.throwIfAborted();
  if (factsProvider) return factsProvider(options);
  const executablePath = resolveExecutable(ffmpegBinary());
  const runBinary = executablePath;
  let ffmpegExecutableSha256: string;
  try {
    ffmpegExecutableSha256 = hashBytes(await readFile(executablePath));
  } catch (error) {
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      `FFmpeg executable could not be hashed before its probe (${JSON.stringify(executablePath)}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    options.expectedFFmpegSha256 !== undefined &&
    ffmpegExecutableSha256 !== options.expectedFFmpegSha256
  )
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      `Frozen FFmpeg hash changed before its probe (${JSON.stringify(executablePath)}). Re-prepare the project.`,
    );
  const [buildConfiguration, filterList, versionOutput, libassProbe] = await Promise.all([
    command(runBinary, ['-buildconf'], options.signal),
    command(runBinary, ['-filters'], options.signal),
    command(runBinary, ['-version'], options.signal),
    canonicalCaptionFaceProbe(executablePath, options.signal),
  ]);
  options.signal?.throwIfAborted();
  if (hashBytes(await readFile(executablePath)) !== ffmpegExecutableSha256)
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      `FFmpeg changed while its probe was running (${JSON.stringify(executablePath)}). Re-prepare the project.`,
    );
  const version = versionOutput.split(/\r?\n/, 1)[0]?.trim() || 'unavailable';
  const libassAvailable =
    /--enable-libass\b/.test(buildConfiguration) &&
    /\bass\s/.test(filterList) &&
    /\bsubtitles\s/.test(filterList);
  const facts: RenderPreparationFacts = {
    libassProbe,
    libassAvailable,
    canonicalFaces: loadNotoSansArabicFaces(),
    chromium:
      options.title || options.captions
        ? await chromiumFacts(
            options.signal,
            options.chromiumExecutablePath,
            options.expectedChromiumSha256,
          )
        : { launchable: true, executablePath: null, executableSha256: null, version: null },
    ffmpeg: {
      executablePath,
      executableSha256: ffmpegExecutableSha256,
      version,
      buildConfiguration: buildConfiguration.split(/\r?\n/).join('\n').trim(),
      requiredFilters: ['ass', 'subtitles'].filter((filter) =>
        new RegExp(`\\b${filter}\\s`).test(filterList),
      ),
      libassVersion: libassProbe.libassVersion ?? 'unavailable',
      shaperVersion: libassProbe.shaperVersion ?? 'unavailable',
      versionSource: 'canonical-caption-face-ass-probe',
    },
  };
  return facts;
}

async function canonicalCaptionFaceProbe(
  executablePath: string,
  signal?: AbortSignal,
): Promise<CanonicalCaptionFaceProbe> {
  const unavailable = (reason: string): CanonicalCaptionFaceProbe => ({
    usable: false,
    executablePath,
    canonicalFace: 'Noto Sans Arabic Arabic 400',
    reason,
    log: '',
    ...captionEngineVersionsFromAssProbe(''),
  });
  let face: NotoSansArabicFace | undefined;
  try {
    face = loadNotoSansArabicFaces().find(
      (item) => item.subset === 'arabic' && item.weight === 400,
    );
  } catch (error) {
    return unavailable(
      `Canonical Noto Sans Arabic Arabic 400 face could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!face) return unavailable('The canonical Noto Sans Arabic Arabic 400 face is missing.');
  signal?.throwIfAborted();
  const directory = mkdtempSync(join(tmpdir(), 'joy-caption-canonical-'));
  const fontsDirectory = join(directory, 'fonts');
  const fontFile = 'noto-sans-arabic-arabic-400-normal.woff2';
  try {
    mkdirSync(fontsDirectory);
    writeFileSync(join(fontsDirectory, fontFile), face.bytes);
    writeFileSync(
      join(directory, 'probe.ass'),
      [
        '[Script Info]',
        'ScriptType: v4.00+',
        'PlayResX: 320',
        'PlayResY: 180',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: Caption,Noto Sans Arabic,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,20,1',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:00.00,0:00:01.00,Caption,,0,0,0,,مرحبا',
        '',
      ].join('\n'),
    );
    let result: PreparationCommandResult;
    try {
      result = await preparationCommandRunner(
        executablePath,
        [
          '-hide_banner',
          '-loglevel',
          'debug',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=320x180:d=1',
          '-vf',
          'ass=filename=probe.ass:fontsdir=fonts',
          '-frames:v',
          '1',
          '-y',
          'probe.png',
        ],
        { ...(signal === undefined ? {} : { signal }), timeoutMs: 15_000, cwd: directory },
      );
    } catch (error) {
      signal?.throwIfAborted();
      return unavailable(
        `FFmpeg canonical face probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    signal?.throwIfAborted();
    const fontSelectLines = result.output
      .split(/\r?\n/)
      .filter((line) => /fontselect:.*\(Noto Sans Arabic,/i.test(line));
    const openedError = result.output
      .split(/\r?\n/)
      .some((line) => /Error opening/i.test(line) && line.includes(fontFile));
    const selectedCanonical =
      fontSelectLines.length > 0 &&
      fontSelectLines.every((line) => /->\s*Noto Sans Arabic(?:,|\s|$)/i.test(line));
    const usable = result.status === 0 && !openedError && selectedCanonical;
    return {
      usable,
      executablePath,
      canonicalFace: 'Noto Sans Arabic Arabic 400',
      ...(!usable
        ? {
            reason:
              'FFmpeg libass cannot load or select the canonical Noto Sans Arabic Arabic 400 WOFF2 face; captions require this face and will fail closed.',
          }
        : {}),
      log: result.output,
      ...captionEngineVersionsFromAssProbe(result.output),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function root(project: Record<string, unknown>): Record<string, unknown> {
  const compositions = isRecord(project['compositions']) ? project['compositions'] : {};
  const found = compositions[String(project['rootCompositionId'])];
  return isRecord(found) ? found : {};
}

export function projectHasCaptions(project: unknown): boolean {
  if (!isRecord(project)) return false;
  const composition = root(project);
  return (
    Array.isArray(composition['tracks']) &&
    composition['tracks'].some(
      (track) =>
        isRecord(track) &&
        track['enabled'] !== false &&
        Array.isArray(track['clips']) &&
        track['clips'].some((clip) => isRecord(clip) && clip['kind'] === 'caption'),
    )
  );
}

export function projectHasTitles(project: unknown): boolean {
  if (!isRecord(project) || !isRecord(project['pluginData'])) return false;
  const templates = project['pluginData']['joy.contentTemplates'];
  return (
    isRecord(templates) &&
    isRecord(templates['instances']) &&
    Object.keys(templates['instances']).length > 0
  );
}

function captionCues(
  project: Record<string, unknown>,
  measureText?: (text: string, fontSizePx: number, weight: 400 | 700) => number,
  fontSizePx = Math.round(Number(root(project)['height'] ?? 1080) / 18),
): RenderPreparationV1['captions']['cues'] {
  const composition = root(project);
  const docs = isRecord(project['captionDocuments']) ? project['captionDocuments'] : {};
  const cues: Array<{
    lines: string[];
    startUs: number;
    endUs: number;
    direction: 'ltr' | 'rtl' | 'auto';
    measuredWidthsPx: number[];
    maxWidthPx: number;
  }> = [];
  for (const track of Array.isArray(composition['tracks']) ? composition['tracks'] : []) {
    if (!isRecord(track) || track['enabled'] === false || !Array.isArray(track['clips'])) continue;
    for (const clip of track['clips']) {
      if (!isRecord(clip) || clip['kind'] !== 'caption') continue;
      const doc = docs[String(clip['captionDocumentId'])];
      if (!isRecord(doc))
        throw new CommandFailure(
          'CAPTION_UNSUPPORTED',
          'Caption clip refers to a missing caption document.',
        );
      if (doc['styleRef'] !== undefined || doc['animationRef'] !== undefined)
        throw new CommandFailure(
          'CAPTION_UNSUPPORTED',
          'Caption styling or animation is unsupported.',
        );
      const words = isRecord(doc['words']) ? doc['words'] : {};
      const startBase = Number(clip['startUs'] ?? 0);
      const duration = Number(clip['durationUs'] ?? 0);
      const direction =
        doc['direction'] === 'ltr' || doc['direction'] === 'rtl' ? doc['direction'] : 'auto';
      for (const segment of Array.isArray(doc['segments']) ? doc['segments'] : []) {
        if (!isRecord(segment)) continue;
        if (
          segment['karaoke'] === true ||
          segment['style'] !== undefined ||
          segment['animation'] !== undefined
        )
          throw new CommandFailure(
            'CAPTION_UNSUPPORTED',
            'Karaoke, per-cue styles, and animation tags are unsupported.',
          );
        const startUs = startBase + Number(segment['startUs']);
        const endUs = startBase + Math.min(Number(segment['endUs']), duration);
        if (!Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs) || endUs <= startUs)
          continue;
        const text =
          typeof segment['textOverride'] === 'string'
            ? segment['textOverride']
            : (Array.isArray(segment['wordIds']) ? segment['wordIds'] : [])
                .map((id) =>
                  isRecord(words[String(id)])
                    ? String((words[String(id)] as Record<string, unknown>)['text'] ?? '')
                    : '',
                )
                .filter(Boolean)
                .join(' ');
        if (!text.trim()) continue;
        const lines = text.split(/\r?\n/);
        const maxWidthPx = Number(composition['width'] ?? 1920) - 80;
        const measuredWidthsPx = measureText
          ? lines.map((line) => measureText(line, fontSizePx, 400))
          : [];
        if (measuredWidthsPx.some((width) => !Number.isFinite(width) || width < 0))
          throw new CommandFailure(
            'CAPTION_UNSUPPORTED',
            'Caption text measurer returned an invalid width.',
          );
        if (measuredWidthsPx.some((width) => width > maxWidthPx))
          throw new CommandFailure(
            'CAPTION_LAYOUT_OVERFLOW',
            'Measured caption line exceeds the available width; add an explicit hard break and prepare again.',
          );
        cues.push({
          lines,
          startUs,
          endUs,
          direction,
          measuredWidthsPx,
          maxWidthPx,
        });
      }
    }
  }
  return cues;
}

function textOf(
  project: Record<string, unknown>,
  cues: RenderPreparationV1['captions']['cues'],
): string {
  const parts = cues.flatMap((cue) => cue.lines);
  const pluginData = isRecord(project['pluginData']) ? project['pluginData'] : {};
  const templates = isRecord(pluginData['joy.contentTemplates'])
    ? pluginData['joy.contentTemplates']
    : {};
  const instances = isRecord(templates['instances']) ? templates['instances'] : {};
  for (const instance of Object.values(instances)) {
    if (!isRecord(instance) || !isRecord(instance['lines'])) continue;
    parts.push(
      ...Object.values(instance['lines']).filter(
        (value): value is string => typeof value === 'string',
      ),
    );
  }
  return parts.join('\n');
}

function compositionFacts(project: Record<string, unknown>): RenderPreparationV1['composition'] {
  const composition = root(project);
  const rate = isRecord(composition['frameRate']) ? composition['frameRate'] : {};
  return {
    width: Number(composition['width'] ?? 1920),
    height: Number(composition['height'] ?? 1080),
    fps: { num: Number(rate['num'] ?? 30), den: Number(rate['den'] ?? 1) },
  };
}

function captionAssDocument(
  composition: RenderPreparationV1['composition'],
  captions: RenderPreparationV1['captions'],
): string | null {
  if (captions.cues.length === 0) return null;
  return compileCaptionAss({
    width: Math.max(2, composition.width - (composition.width % 2)),
    height: Math.max(2, composition.height - (composition.height % 2)),
    fontFamily: 'Noto Sans Arabic',
    frameRate: composition.fps,
    fontSizePx: captions.fontSizePx,
    marginBottomPx: captions.placement.marginBottomPx,
    cues: captions.cues.map((cue) => ({ text: cue.lines.join('\n'), ...cue })),
  });
}

export function renderInputsDigest(project: unknown): string {
  if (!isRecord(project)) return sha256Identity(project);
  const copy: Record<string, unknown> = { ...project };
  if (isRecord(copy['pluginData'])) {
    const pluginData = { ...copy['pluginData'] };
    delete pluginData[RENDER_PREPARATION_KEY];
    copy['pluginData'] = pluginData;
  }
  return sha256Identity(copy);
}

function selectedFaces(
  faces: readonly NotoSansArabicFace[],
  text: string,
  title: boolean,
  captions: boolean,
  titleFaceWeights: readonly (400 | 700)[],
): NotoSansArabicFace[] {
  const subsetText = new Map<'arabic' | 'latin', string>();
  for (const character of text) {
    if (/[\n\r ]/.test(character)) continue;
    const subset = /[\u0600-\u08ff\ufb50-\ufeff]/u.test(character) ? 'arabic' : 'latin';
    subsetText.set(subset, `${subsetText.get(subset) ?? ''}${character}`);
  }
  const weights = [
    ...new Set([...(captions ? [400 as const] : []), ...(title ? titleFaceWeights : [])]),
  ];
  const selected: NotoSansArabicFace[] = [];
  for (const [subset, checkedText] of subsetText) {
    for (const weight of weights) {
      const face = faces.find(
        (candidate) => candidate.subset === subset && candidate.weight === weight,
      );
      if (!face)
        throw new CommandFailure(
          'FONT_UNAVAILABLE',
          `Canonical ${subset} ${weight} font face is missing.`,
        );
      const missing = missingCanonicalFontCodePoints(face, checkedText);
      if (missing.length > 0)
        throw new CommandFailure(
          'FONT_UNSUPPORTED_GLYPH',
          `Canonical font does not cover checked text: ${missing.map((code) => `U+${code.toString(16).toUpperCase()}`).join(', ')}`,
        );
      selected.push(face);
    }
  }
  return selected;
}

export async function preflightRenderPreparation(
  project: CliProjectDocument,
  operations: readonly { readonly op: string }[],
  facts?: RenderPreparationFacts,
  signal?: AbortSignal,
): Promise<RenderPreparationFacts | undefined> {
  const title =
    operations.some(
      (operation) =>
        operation.op === 'instantiateTemplate' || operation.op === 'updateTemplateText',
    ) || projectHasTitles(project);
  const captions =
    projectHasCaptions(project) ||
    operations.some((operation) => operation.op.toLowerCase().includes('caption'));
  if (!title && !captions) return undefined;
  const current =
    facts ??
    (await readRenderPreparationFacts({
      title,
      captions,
      ...(signal === undefined ? {} : { signal }),
    }));
  if (title && !current.chromium.launchable)
    throw new CommandFailure(
      'SETUP_REQUIRED',
      `SETUP_REQUIRED: ${JSON.stringify({ kind: 'chromium-unavailable', reason: current.chromium.reason ?? 'Chromium is unavailable.' })}`,
    );
  if (captions && (!current.libassAvailable || !current.libassProbe.usable))
    throw new CommandFailure(
      'SETUP_REQUIRED',
      `SETUP_REQUIRED: ${JSON.stringify({ kind: 'canonical-caption-face-unavailable', canonicalFace: current.libassProbe.canonicalFace, limitation: current.libassProbe.reason ?? 'FFmpeg libass cannot load the canonical WOFF2 face.' })}`,
    );
  return current;
}

export function freezeRenderPreparation(
  project: CliProjectDocument,
  operations: readonly { readonly op: string }[],
  facts: RenderPreparationFacts,
): RenderPreparationV1 {
  const title =
    operations.some(
      (operation) =>
        operation.op === 'instantiateTemplate' || operation.op === 'updateTemplateText',
    ) || projectHasTitles(project);
  const captions =
    projectHasCaptions(project) ||
    operations.some((operation) => operation.op.toLowerCase().includes('caption'));
  const captionText = captionCues(project as unknown as Record<string, unknown>);
  const fontSizePx = Math.round(
    Number(root(project as unknown as Record<string, unknown>)['height'] ?? 1080) / 18,
  );
  if (captions && captionText.length > 0 && !facts.measureText)
    throw new CommandFailure(
      'SETUP_REQUIRED',
      'SETUP_REQUIRED: {"kind":"caption-text-measurer-unavailable"}',
    );
  const cues = captionCues(
    project as unknown as Record<string, unknown>,
    facts.measureText,
    fontSizePx,
  );
  const text = textOf(project as unknown as Record<string, unknown>, cues);
  const faces = selectedFaces(
    facts.canonicalFaces,
    text,
    title,
    captions,
    titleWeights(project, title),
  );
  const composition = compositionFacts(project as unknown as Record<string, unknown>);
  const { height } = composition;
  const captionsRecord = {
    sourceDigest: '',
    cues,
    fontSizePx,
    placement: { alignment: 'bottom-center' as const, marginBottomPx: Math.round(height * 0.15) },
    direction: (cues.some((cue) => cue.direction === 'rtl')
      ? 'rtl'
      : cues.some((cue) => cue.direction === 'ltr')
        ? 'ltr'
        : 'auto') as 'ltr' | 'rtl' | 'auto',
    wrapping: 'measured-hard-breaks' as const,
    assDigest: null as string | null,
  };
  captionsRecord.sourceDigest = captionSourceDigest(
    cues,
    captionsRecord.fontSizePx,
    captionsRecord.placement,
    captionsRecord.direction,
  );
  const ass = captions ? captionAssDocument(composition, captionsRecord) : null;
  (captionsRecord as { assDigest: string | null }).assDigest =
    ass === null ? null : hashBytes(Buffer.from(ass));
  const normalizedProject = {
    ...project,
    pluginData: { ...project.pluginData, [RENDER_PREPARATION_KEY]: undefined },
  };
  if (
    captions &&
    [facts.ffmpeg.libassVersion, facts.ffmpeg.shaperVersion].some(
      (version) => typeof version !== 'string' || !version.trim() || version === 'unavailable',
    )
  )
    throw new CommandFailure(
      'SETUP_REQUIRED',
      'Caption preparation requires available libass and shaper version facts.',
    );
  const recordWithoutDigest: Omit<RenderPreparationV1, 'renderInputsDigest'> = {
    version: RENDER_PREPARATION_VERSION,
    renderers: {
      title: title ? 'chromium-scene-surface' : 'none',
      caption: captions ? 'ass-basic' : 'none',
    },
    versions: {
      ...SUPPORTED_POLICY_VERSIONS,
    },
    ffmpeg: {
      ...facts.ffmpeg,
      versionSource: 'canonical-caption-face-ass-probe',
      requiredFilters: [...facts.ffmpeg.requiredFilters],
      canonicalFaceProbe: facts.libassProbe,
    },
    chromium: {
      ...facts.chromium,
      locale: 'en-US',
      deviceScaleFactor: 1,
      captureSettings: { transparent: true, animation: 'frozen' },
    },
    fonts: faces.map((face) => ({
      family: face.family,
      weight: face.weight,
      subset: face.subset,
      length: face.bytes.byteLength,
      sha256: face.sha256,
    })),
    coverage: {
      result: 'passed',
      checkedTextDigest: hashBytes(Buffer.from(text)),
      checkedTextLength: text.length,
      supportedControls: ['newline', 'space', 'ZWNJ', 'ZWJ'],
    },
    composition,
    captions: captionsRecord,
  };
  return {
    ...recordWithoutDigest,
    renderInputsDigest: preparationInputDigest(normalizedProject, recordWithoutDigest),
  };
}

export function readRenderPreparation(project: unknown): RenderPreparationV1 {
  if (
    !isRecord(project) ||
    !isRecord(project['pluginData']) ||
    !Object.hasOwn(project['pluginData'], RENDER_PREPARATION_KEY)
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_REQUIRED',
      'Title or caption rendering requires a frozen render preparation record.',
    );
  const record = project['pluginData'][RENDER_PREPARATION_KEY];
  if (
    !isRecord(record) ||
    record['version'] !== RENDER_PREPARATION_VERSION ||
    !isRecord(record['renderers']) ||
    !isRecord(record['versions']) ||
    !isRecord(record['ffmpeg']) ||
    !isRecord(record['chromium']) ||
    !Array.isArray(record['fonts']) ||
    !isRecord(record['coverage']) ||
    !isRecord(record['composition']) ||
    !isRecord(record['captions']) ||
    typeof record['renderInputsDigest'] !== 'string'
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen render preparation record is malformed.',
    );
  return record as unknown as RenderPreparationV1;
}

export async function validateRenderPreparation(
  project: CliProjectDocument,
  facts?: RenderPreparationFacts,
  signal?: AbortSignal,
): Promise<RenderPreparationV1 | undefined> {
  const title = projectHasTitles(project);
  const captions = projectHasCaptions(project);
  if (!title && !captions) return undefined;
  const record = readRenderPreparation(project);
  for (const [key, supported] of Object.entries(SUPPORTED_POLICY_VERSIONS)) {
    const value = record.versions[key as keyof typeof SUPPORTED_POLICY_VERSIONS];
    if (typeof value !== 'string' || !value.trim())
      throw new CommandFailure(
        'RENDER_PREPARATION_INVALID',
        `Frozen ${key} policy version is malformed.`,
      );
    if (value !== supported)
      throw new CommandFailure(
        'RENDER_ENVIRONMENT_DRIFT',
        `Frozen ${key} policy version is unsupported. Re-prepare the project.`,
      );
  }
  if (
    record.renderers.title !== (title ? 'chromium-scene-surface' : 'none') ||
    record.renderers.caption !== (captions ? 'ass-basic' : 'none')
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen renderer choices do not match the project.',
    );
  if (
    title &&
    (typeof record.chromium.executablePath !== 'string' || !record.chromium.executablePath.trim())
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen render preparation record has no Chromium executable path. Re-prepare the project.',
    );
  if (title && typeof record.chromium.executableSha256 !== 'string')
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen render preparation record has no Chromium executable hash. Re-prepare the project.',
    );
  const current =
    facts ??
    (await readRenderPreparationFacts({
      title,
      captions,
      ...(title ? { chromiumExecutablePath: record.chromium.executablePath! } : {}),
      ...(title && typeof record.chromium.executableSha256 === 'string'
        ? { expectedChromiumSha256: record.chromium.executableSha256 }
        : {}),
      ...(typeof record.ffmpeg.executableSha256 === 'string'
        ? { expectedFFmpegSha256: record.ffmpeg.executableSha256 }
        : {}),
      ...(signal === undefined ? {} : { signal }),
    }));
  if (
    captions &&
    (record.ffmpeg.versionSource !== 'canonical-caption-face-ass-probe' ||
      [record.ffmpeg.libassVersion, record.ffmpeg.shaperVersion].some(
        (version) => typeof version !== 'string' || !version.trim() || version === 'unavailable',
      ))
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Caption preparation record is missing an available libass or shaper version.',
    );
  const sourceFontSize = Math.round(
    Number(root(project as unknown as Record<string, unknown>)['height'] ?? 1080) / 18,
  );
  const sourceCues = captionCues(
    project as unknown as Record<string, unknown>,
    undefined,
    sourceFontSize,
  );
  const frozenCuesMatchSource =
    record.captions.cues.length === sourceCues.length &&
    sourceCues.every((sourceCue, index) => {
      const frozenCue = record.captions.cues[index];
      return (
        frozenCue !== undefined &&
        canonicalJson({
          lines: frozenCue.lines,
          startUs: frozenCue.startUs,
          endUs: frozenCue.endUs,
          direction: frozenCue.direction,
          maxWidthPx: frozenCue.maxWidthPx,
        }) ===
          canonicalJson({
            lines: sourceCue.lines,
            startUs: sourceCue.startUs,
            endUs: sourceCue.endUs,
            direction: sourceCue.direction,
            maxWidthPx: sourceCue.maxWidthPx,
          }) &&
        Array.isArray(frozenCue.measuredWidthsPx) &&
        frozenCue.measuredWidthsPx.length === sourceCue.lines.length &&
        frozenCue.measuredWidthsPx.every(
          (width) => Number.isFinite(width) && width >= 0 && width <= sourceCue.maxWidthPx,
        )
      );
    });
  const text = textOf(project as unknown as Record<string, unknown>, sourceCues);
  const composition = compositionFacts(project as unknown as Record<string, unknown>);
  const expectedPlacement = {
    alignment: 'bottom-center' as const,
    marginBottomPx: Math.round(composition.height * 0.15),
  };
  const expectedDirection = (
    sourceCues.some((cue) => cue.direction === 'rtl')
      ? 'rtl'
      : sourceCues.some((cue) => cue.direction === 'ltr')
        ? 'ltr'
        : 'auto'
  ) as 'ltr' | 'rtl' | 'auto';
  const sourceDigest = captionSourceDigest(
    sourceCues,
    sourceFontSize,
    expectedPlacement,
    expectedDirection,
  );
  if (!frozenCuesMatchSource)
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen caption source semantics or measured widths are inconsistent with the source cues.',
    );
  const expectedCaptions = record.captions;
  const ass = captions ? captionAssDocument(composition, expectedCaptions) : null;
  if (
    canonicalJson(record.composition) !== canonicalJson(composition) ||
    record.captions.sourceDigest !== sourceDigest ||
    !frozenCuesMatchSource ||
    record.captions.fontSizePx !== sourceFontSize ||
    canonicalJson(record.captions.placement) !== canonicalJson(expectedPlacement) ||
    record.captions.direction !== expectedDirection ||
    record.captions.wrapping !== 'measured-hard-breaks' ||
    record.coverage.checkedTextDigest !== hashBytes(Buffer.from(text)) ||
    record.captions.assDigest !== (ass === null ? null : hashBytes(Buffer.from(ass)))
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen composition, caption, or coverage facts are inconsistent with the project.',
    );
  const { renderInputsDigest: ignoredDigest, ...recordWithoutDigest } = record;
  void ignoredDigest;
  const currentFaces = selectedFaces(
    current.canonicalFaces,
    text,
    title,
    captions,
    titleWeights(project, title),
  );
  const fontFacts = currentFaces.map((face) => ({
    family: face.family,
    weight: face.weight,
    subset: face.subset,
    length: face.bytes.byteLength,
    sha256: face.sha256,
  }));
  if (
    canonicalJson(fontFacts.map(({ subset, weight }) => ({ subset, weight }))) !==
    canonicalJson(record.fonts.map(({ subset, weight }) => ({ subset, weight })))
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen selected font faces do not match the weights in the title instances.',
    );
  const chromiumFactsChanged =
    title &&
    (!current.chromium.launchable ||
      current.chromium.executablePath !== record.chromium.executablePath ||
      current.chromium.version !== record.chromium.version ||
      current.chromium.executableSha256 !== record.chromium.executableSha256);
  if (chromiumFactsChanged)
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      `Frozen Chromium changed after preparation (path ${JSON.stringify(record.chromium.executablePath)} / ${JSON.stringify(current.chromium.executablePath)}, version ${JSON.stringify(record.chromium.version)} / ${JSON.stringify(current.chromium.version)}, sha256 ${JSON.stringify(record.chromium.executableSha256)} / ${JSON.stringify(current.chromium.executableSha256)}). Re-prepare the project.`,
    );
  if (
    canonicalJson(fontFacts) !== canonicalJson(record.fonts) ||
    !current.libassProbe ||
    current.ffmpeg.executableSha256 !== record.ffmpeg.executableSha256 ||
    current.ffmpeg.version !== record.ffmpeg.version ||
    (current.ffmpeg.executableSha256 === null &&
      current.ffmpeg.buildConfiguration !== record.ffmpeg.buildConfiguration) ||
    (captions &&
      (current.ffmpeg.libassVersion !== record.ffmpeg.libassVersion ||
        current.ffmpeg.shaperVersion !== record.ffmpeg.shaperVersion ||
        current.ffmpeg.versionSource !== record.ffmpeg.versionSource)) ||
    (title &&
      (record.chromium.locale !== 'en-US' ||
        record.chromium.deviceScaleFactor !== 1 ||
        canonicalJson(record.chromium.captureSettings) !==
          canonicalJson({ transparent: true, animation: 'frozen' }))) ||
    (captions &&
      (!current.libassAvailable ||
        !current.libassProbe.usable ||
        canonicalJson(current.ffmpeg.requiredFilters) !==
          canonicalJson(record.ffmpeg.requiredFilters)))
  )
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      `Render environment or canonical font bytes changed after preparation (fontBytesMatch=${canonicalJson(fontFacts) === canonicalJson(record.fonts)}, ffmpegShaMatch=${current.ffmpeg.executableSha256 === record.ffmpeg.executableSha256}, ffmpegVersionMatch=${current.ffmpeg.version === record.ffmpeg.version}, ffmpegBuildMatch=${(current.ffmpeg.executableSha256 !== null && current.ffmpeg.executableSha256 === record.ffmpeg.executableSha256) || current.ffmpeg.buildConfiguration === record.ffmpeg.buildConfiguration}, titleSettingsMatch=${!title || (record.chromium.locale === 'en-US' && record.chromium.deviceScaleFactor === 1 && canonicalJson(record.chromium.captureSettings) === canonicalJson({ transparent: true, animation: 'frozen' }))}, captionsMatch=${!captions || (current.libassAvailable && current.libassProbe.usable && canonicalJson(current.ffmpeg.requiredFilters) === canonicalJson(record.ffmpeg.requiredFilters))}). Re-prepare the project.`,
    );
  if (preparationInputDigest(project, recordWithoutDigest) !== record.renderInputsDigest)
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      'Render inputs changed after preparation. Re-prepare the project.',
    );
  if (title && typeof record.chromium.executablePath === 'string') {
    if (typeof record.chromium.executableSha256 !== 'string')
      throw new CommandFailure(
        'RENDER_PREPARATION_INVALID',
        'Frozen Chromium record has no executable hash.',
      );
    validatedChromiumSha256.set(record.chromium.executablePath, record.chromium.executableSha256);
  }
  return record;
}
