import type { ProjectDiagnostic } from './model.js';

export type P0TemplateId = 'joy.p0.lower-third' | 'joy.p0.title';

export type FontChoice = {
  readonly family: 'Noto Sans Arabic';
  readonly weight: 400 | 700;
};

export type TitlePlacement = {
  readonly xPx: number;
  readonly yPx: number;
  readonly maxWidthPx: number;
  readonly safeInsetPx: number;
};

export type TitleMotion = {
  readonly presetId: 'joy-fade-in' | 'joy-slide-up' | 'hold';
  readonly inUs: number;
  readonly outUs: number;
};

export type TitleLayout = {
  readonly primaryLines: readonly string[];
  readonly secondaryLines: readonly string[];
  readonly fontSizePx: number;
  readonly secondarySizePx: number;
  readonly lineHeightPx: number;
  readonly boxHeightPx: number;
};

export type TitleInstanceV1 = {
  readonly templateId: P0TemplateId;
  readonly templateVersion: 1;
  readonly templateSha256: string;
  readonly compilerVersion: 1;
  readonly objectId: string;
  readonly clipId: string;
  readonly lines: { readonly primary: string; readonly secondary: string };
  readonly font: FontChoice & { readonly sha256: string };
  readonly direction: 'ltr' | 'rtl' | 'auto';
  readonly placement: TitlePlacement;
  readonly motion: TitleMotion;
  readonly layout: TitleLayout;
};

export type ContentInstancesV1 = {
  readonly version: 1;
  readonly instances: Readonly<Record<string, TitleInstanceV1>>;
};

export const CONTENT_TEMPLATES_PLUGIN_KEY = 'joy.contentTemplates';
const CLIP_OBJECTS_PLUGIN_KEY = 'joy.clipObjects';
const DIAGNOSTIC_CODE = 'PROJECT_SCHEMA_CONTENT_TEMPLATE';
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TEMPLATE_IDS = ['joy.p0.lower-third', 'joy.p0.title'] as const;
const MAX_STRING_CODE_POINTS = 512;

type UnknownRecord = Record<string, unknown>;

