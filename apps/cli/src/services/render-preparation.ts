import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  probeCanonicalCaptionFace,
  probeLibass,
  type CanonicalCaptionFaceProbe,
} from '../commands/render-features.js';

export const RENDER_PREPARATION_KEY = 'joy.renderPreparation';
export const RENDER_PREPARATION_VERSION = 'RenderPreparationV1';

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
    readonly fallbackVerified: true;
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

let factsProvider: (() => Promise<RenderPreparationFacts>) | undefined;
export function setRenderPreparationFactsProviderForTests(
  provider: (() => Promise<RenderPreparationFacts>) | undefined,
): void {
  factsProvider = provider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function command(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return result.status === 0 && !result.error ? `${result.stdout}${result.stderr}` : '';
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

async function chromiumFacts(): Promise<RenderPreparationFacts['chromium']> {
  try {
    const runtime = (await import('@joy-media/html-scene-runtime')) as {
      findChromiumExecutable(): string | undefined;
      createChromiumSceneDriver(options?: { executablePath?: string }): {
        readonly browserVersion?: string;
        close?(): void;
      };
    };
    const executablePath = runtime.findChromiumExecutable();
    if (!executablePath)
      return {
        launchable: false,
        executablePath: null,
        executableSha256: null,
        version: null,
        reason: 'Chromium executable was not found.',
      };
    const driver = runtime.createChromiumSceneDriver({ executablePath });
    const version = driver.browserVersion?.trim() ?? '';
    driver.close?.();
    if (!version)
      return {
        launchable: false,
        executablePath,
        executableSha256: hashBytes(readFileSync(executablePath)),
        version: null,
        reason: 'Chromium did not report a browser version.',
      };
    return {
      launchable: true,
      executablePath,
      executableSha256: hashBytes(readFileSync(executablePath)),
      version,
    };
  } catch (error) {
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
}): Promise<RenderPreparationFacts> {
  if (factsProvider) return factsProvider();
  const executablePath = resolveExecutable(ffmpegBinary());
  const runBinary = ffmpegBinary();
  const buildConfiguration = command(runBinary, ['-buildconf']);
  const filterList = command(runBinary, ['-filters']);
  const version = command(runBinary, ['-version']).split(/\r?\n/, 1)[0]?.trim() || 'unavailable';
  const facts: RenderPreparationFacts = {
    libassProbe: probeCanonicalCaptionFace(executablePath),
    libassAvailable: probeLibass(),
    canonicalFaces: loadNotoSansArabicFaces(),
    chromium:
      options.title || options.captions
        ? await chromiumFacts()
        : { launchable: true, executablePath: null, executableSha256: null, version: null },
    ffmpeg: {
      executablePath,
      executableSha256: (() => {
        try {
          return hashBytes(readFileSync(executablePath));
        } catch {
          return null;
        }
      })(),
      version,
      buildConfiguration: buildConfiguration.split(/\r?\n/).join('\n').trim(),
      requiredFilters: ['ass', 'subtitles'].filter((filter) =>
        new RegExp(`\\b${filter}\\s`).test(filterList),
      ),
      libassVersion:
        /libass\s+([\w.]+)/i.exec(buildConfiguration + filterList)?.[1] ?? 'unavailable',
      shaperVersion:
        /harfbuzz\s+([\w.]+)/i.exec(buildConfiguration + filterList)?.[1] ?? 'unavailable',
    },
  };
  return facts;
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
): NotoSansArabicFace[] {
  const subsetText = new Map<'arabic' | 'latin', string>();
  for (const character of text) {
    if (/[\n\r ]/.test(character)) continue;
    const subset = /[\u0600-\u08ff\ufb50-\ufeff]/u.test(character) ? 'arabic' : 'latin';
    subsetText.set(subset, `${subsetText.get(subset) ?? ''}${character}`);
  }
  const weights = [
    ...new Set([...(captions ? [400 as const] : []), ...(title ? [700 as const] : [])]),
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
  const current = facts ?? (await readRenderPreparationFacts({ title, captions }));
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
  const faces = selectedFaces(facts.canonicalFaces, text, title, captions);
  const composition = compositionFacts(project as unknown as Record<string, unknown>);
  const { height } = composition;
  const captionsRecord = {
    sourceDigest: sha256Identity(
      cues.map(({ lines, startUs, endUs, direction }) => ({ lines, startUs, endUs, direction })),
    ),
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
  const ass = captions ? captionAssDocument(composition, captionsRecord) : null;
  (captionsRecord as { assDigest: string | null }).assDigest =
    ass === null ? null : hashBytes(Buffer.from(ass));
  const normalizedProject = {
    ...project,
    pluginData: { ...project.pluginData, [RENDER_PREPARATION_KEY]: undefined },
  };
  const record: RenderPreparationV1 = {
    version: RENDER_PREPARATION_VERSION,
    renderers: {
      title: title ? 'chromium-scene-surface' : 'none',
      caption: captions ? 'ass-basic' : 'none',
    },
    versions: {
      renderer: '1',
      adapter: '1',
      compiler: '1',
      coverage: '1',
      layout: '1',
      timingPolicy: 'rational-centisecond-v1',
    },
    ffmpeg: {
      ...facts.ffmpeg,
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
      fallbackVerified: true,
    },
    composition,
    captions: captionsRecord,
    renderInputsDigest: renderInputsDigest(normalizedProject),
  };
  return record;
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
): Promise<RenderPreparationV1 | undefined> {
  const title = projectHasTitles(project);
  const captions = projectHasCaptions(project);
  if (!title && !captions) return undefined;
  const record = readRenderPreparation(project);
  if (
    record.renderers.title !== (title ? 'chromium-scene-surface' : 'none') ||
    record.renderers.caption !== (captions ? 'ass-basic' : 'none')
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen renderer choices do not match the project.',
    );
  const current = facts ?? (await readRenderPreparationFacts({ title, captions }));
  const sourceCues = captionCues(project as unknown as Record<string, unknown>);
  const text = textOf(project as unknown as Record<string, unknown>, sourceCues);
  const composition = compositionFacts(project as unknown as Record<string, unknown>);
  const sourceDigest = sha256Identity(
    sourceCues.map(({ lines, startUs, endUs, direction }) => ({
      lines,
      startUs,
      endUs,
      direction,
    })),
  );
  const expectedCaptions = record.captions;
  const ass = captions ? captionAssDocument(composition, expectedCaptions) : null;
  if (
    canonicalJson(record.composition) !== canonicalJson(composition) ||
    record.captions.sourceDigest !== sourceDigest ||
    record.coverage.checkedTextDigest !== hashBytes(Buffer.from(text)) ||
    record.captions.assDigest !== (ass === null ? null : hashBytes(Buffer.from(ass)))
  )
    throw new CommandFailure(
      'RENDER_PREPARATION_INVALID',
      'Frozen composition, caption, or coverage facts are inconsistent with the project.',
    );
  if (renderInputsDigest(project) !== record.renderInputsDigest)
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      'Render inputs changed after preparation. Re-prepare the project.',
    );
  const currentFaces = selectedFaces(current.canonicalFaces, text, title, captions);
  const fontFacts = currentFaces.map((face) => ({
    family: face.family,
    weight: face.weight,
    subset: face.subset,
    length: face.bytes.byteLength,
    sha256: face.sha256,
  }));
  if (
    canonicalJson(fontFacts) !== canonicalJson(record.fonts) ||
    !current.libassProbe ||
    current.ffmpeg.executableSha256 !== record.ffmpeg.executableSha256 ||
    current.ffmpeg.version !== record.ffmpeg.version ||
    (title &&
      (!current.chromium.launchable ||
        current.chromium.version !== record.chromium.version ||
        current.chromium.executableSha256 !== record.chromium.executableSha256)) ||
    (captions &&
      (!current.libassAvailable ||
        !current.libassProbe.usable ||
        canonicalJson(current.ffmpeg.requiredFilters) !==
          canonicalJson(record.ffmpeg.requiredFilters)))
  )
    throw new CommandFailure(
      'RENDER_ENVIRONMENT_DRIFT',
      'Render environment or canonical font bytes changed after preparation. Re-prepare the project.',
    );
  return record;
}
