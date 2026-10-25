import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, sha256Identity } from './prepared-edit.js';
import {
  CAPTION_FACE_UNUSABLE_REASON,
  judgeCaptionProbe,
  prepareCaptionProbe,
} from './caption-face-pixels.js';
import {
  loadNotoSansArabicFaces,
  loadNotoSansArabicLibassFaces,
  missingCanonicalFontCodePoints,
  type NotoSansArabicFace,
} from '@joy-media/html-scene-runtime';
import { CommandFailure, type CliProjectDocument } from '../utils/project-loader.js';
import { ffmpegBinary } from '../utils/media-probe.js';
import { compileCaptionAss } from './captions-ass.js';
import { loadAssetSourcesIfPresent } from '../utils/asset-sources.js';
import {
  captionEngineVersionsFromAssProbe,
  type CanonicalCaptionFaceProbe,
} from '../commands/render-features.js';
import { normalizeUniversalTimeline, type JoyProjectV1 } from '@joy-media/project-schema';

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
type RenderPreparationSpawn = typeof spawn;
let renderPreparationSpawn: RenderPreparationSpawn = spawn;
export function setRenderPreparationSpawnForTests(
  spawner: RenderPreparationSpawn | undefined,
): void {
  renderPreparationSpawn = spawner ?? spawn;
}
export type PreparationCommandResult = { readonly status: number | null; readonly output: string };
export type PreparationCommandRunner = (
  binary: string,
  args: readonly string[],
  options: { readonly signal?: AbortSignal; readonly timeoutMs: number; readonly cwd?: string },
) => Promise<PreparationCommandResult>;
const PREPARATION_TERMINATION_GRACE_MS = 5_000;
let preparationCommandRunner: PreparationCommandRunner = (binary, args, options) =>
  new Promise((resolve, reject) => {
    const child = renderPreparationSpawn(binary, [...args], {
      windowsHide: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    let output = '';
    let settled = false;
    let stopError: unknown;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      options.signal?.removeEventListener('abort', abort);
      if (stopError !== undefined) reject(stopError);
      else resolve({ status, output });
    };
    const terminate = (error: unknown): void => {
      if (settled || stopError !== undefined) return;
      stopError = error;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may have exited before termination was requested.
      }
      terminationTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        options.signal?.removeEventListener('abort', abort);
        reject(
          new Error(
            `Preparation command failed to terminate within ${PREPARATION_TERMINATION_GRACE_MS}ms.`,
          ),
        );
      }, PREPARATION_TERMINATION_GRACE_MS);
    };
    const abort = (): void =>
      terminate(
        options.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'),
      );
    const timeoutTimer = setTimeout(() => {
      const error = Object.assign(new Error('Preparation command timed out.'), {
        code: 'ETIMEDOUT',
      });
      terminate(error);
    }, options.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (output += chunk));
    child.stderr?.on('data', (chunk: string) => (output += chunk));
    child.once('error', terminate);
    child.once('close', finish);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
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

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    keys.filter((key) => Object.hasOwn(value, key)).length === Object.keys(value).length
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function validMeasuredCaptionLine(
  lines: readonly string[],
  widths: readonly number[],
  index: number,
): boolean {
  const line = lines[index];
  const width = widths[index];
  if (line === undefined || width === undefined || !Number.isFinite(width) || width < 0)
    return false;
  if (line.length > 0) return true;
  return index > 0 && index < lines.length - 1 && width === 0;
}

function isExecutableIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:.+$/u.test(value);
}