/** Validate the optional content-template plugin namespace and its project bindings. */
export function validateContentInstances(projectValue: unknown): ProjectDiagnostic[] {
  if (!isRecord(projectValue) || !isRecord(projectValue.pluginData)) return [];
  if (
    !Object.prototype.hasOwnProperty.call(projectValue.pluginData, CONTENT_TEMPLATES_PLUGIN_KEY)
  ) {
    return [];
  }

  const diagnostics: ProjectDiagnostic[] = [];
  const basePath = `pluginData.${CONTENT_TEMPLATES_PLUGIN_KEY}`;
  const raw = projectValue.pluginData[CONTENT_TEMPLATES_PLUGIN_KEY];
  if (!isRecord(raw)) {
    report(diagnostics, 'must be an object', basePath);
    return diagnostics;
  }
  checkKeys(raw, ['version', 'instances'], basePath, diagnostics);
  if (raw.version !== 1) report(diagnostics, 'version must be 1', `${basePath}.version`);
  if (!isRecord(raw.instances)) {
    report(diagnostics, 'instances must be an object', `${basePath}.instances`);
    return diagnostics;
  }

  const root = rootComposition(projectValue);
  const rawClipObjects = projectValue.pluginData[CLIP_OBJECTS_PLUGIN_KEY];
  const clipObjects = isRecord(rawClipObjects) ? rawClipObjects : undefined;
  const seenObjectIds = new Set<string>();
  const seenClipIds = new Set<string>();

  for (const [instanceId, value] of Object.entries(raw.instances)) {
    const path = `${basePath}.instances.${instanceId}`;
    checkStringLength(instanceId, `${basePath}.instances`, diagnostics);
    if (!isRecord(value)) {
      report(diagnostics, 'instance must be an object', path);
      continue;
    }
    checkKeys(
      value,
      [
        'templateId',
        'templateVersion',
        'templateSha256',
        'compilerVersion',
        'objectId',
        'clipId',
        'lines',
        'font',
        'direction',
        'placement',
        'motion',
        'layout',
      ],
      path,
      diagnostics,
    );

    if (
      typeof value.templateId !== 'string' ||
      !(TEMPLATE_IDS as readonly string[]).includes(value.templateId)
    ) {
      report(diagnostics, 'templateId is unsupported', `${path}.templateId`);
    }
    if (value.templateVersion !== 1)
      report(diagnostics, 'templateVersion must be 1', `${path}.templateVersion`);
    if (value.compilerVersion !== 1)
      report(diagnostics, 'compilerVersion must be 1', `${path}.compilerVersion`);
    validateHash(value.templateSha256, `${path}.templateSha256`, diagnostics);

    const objectId = stringField(value.objectId, `${path}.objectId`, diagnostics);
    const clipId = stringField(value.clipId, `${path}.clipId`, diagnostics);
    if (objectId !== undefined) {
      if (objectId !== `object-${instanceId}`)
        report(diagnostics, 'objectId must equal object- plus the instance id', `${path}.objectId`);
      if (seenObjectIds.has(objectId))
        report(diagnostics, 'objectId must be unique across instances', `${path}.objectId`);
      seenObjectIds.add(objectId);
    }
    if (clipId !== undefined) {
      if (clipId !== `clip-${instanceId}`)
        report(diagnostics, 'clipId must equal clip- plus the instance id', `${path}.clipId`);
      if (seenClipIds.has(clipId))
        report(diagnostics, 'clipId must be unique across instances', `${path}.clipId`);
      seenClipIds.add(clipId);
    }

    validateLines(value.lines, `${path}.lines`, diagnostics);
    validateFont(value.font, `${path}.font`, diagnostics);
    if (value.direction !== 'ltr' && value.direction !== 'rtl' && value.direction !== 'auto') {
      report(diagnostics, 'direction must be ltr, rtl, or auto', `${path}.direction`);
    }
    validatePlacement(value.placement, `${path}.placement`, diagnostics);
    const motion = validateMotion(value.motion, `${path}.motion`, diagnostics);
    validateLayout(value.layout, `${path}.layout`, diagnostics);
    validateWrappedText(value.lines, value.layout, path, diagnostics);

    const templateId = typeof value.templateId === 'string' ? value.templateId : undefined;
    const clip = clipId === undefined ? undefined : root?.clips.get(clipId);
    if (clipId !== undefined && clip === undefined) {
      report(
        diagnostics,
        'clipId must name a clip on a visual track of the root composition',
        `${path}.clipId`,
      );
    } else if (clipId !== undefined && root?.transitions.has(clipId)) {
      report(diagnostics, 'clip must not participate in a transition', `${path}.clipId`);
    }
    if (clipObjects === undefined || clipId === undefined || clipObjects[clipId] !== objectId) {
      report(diagnostics, 'joy.clipObjects must bind clipId to objectId', `${path}.clipId`);
    }
    if (objectId !== undefined) {
      const visualObjects = isRecord(projectValue.visualObjects)
        ? projectValue.visualObjects
        : undefined;
      const object = visualObjects?.[objectId];
      if (!isRecord(object) || object.kind !== 'html-scene') {
        report(diagnostics, 'objectId must name an html-scene visual object', `${path}.objectId`);
      } else if (templateId !== undefined && object.scenePackageId !== templateId) {
        report(diagnostics, 'scenePackageId must equal templateId', `${path}.objectId`);
      }
    }
    if (
      clip !== undefined &&
      (typeof clip.durationUs !== 'number' ||
        !Number.isSafeInteger(clip.durationUs) ||
        clip.durationUs < 0)
    ) {
      report(
        diagnostics,
        'referenced clip durationUs must be a non-negative safe integer',
        `${path}.clipId`,
      );
    } else if (
      motion !== undefined &&
      clip !== undefined &&
      motion.inUs + motion.outUs > (clip.durationUs as number)
    ) {
      report(
        diagnostics,
        'motion inUs + outUs must not exceed the clip durationUs',
        `${path}.motion`,
      );
    }
  }
  return diagnostics;
}

function rootComposition(
  project: UnknownRecord,
): { clips: Map<string, UnknownRecord>; transitions: Set<string> } | undefined {
  if (typeof project.rootCompositionId !== 'string' || !isRecord(project.compositions))
    return undefined;
  const composition = project.compositions[project.rootCompositionId];
  if (!isRecord(composition) || !Array.isArray(composition.tracks)) return undefined;
  const clips = new Map<string, UnknownRecord>();
  for (const track of composition.tracks) {
    if (
      !isRecord(track) ||
      track.kind !== 'video' ||
      track.family === 'audio' ||
      !Array.isArray(track.clips)
    )
      continue;
    for (const rawClip of track.clips) {
      if (isRecord(rawClip) && typeof rawClip.id === 'string') clips.set(rawClip.id, rawClip);
    }
  }
  const transitions = new Set<string>();
  if (Array.isArray(composition.transitions)) {
    for (const transition of composition.transitions) {
      if (!isRecord(transition)) continue;
      if (typeof transition.leftClipId === 'string') transitions.add(transition.leftClipId);
      if (typeof transition.rightClipId === 'string') transitions.add(transition.rightClipId);
    }
  }
  return { clips, transitions };
}

function validateLines(value: unknown, path: string, diagnostics: ProjectDiagnostic[]): void {
  if (!isRecord(value)) {
    report(diagnostics, 'lines must be an object', path);
    return;
  }
  checkKeys(value, ['primary', 'secondary'], path, diagnostics);
  for (const key of ['primary', 'secondary'] as const)
    stringField(value[key], `${path}.${key}`, diagnostics);
  if (typeof value.primary === 'string' && value.primary.trim().length === 0) {
    report(diagnostics, 'primary line must not be blank', `${path}.primary`);
  }
}

function validateFont(value: unknown, path: string, diagnostics: ProjectDiagnostic[]): void {
  if (!isRecord(value)) {
    report(diagnostics, 'font must be an object', path);
    return;
  }
  checkKeys(value, ['family', 'weight', 'sha256'], path, diagnostics);
  if (value.family !== 'Noto Sans Arabic')
    report(diagnostics, 'font family must be Noto Sans Arabic', `${path}.family`);
  if (value.weight !== 400 && value.weight !== 700)
    report(diagnostics, 'font weight must be 400 or 700', `${path}.weight`);
  validateHash(value.sha256, `${path}.sha256`, diagnostics);
}

function validatePlacement(value: unknown, path: string, diagnostics: ProjectDiagnostic[]): void {
  if (!isRecord(value)) {
    report(diagnostics, 'placement must be an object', path);
    return;
  }
  checkKeys(value, ['xPx', 'yPx', 'maxWidthPx', 'safeInsetPx'], path, diagnostics);
  const x = pixel(value.xPx, `${path}.xPx`, diagnostics);
  const y = pixel(value.yPx, `${path}.yPx`, diagnostics);
  const width = pixel(value.maxWidthPx, `${path}.maxWidthPx`, diagnostics);
  const inset = pixel(value.safeInsetPx, `${path}.safeInsetPx`, diagnostics);
  if (x !== undefined && (x < 0 || x > 1920))
    report(diagnostics, 'xPx must be in [0, 1920]', `${path}.xPx`);
  if (y !== undefined && (y < 0 || y > 1920))
    report(diagnostics, 'yPx must be in [0, 1920]', `${path}.yPx`);
  if (width !== undefined && (width < 1 || width > 1920))
    report(diagnostics, 'maxWidthPx must be in [1, 1920]', `${path}.maxWidthPx`);
  if (inset !== undefined && (inset < 0 || inset > 200))
    report(diagnostics, 'safeInsetPx must be in [0, 200]', `${path}.safeInsetPx`);
}

function validateMotion(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): { inUs: number; outUs: number } | undefined {
  if (!isRecord(value)) {
    report(diagnostics, 'motion must be an object', path);
    return undefined;
  }
  checkKeys(value, ['presetId', 'inUs', 'outUs'], path, diagnostics);
  if (
    value.presetId !== 'joy-fade-in' &&
    value.presetId !== 'joy-slide-up' &&
    value.presetId !== 'hold'
  ) {
    report(diagnostics, 'presetId is unsupported', `${path}.presetId`);
  }
  const inUs = nonNegativeInteger(value.inUs, `${path}.inUs`, diagnostics);
  const outUs = nonNegativeInteger(value.outUs, `${path}.outUs`, diagnostics);
  return inUs === undefined || outUs === undefined ? undefined : { inUs, outUs };
}