function isPreparationRecord(value: unknown): value is RenderPreparationV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'version',
      'renderers',
      'versions',
      'ffmpeg',
      'chromium',
      'fonts',
      'coverage',
      'composition',
      'captions',
      'renderInputsDigest',
    ]) ||
    value['version'] !== RENDER_PREPARATION_VERSION ||
    !isDigest(value['renderInputsDigest'])
  )
    return false;

  const renderers = value['renderers'];
  const versions = value['versions'];
  const ffmpeg = value['ffmpeg'];
  const chromium = value['chromium'];
  const coverage = value['coverage'];
  const composition = value['composition'];
  const captions = value['captions'];
  if (
    !isRecord(renderers) ||
    !hasOnlyKeys(renderers, ['title', 'caption']) ||
    !['chromium-scene-surface', 'none'].includes(String(renderers['title'])) ||
    !['ass-basic', 'none'].includes(String(renderers['caption'])) ||
    !isRecord(versions) ||
    !hasOnlyKeys(versions, Object.keys(SUPPORTED_POLICY_VERSIONS)) ||
    !Object.keys(SUPPORTED_POLICY_VERSIONS).every((key) => typeof versions[key] === 'string') ||
    !isRecord(ffmpeg) ||
    !hasOnlyKeys(ffmpeg, [
      'executablePath',
      'executableSha256',
      'version',
      'buildConfiguration',
      'requiredFilters',
      'libassVersion',
      'shaperVersion',
      'versionSource',
      'canonicalFaceProbe',
    ]) ||
    typeof ffmpeg['executablePath'] !== 'string' ||
    ffmpeg['executablePath'].trim() === '' ||
    !(ffmpeg['executableSha256'] === null || isExecutableIdentity(ffmpeg['executableSha256'])) ||
    typeof ffmpeg['version'] !== 'string' ||
    ffmpeg['version'].trim() === '' ||
    typeof ffmpeg['buildConfiguration'] !== 'string' ||
    !Array.isArray(ffmpeg['requiredFilters']) ||
    !ffmpeg['requiredFilters'].every(
      (filter) => typeof filter === 'string' && filter.trim() !== '',
    ) ||
    typeof ffmpeg['libassVersion'] !== 'string' ||
    typeof ffmpeg['shaperVersion'] !== 'string' ||
    ffmpeg['versionSource'] !== 'canonical-caption-face-ass-probe' ||
    !isRecord(ffmpeg['canonicalFaceProbe']) ||
    !hasOnlyKeys(ffmpeg['canonicalFaceProbe'], [
      'usable',
      'executablePath',
      'canonicalFace',
      'reason',
      'log',
      'libassVersion',
      'shaperVersion',
      'versionSource',
    ]) ||
    typeof ffmpeg['canonicalFaceProbe']['usable'] !== 'boolean' ||
    typeof ffmpeg['canonicalFaceProbe']['executablePath'] !== 'string' ||
    ffmpeg['canonicalFaceProbe']['executablePath'].trim() === '' ||
    ffmpeg['canonicalFaceProbe']['canonicalFace'] !== 'Noto Sans Arabic Arabic 400' ||
    (Object.hasOwn(ffmpeg['canonicalFaceProbe'], 'reason') &&
      typeof ffmpeg['canonicalFaceProbe']['reason'] !== 'string') ||
    typeof ffmpeg['canonicalFaceProbe']['log'] !== 'string' ||
    (Object.hasOwn(ffmpeg['canonicalFaceProbe'], 'libassVersion') &&
      typeof ffmpeg['canonicalFaceProbe']['libassVersion'] !== 'string') ||
    (Object.hasOwn(ffmpeg['canonicalFaceProbe'], 'shaperVersion') &&
      typeof ffmpeg['canonicalFaceProbe']['shaperVersion'] !== 'string') ||
    (Object.hasOwn(ffmpeg['canonicalFaceProbe'], 'versionSource') &&
      ffmpeg['canonicalFaceProbe']['versionSource'] !== 'canonical-caption-face-ass-probe') ||
    !isRecord(chromium) ||
    !hasOnlyKeys(chromium, [
      'launchable',
      'executablePath',
      'executableSha256',
      'version',
      'reason',
      'locale',
      'deviceScaleFactor',
      'captureSettings',
    ]) ||
    typeof chromium['launchable'] !== 'boolean' ||
    !(chromium['executablePath'] === null || typeof chromium['executablePath'] === 'string') ||
    !(
      chromium['executableSha256'] === null || isExecutableIdentity(chromium['executableSha256'])
    ) ||
    !(chromium['version'] === null || typeof chromium['version'] === 'string') ||
    (Object.hasOwn(chromium, 'reason') && typeof chromium['reason'] !== 'string') ||
    chromium['locale'] !== 'en-US' ||
    chromium['deviceScaleFactor'] !== 1 ||
    (chromium['launchable'] &&
      (typeof chromium['executablePath'] !== 'string' ||
        chromium['executablePath'].trim() === '' ||
        typeof chromium['version'] !== 'string' ||
        chromium['version'].trim() === '')) ||
    !isRecord(chromium['captureSettings']) ||
    !hasOnlyKeys(chromium['captureSettings'], ['transparent', 'animation']) ||
    chromium['captureSettings']['transparent'] !== true ||
    chromium['captureSettings']['animation'] !== 'frozen' ||
    !Array.isArray(value['fonts']) ||
    !value['fonts'].every(
      (font) =>
        isRecord(font) &&
        hasOnlyKeys(font, ['family', 'weight', 'subset', 'length', 'sha256']) &&
        typeof font['family'] === 'string' &&
        font['family'].length > 0 &&
        (font['weight'] === 400 || font['weight'] === 700) &&
        (font['subset'] === 'arabic' || font['subset'] === 'latin') &&
        Number.isSafeInteger(font['length']) &&
        Number(font['length']) > 0 &&
        isDigest(font['sha256']),
    ) ||
    !isRecord(coverage) ||
    !hasOnlyKeys(coverage, [
      'result',
      'checkedTextDigest',
      'checkedTextLength',
      'supportedControls',
    ]) ||
    coverage['result'] !== 'passed' ||
    !isDigest(coverage['checkedTextDigest']) ||
    !Number.isSafeInteger(coverage['checkedTextLength']) ||
    Number(coverage['checkedTextLength']) < 0 ||
    !Array.isArray(coverage['supportedControls']) ||
    canonicalJson(coverage['supportedControls']) !==
      canonicalJson(['newline', 'space', 'ZWNJ', 'ZWJ']) ||
    !isRecord(composition) ||
    !hasOnlyKeys(composition, ['width', 'height', 'fps']) ||
    !Number.isSafeInteger(composition['width']) ||
    Number(composition['width']) <= 0 ||
    !Number.isSafeInteger(composition['height']) ||
    Number(composition['height']) <= 0 ||
    !isRecord(composition['fps']) ||
    !hasOnlyKeys(composition['fps'], ['num', 'den']) ||
    !Number.isSafeInteger(composition['fps']['num']) ||
    Number(composition['fps']['num']) <= 0 ||
    !Number.isSafeInteger(composition['fps']['den']) ||
    Number(composition['fps']['den']) <= 0 ||
    !isRecord(captions) ||
    !hasOnlyKeys(captions, [
      'sourceDigest',
      'cues',
      'fontSizePx',
      'placement',
      'direction',
      'wrapping',
      'assDigest',
    ]) ||
    !isDigest(captions['sourceDigest']) ||
    !Array.isArray(captions['cues']) ||
    !Number.isSafeInteger(captions['fontSizePx']) ||
    Number(captions['fontSizePx']) <= 0 ||
    !isRecord(captions['placement']) ||
    !hasOnlyKeys(captions['placement'], ['alignment', 'marginBottomPx']) ||
    captions['placement']['alignment'] !== 'bottom-center' ||
    !Number.isSafeInteger(captions['placement']['marginBottomPx']) ||
    Number(captions['placement']['marginBottomPx']) < 0 ||
    !['ltr', 'rtl', 'auto'].includes(String(captions['direction'])) ||
    captions['wrapping'] !== 'measured-hard-breaks' ||
    !(captions['assDigest'] === null || isDigest(captions['assDigest'])) ||
    !captions['cues'].every(
      (cue) =>
        isRecord(cue) &&
        hasOnlyKeys(cue, [
          'lines',
          'startUs',
          'endUs',
          'direction',
          'measuredWidthsPx',
          'maxWidthPx',
        ]) &&
        Array.isArray(cue['lines']) &&
        cue['lines'].length > 0 &&
        cue['lines'].every((line) => typeof line === 'string') &&
        Number.isSafeInteger(cue['startUs']) &&
        Number(cue['startUs']) >= 0 &&
        Number.isSafeInteger(cue['endUs']) &&
        Number(cue['endUs']) > Number(cue['startUs']) &&
        ['ltr', 'rtl', 'auto'].includes(String(cue['direction'])) &&
        Number.isFinite(cue['maxWidthPx']) &&
        Number(cue['maxWidthPx']) > 0 &&
        Array.isArray(cue['measuredWidthsPx']) &&
        cue['measuredWidthsPx'].length === cue['lines'].length &&
        cue['lines'].every((line, index) =>
          validMeasuredCaptionLine(
            cue['lines'] as string[],
            cue['measuredWidthsPx'] as number[],
            index,
          ),
        ) &&
        cue['measuredWidthsPx'].every(
          (width) =>
            Number.isFinite(width) &&
            Number(width) >= 0 &&
            Number(width) <= Number(cue['maxWidthPx']),
        ),
    )
  )
    return false;
  return true;
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function preparationInputDigest(
  project: unknown,
  recordWithoutDigest: Omit<RenderPreparationV1, 'renderInputsDigest'>,
  mediaDir?: string,
): string {
  return sha256Identity({
    project: renderInputsDigest(project, mediaDir),
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
  const projectRecord = isRecord(project) ? project : {};
  const weights = new Set<400 | 700>();
  for (const instance of instances) {
    if (
      !isRecord(instance) ||
      !titleInstanceIsActive(projectRecord, instance) ||
      !isRecord(instance['font'])
    )
      continue;
    const weight = instance['font']['weight'];
    if (weight === 400 || weight === 700) weights.add(weight);
  }
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

export async function resolveExecutable(binary: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (isAbsolute(binary)) {
    if (existsSync(binary)) return binary;
    throw new CommandFailure(
      'SETUP_REQUIRED',
      `SETUP_REQUIRED: FFmpeg executable was not found at its configured absolute path ${JSON.stringify(binary)}. Install FFmpeg or set JOY_MEDIA_FFMPEG to a valid path.`,
    );
  }
  const child = renderPreparationSpawn(
    process.platform === 'win32' ? 'where.exe' : 'which',
    [binary],
    {
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  let output = '';
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stopReason: 'abort' | 'timeout' | 'error' | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (path: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      signal?.removeEventListener('abort', abort);
      if (stopReason === 'abort')
        reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      else if (path !== undefined && isAbsolute(path)) resolve(path);
      else
        reject(
          new CommandFailure(
            'SETUP_REQUIRED',
            `SETUP_REQUIRED: FFmpeg executable "${binary}" was not found as an absolute path. Install FFmpeg or set JOY_MEDIA_FFMPEG to its absolute path.`,
          ),
        );
    };
    const terminate = (reason: 'abort' | 'timeout' | 'error'): void => {
      if (settled || stopReason !== undefined) return;
      stopReason = reason;
      try {
        child.kill('SIGKILL');
      } catch {
        // The lookup may have exited concurrently.
      }
      terminationTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(
          new Error(
            `Executable lookup failed to terminate within ${PREPARATION_TERMINATION_GRACE_MS}ms.`,
          ),
        );
      }, PREPARATION_TERMINATION_GRACE_MS);
    };
    const abort = (): void => terminate('abort');
    const timer = setTimeout(() => {
      terminate('timeout');
    }, 5_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (output += chunk));
    child.once('error', (error) => {
      void error;
      terminate(signal?.aborted ? 'abort' : 'error');
    });
    child.once('close', (status) =>
      finish(
        stopReason === undefined && status === 0 ? output.split(/\r?\n/, 1)[0]?.trim() : undefined,
      ),
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
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
  const executablePath = await resolveExecutable(ffmpegBinary(), options.signal);
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
  signal?.throwIfAborted();
  const fontFile = 'noto-sans-arabic-arabic-400-normal.ttf';
  const directory = mkdtempSync(join(tmpdir(), 'joy-caption-canonical-'));
  try {
    const commands = prepareCaptionProbe(directory, fontFile, face.bytes);
    const runOptions = {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 15_000,
      cwd: directory,
    };
    let canonical: PreparationCommandResult;
    let missing: PreparationCommandResult;
    try {
      canonical = await preparationCommandRunner(executablePath, commands.canonical, runOptions);
      missing = await preparationCommandRunner(executablePath, commands.missing, runOptions);
    } catch (error) {
      signal?.throwIfAborted();
      return unavailable(
        `FFmpeg canonical face probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    signal?.throwIfAborted();
    const judged = judgeCaptionProbe({
      directory,
      fontFile,
      canonical: { status: canonical.status, log: canonical.output },
      missing: { status: missing.status },
    });
    return {
      usable: judged.usable,
      executablePath,
      canonicalFace: 'Noto Sans Arabic Arabic 400',
      ...(!judged.usable ? { reason: CAPTION_FACE_UNUSABLE_REASON } : {}),
      log: judged.log,
      ...captionEngineVersionsFromAssProbe(judged.log),
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

function normalizedRootItems(project: Record<string, unknown>) {
  return normalizeUniversalTimeline({
    ...project,
    schemaVersion: 1,
    assets: isRecord(project['assets']) ? project['assets'] : {},
    visualObjects: isRecord(project['visualObjects']) ? project['visualObjects'] : {},
    captionDocuments: isRecord(project['captionDocuments']) ? project['captionDocuments'] : {},
  } as unknown as JoyProjectV1).items.filter(
    (item) => item.compositionId === project['rootCompositionId'],
  );
}

function enabledCaptionClipIds(project: Record<string, unknown>): ReadonlySet<string> {
  if (!isRecord(project['timelineTrackDeck'])) {
    const composition = root(project);
    return new Set(
      (Array.isArray(composition['tracks']) ? composition['tracks'] : []).flatMap((track) =>
        isRecord(track) && track['enabled'] !== false && Array.isArray(track['clips'])
          ? track['clips'].flatMap((clip) =>
              isRecord(clip) && typeof clip['id'] === 'string' ? [clip['id']] : [],
            )
          : [],
      ),
    );
  }
  return new Set(
    normalizedRootItems(project)
      .filter((item) => item.trackEnabled)
      .map((item) => item.id),
  );
}

export function isTitleClipActive(project: unknown, clipId: unknown): boolean {
  if (!isRecord(project) || typeof clipId !== 'string') return false;
  const item = normalizedRootItems(project).find((candidate) => candidate.id === clipId);
  if (item === undefined || !item.trackEnabled || item.elementKind === 'audio') return false;
  const tracks = root(project)['tracks'];
  const track = (Array.isArray(tracks) ? tracks : []).find(
    (candidate) => isRecord(candidate) && candidate['id'] === item.trackId,
  );
  return (
    isRecord(track) &&
    track['kind'] === 'video' &&
    track['family'] !== 'audio' &&
    track['family'] !== 'caption' &&
    Array.isArray(track['clips']) &&
    track['clips'].some((clip) => isRecord(clip) && clip['id'] === clipId)
  );
}

function titleInstanceIsActive(
  project: Record<string, unknown>,
  instance: Record<string, unknown>,
): boolean {
  return isTitleClipActive(project, instance['clipId']);
}

export function projectHasCaptions(project: unknown): boolean {
  if (!isRecord(project)) return false;
  const composition = root(project);
  const enabledClipIds = enabledCaptionClipIds(project);
  return (
    Array.isArray(composition['tracks']) &&
    composition['tracks'].some(
      (track) =>
        isRecord(track) &&
        Array.isArray(track['clips']) &&
        track['clips'].some(
          (clip) =>
            isRecord(clip) &&
            clip['kind'] === 'caption' &&
            typeof clip['id'] === 'string' &&
            enabledClipIds.has(clip['id']),
        ),
    )
  );
}

export function projectHasTitles(project: unknown): boolean {
  if (!isRecord(project) || !isRecord(project['pluginData'])) return false;
  const templates = project['pluginData']['joy.contentTemplates'];
  if (!isRecord(templates) || !isRecord(templates['instances'])) return false;
  return Object.values(templates['instances']).some(
    (instance) => isRecord(instance) && titleInstanceIsActive(project, instance),
  );
}

/**
 * Breaks a source line at spaces, greedily, when it is wider than the available width. A word that
 * is too wide on its own cannot be broken, so it is refused. Only breaks are added, so the wrapped
 * lines still read as the source line.
 */
function wrapMeasuredCaptionLine(
  line: string,
  measure: (text: string) => number,
  maxWidthPx: number,
): string[] {
  if (measure(line) <= maxWidthPx) return [line];
  const words = line.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [line];
  const wrapped: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (measure(candidate) <= maxWidthPx) {
      current = candidate;
      continue;
    }
    if (measure(word) > maxWidthPx)
      throw new CommandFailure(
        'CAPTION_LAYOUT_OVERFLOW',
        'A caption word is wider than the available width; use a smaller text size or a shorter word.',
      );
    wrapped.push(current);
    current = word;
  }
  wrapped.push(current);
  return wrapped;
}

/**
 * True when the frozen lines are the source lines with extra breaks only: the same words in the
 * same order, every source line kept whole, and no empty line inside a source line.
 */
function frozenLinesWrapSource(frozen: readonly string[], source: readonly string[]): boolean {
  let next = 0;
  for (const sourceLine of source) {
    const wanted = sourceLine.split(/\s+/).filter((word) => word !== '');
    const have: string[] = [];
    do {
      if (next >= frozen.length) return false;
      const piece = frozen[next++]!.split(/\s+/).filter((word) => word !== '');
      if (piece.length === 0 && wanted.length > 0) return false;
      have.push(...piece);
    } while (have.length < wanted.length);
    if (have.length !== wanted.length || have.some((word, index) => word !== wanted[index]))
      return false;
  }
  return next === frozen.length;
}

function captionCues(
  project: Record<string, unknown>,
  measureText?: (text: string, fontSizePx: number, weight: 400 | 700) => number,
  fontSizePx = Math.round(Number(root(project)['height'] ?? 1080) / 18),
): RenderPreparationV1['captions']['cues'] {
  const composition = root(project);
  const docs = isRecord(project['captionDocuments']) ? project['captionDocuments'] : {};
  const enabledClipIds = enabledCaptionClipIds(project);
  const cues: Array<{
    lines: string[];
    startUs: number;
    endUs: number;
    direction: 'ltr' | 'rtl' | 'auto';
    measuredWidthsPx: number[];
    maxWidthPx: number;
  }> = [];
  for (const track of Array.isArray(composition['tracks']) ? composition['tracks'] : []) {
    if (!isRecord(track) || !Array.isArray(track['clips'])) continue;
    for (const clip of track['clips']) {
      if (!isRecord(clip) || clip['kind'] !== 'caption' || !enabledClipIds.has(String(clip['id'])))
        continue;
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
        const maxWidthPx = Number(composition['width'] ?? 1920) - 80;
        const sourceLines = text.split(/\r?\n/);
        const lines = measureText
          ? sourceLines.flatMap((line) =>
              wrapMeasuredCaptionLine(
                line,
                (candidate) => measureText(candidate, fontSizePx, 400),
                maxWidthPx,
              ),
            )
          : sourceLines;
        const measuredWidthsPx = measureText
          ? lines.map((line) => measureText(line, fontSizePx, 400))
          : [];
        if (
          measuredWidthsPx.length > 0 &&
          lines.some((_, index) => !validMeasuredCaptionLine(lines, measuredWidthsPx, index))
        )
          throw new CommandFailure(
            'CAPTION_UNSUPPORTED',
            'Caption blank lines must be hard breaks with a measured width of zero.',
          );
        if (measuredWidthsPx.some((width) => !Number.isFinite(width) || width < 0))
          throw new CommandFailure(
            'CAPTION_UNSUPPORTED',
            'Caption text measurer returned an invalid width.',
          );
        if (measuredWidthsPx.some((width) => width > maxWidthPx))
          throw new CommandFailure(
            'CAPTION_LAYOUT_OVERFLOW',
            'Measured caption line exceeds the available width after wrapping.',
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
    if (
      !isRecord(instance) ||
      !titleInstanceIsActive(project, instance) ||
      !isRecord(instance['lines'])
    )
      continue;
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

/** Shared renderer resolver for a registered source, --media-dir name, or path asset id. */
export function resolveRenderMediaSource(
  assetId: string,
  asset: unknown,
  sources: Readonly<Record<string, string>>,
  mediaDir?: string,
): string | null {
  const isFile = (path: string): boolean => {
    try {
      return existsSync(path) && statSync(path).isFile() && realpathSync(path) !== '';
    } catch {
      return false;
    }
  };
  const registered = sources[assetId];
  if (registered && isFile(registered)) return registered;
  if (mediaDir) {
    const displayName =
      isRecord(asset) && typeof asset['displayName'] === 'string' ? asset['displayName'] : '';
    for (const name of [assetId, displayName]) {
      if (!name) continue;
      const candidate = join(mediaDir, name);
      if (isFile(candidate)) return resolve(candidate);
    }
  }
  if (isFile(assetId)) return isAbsolute(assetId) ? assetId : resolve(assetId);
  return null;
}

export function resolveRenderInputPaths(project: unknown, mediaDir?: string): string[] {
  if (!isRecord(project)) return [];
  const assets = isRecord(project['assets']) ? project['assets'] : {};
  const registeredSources = loadAssetSourcesIfPresent();
  const references = new Map<string, unknown>(Object.entries(assets));
  const composition = root(project);
  for (const track of Array.isArray(composition['tracks']) ? composition['tracks'] : []) {
    if (!isRecord(track) || !Array.isArray(track['clips'])) continue;
    for (const clip of track['clips']) {
      if (isRecord(clip) && typeof clip['assetId'] === 'string' && !references.has(clip['assetId']))
        references.set(clip['assetId'], undefined);
    }
  }
  const paths = new Set<string>();
  for (const [assetId, rawAsset] of references) {
    const candidate = resolveRenderMediaSource(assetId, rawAsset, registeredSources, mediaDir);
    if (!candidate) continue;
    try {
      paths.add(realpathSync(resolve(candidate)));
    } catch {
      // A file disappearing during inventory collection is reported by media planning.
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export function renderInputsDigest(project: unknown, mediaDir?: string): string {
  if (!isRecord(project)) return sha256Identity(project);
  const copy: Record<string, unknown> = { ...project };
  if (isRecord(copy['pluginData'])) {
    const pluginData = { ...copy['pluginData'] };
    delete pluginData[RENDER_PREPARATION_KEY];
    copy['pluginData'] = pluginData;
  }
  const files = resolveRenderInputPaths(project, mediaDir).map((canonicalPath) => ({
    path: canonicalPath,
    sha256: hashBytes(readFileSync(canonicalPath)),
  }));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return sha256Identity({ project: copy, mediaFiles: files });
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
  mediaDir?: string,
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
  // The source digest covers the typed lines; the frozen layout adds the measured breaks.
  const sourceCues = captionCues(
    project as unknown as Record<string, unknown>,
    undefined,
    fontSizePx,
  );
  const cues = captionCues(
    project as unknown as Record<string, unknown>,
    facts.measureText,
    fontSizePx,
  );
  const text = textOf(project as unknown as Record<string, unknown>, cues);
  selectedFaces(facts.canonicalFaces, text, title, captions, titleWeights(project, title));
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
    sourceCues,
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
    fonts: facts.canonicalFaces.map((face) => ({
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
    renderInputsDigest: preparationInputDigest(normalizedProject, recordWithoutDigest, mediaDir),
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
  if (!isPreparationRecord(record))
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen render preparation record is malformed.',
    );
  return record;
}

export async function validateRenderPreparation(
  project: CliProjectDocument,
  facts?: RenderPreparationFacts,
  signal?: AbortSignal,
  mediaDir?: string,
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
  const recordedProbe = { ...record.ffmpeg.canonicalFaceProbe, log: undefined };
  const currentProbe = { ...current.libassProbe, log: undefined };
  if (canonicalJson(recordedProbe) !== canonicalJson(currentProbe))
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      'Canonical caption face probe facts changed after preparation.',
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
        frozenLinesWrapSource(frozenCue.lines, sourceCue.lines) &&
        canonicalJson({
          startUs: frozenCue.startUs,
          endUs: frozenCue.endUs,
          direction: frozenCue.direction,
          maxWidthPx: frozenCue.maxWidthPx,
        }) ===
          canonicalJson({
            startUs: sourceCue.startUs,
            endUs: sourceCue.endUs,
            direction: sourceCue.direction,
            maxWidthPx: sourceCue.maxWidthPx,
          }) &&
        Array.isArray(frozenCue.measuredWidthsPx) &&
        frozenCue.measuredWidthsPx.length === frozenCue.lines.length &&
        frozenCue.measuredWidthsPx.every(
          (width) => Number.isFinite(width) && width >= 0 && width <= sourceCue.maxWidthPx,
        )
      );
    });
  const text = textOf(project as unknown as Record<string, unknown>, record.captions.cues);
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
    record.coverage.checkedTextLength !== text.length
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen composition, caption, or coverage facts are inconsistent with the project.',
    );
  if (record.captions.assDigest !== (ass === null ? null : hashBytes(Buffer.from(ass))))
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'The prepared caption layout was made by a different caption compiler. Run plan prepare again.',
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
  const fontInventory = current.canonicalFaces.map((face) => ({
    family: face.family,
    weight: face.weight,
    subset: face.subset,
    length: face.bytes.byteLength,
    sha256: face.sha256,
  }));
  const inventoryKeys = fontInventory.map(
    ({ family, weight, subset }) => `${family}:${weight}:${subset}`,
  );
  const recordedKeys = record.fonts.map(
    ({ family, weight, subset }) => `${family}:${weight}:${subset}`,
  );
  if (
    new Set(recordedKeys).size !== recordedKeys.length ||
    canonicalJson([...recordedKeys].sort()) !== canonicalJson([...inventoryKeys].sort())
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen font inventory does not contain the complete canonical face set.',
    );
  if (
    canonicalJson(fontInventory) !== canonicalJson(record.fonts) ||
    currentFaces.some(
      (face) =>
        !record.fonts.some(
          (recorded) =>
            recorded.family === face.family &&
            recorded.weight === face.weight &&
            recorded.subset === face.subset,
        ),
    )
  )
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      'Canonical font inventory changed after preparation.',
    );
  const chromiumFactsChanged =
    (title || captions) &&
    (current.chromium.launchable !== record.chromium.launchable ||
      current.chromium.executablePath !== record.chromium.executablePath ||
      current.chromium.version !== record.chromium.version ||
      current.chromium.executableSha256 !== record.chromium.executableSha256);
  if (chromiumFactsChanged)
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      `Frozen Chromium changed after preparation (path ${JSON.stringify(record.chromium.executablePath)} / ${JSON.stringify(current.chromium.executablePath)}, version ${JSON.stringify(record.chromium.version)} / ${JSON.stringify(current.chromium.version)}, sha256 ${JSON.stringify(record.chromium.executableSha256)} / ${JSON.stringify(current.chromium.executableSha256)}). Re-prepare the project.`,
    );
  if (
    !current.libassProbe ||
    current.ffmpeg.executablePath !== record.ffmpeg.executablePath ||
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
      `Render environment or canonical font bytes changed after preparation (ffmpegShaMatch=${current.ffmpeg.executableSha256 === record.ffmpeg.executableSha256}, ffmpegVersionMatch=${current.ffmpeg.version === record.ffmpeg.version}, ffmpegBuildMatch=${(current.ffmpeg.executableSha256 !== null && current.ffmpeg.executableSha256 === record.ffmpeg.executableSha256) || current.ffmpeg.buildConfiguration === record.ffmpeg.buildConfiguration}, titleSettingsMatch=${!title || (record.chromium.locale === 'en-US' && record.chromium.deviceScaleFactor === 1 && canonicalJson(record.chromium.captureSettings) === canonicalJson({ transparent: true, animation: 'frozen' }))}, captionsMatch=${!captions || (current.libassAvailable && current.libassProbe.usable && canonicalJson(current.ffmpeg.requiredFilters) === canonicalJson(record.ffmpeg.requiredFilters))}). Re-prepare the project.`,
    );
  if (preparationInputDigest(project, recordWithoutDigest, mediaDir) !== record.renderInputsDigest)
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