function validateLayout(value: unknown, path: string, diagnostics: ProjectDiagnostic[]): void {
  if (!isRecord(value)) {
    report(diagnostics, 'layout must be an object', path);
    return;
  }
  checkKeys(
    value,
    [
      'primaryLines',
      'secondaryLines',
      'fontSizePx',
      'secondarySizePx',
      'lineHeightPx',
      'boxHeightPx',
    ],
    path,
    diagnostics,
  );
  validateLineArray(value.primaryLines, `${path}.primaryLines`, 2, diagnostics);
  validateLineArray(value.secondaryLines, `${path}.secondaryLines`, 1, diagnostics);
  const fontSize = pixel(value.fontSizePx, `${path}.fontSizePx`, diagnostics);
  const secondarySize = pixel(value.secondarySizePx, `${path}.secondarySizePx`, diagnostics);
  const lineHeight = pixel(value.lineHeightPx, `${path}.lineHeightPx`, diagnostics);
  const boxHeight = pixel(value.boxHeightPx, `${path}.boxHeightPx`, diagnostics);
  if (fontSize !== undefined && (fontSize < 24 || fontSize > 48))
    report(diagnostics, 'fontSizePx must be in [24, 48]', `${path}.fontSizePx`);
  if (secondarySize !== undefined && (secondarySize < 18 || secondarySize > 30))
    report(diagnostics, 'secondarySizePx must be in [18, 30]', `${path}.secondarySizePx`);
  if (
    lineHeight !== undefined &&
    fontSize !== undefined &&
    (lineHeight < fontSize || lineHeight > fontSize * 2)
  ) {
    report(
      diagnostics,
      'lineHeightPx must be between fontSizePx and twice fontSizePx',
      `${path}.lineHeightPx`,
    );
  }
  if (boxHeight !== undefined && boxHeight <= 0)
    report(diagnostics, 'boxHeightPx must be a positive integer', `${path}.boxHeightPx`);
}

/** Wrapped layout lines must reproduce the source text, so a layout cannot silently drop words. */
function validateWrappedText(
  lines: unknown,
  layout: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): void {
  if (!isRecord(lines) || !isRecord(layout)) return;
  const pairs = [
    ['primary', 'primaryLines'],
    ['secondary', 'secondaryLines'],
  ] as const;
  for (const [textKey, linesKey] of pairs) {
    const text = lines[textKey];
    const wrapped = layout[linesKey];
    if (
      typeof text !== 'string' ||
      !Array.isArray(wrapped) ||
      !wrapped.every((line) => typeof line === 'string')
    ) {
      continue;
    }
    if (collapseSpacing(text) !== collapseSpacing(wrapped.join(' '))) {
      report(
        diagnostics,
        `${linesKey} must reproduce the ${textKey} text, with only spacing changed`,
        `${path}.layout.${linesKey}`,
      );
    }
  }
}

function collapseSpacing(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function validateLineArray(
  value: unknown,
  path: string,
  maximum: number,
  diagnostics: ProjectDiagnostic[],
): string[] | undefined {
  if (!Array.isArray(value)) {
    report(diagnostics, 'must be an array of strings', path);
    return undefined;
  }
  if (value.length > maximum) report(diagnostics, `must contain at most ${maximum} lines`, path);
  value.forEach((line, index) => {
    if (
      stringField(line, `${path}.${index}`, diagnostics) !== undefined &&
      (line as string).trim().length === 0
    ) {
      report(diagnostics, 'layout lines must not be blank', `${path}.${index}`);
    }
  });
  return value.filter((line): line is string => typeof line === 'string');
}

function validateHash(value: unknown, path: string, diagnostics: ProjectDiagnostic[]): void {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value))
    report(diagnostics, 'must match sha256:[0-9a-f]{64}', path);
  else checkStringLength(value, path, diagnostics);
}

function pixel(value: unknown, path: string, diagnostics: ProjectDiagnostic[]): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    report(diagnostics, 'must be a safe integer pixel value', path);
    return undefined;
  }
  return value;
}

function nonNegativeInteger(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    report(diagnostics, 'must be a non-negative safe integer microsecond value', path);
    return undefined;
  }
  return value;
}

function stringField(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): string | undefined {
  if (typeof value !== 'string') {
    report(diagnostics, 'must be a string', path);
    return undefined;
  }
  checkStringLength(value, path, diagnostics);
  return value;
}

function checkStringLength(value: string, path: string, diagnostics: ProjectDiagnostic[]): void {
  if (Array.from(value).length > MAX_STRING_CODE_POINTS) {
    report(diagnostics, `must be at most ${MAX_STRING_CODE_POINTS} Unicode code points`, path);
  }
}

function checkKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  path: string,
  diagnostics: ProjectDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) report(diagnostics, `unknown field "${key}"`, `${path}.${key}`);
  }
}

function report(diagnostics: ProjectDiagnostic[], message: string, path: string): void {
  diagnostics.push({ code: DIAGNOSTIC_CODE, message, path });
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
