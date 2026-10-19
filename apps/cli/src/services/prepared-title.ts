import {
  CONTENT_TEMPLATES_PLUGIN_KEY,
  normalizeUniversalTimeline,
  validateJoyProjectV1,
  type TitleInstanceV1,
  type TitleMotion,
  type TitlePlacement,
} from '@joy-media/project-schema';
import {
  compileTitleInstance,
  createTimelineElementBindingPlacement,
  type TextMeasure,
} from '@joy-media/motion-core';
import { CommandFailure, type CliProjectDocument } from '../utils/project-loader.js';
import type { PreparedOperation } from './prepared-edit.js';

export type { TextMeasure };

let titleTextMeasurer: TextMeasure | undefined;
export function setTitleTextMeasurer(measure: TextMeasure | undefined): void {
  titleTextMeasurer = measure;
}
export function getTitleTextMeasurer(): TextMeasure | undefined {
  return titleTextMeasurer;
}
type TitleOperation = PreparedOperation & {
  readonly op: 'instantiateTemplate' | 'updateTemplateText';
};
type UnknownRecord = Record<string, unknown>;
interface TitleTrack extends UnknownRecord {
  id: string;
  kind: string;
  clips: UnknownRecord[];
}
const FONT_SHA: Record<number, string> = {
  400: 'sha256:9a7c99eccfc3845950358733520688959bfa77ea14e6ef3b0a5efe3a8d52d28b',
  700: 'sha256:b2b3ca0a17a734e33dd39b599faff30e6683f0df14cf3426a5015b22e1f28ca3',
};
function fail(code: string, message: string): never {
  throw new CommandFailure(code, message);
}
function requireTitleTextMeasurer(): TextMeasure {
  const measurer = getTitleTextMeasurer();
  if (!measurer)
    fail(
      'SETUP_REQUIRED',
      'Title text measurement needs a Chromium browser; set JOY_CHROMIUM_PATH',
    );
  return measurer;
}
const record = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const recordArray = (value: unknown): value is UnknownRecord[] =>
  Array.isArray(value) && value.every(record);
const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const safeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
const stringArray = (value: unknown): value is string[] => {
  if (!Array.isArray(value)) return false;
  const items: unknown[] = value;
  return items.every((item: unknown) => typeof item === 'string');
};

function pluginNamespace(project: unknown): UnknownRecord {
  if (!record(project) || !record(project.pluginData)) return {};
  return project.pluginData;
}

/** True when the clip id is derived from an instance in the content-template namespace. */
export function isTitleManagedClip(project: unknown, clipId: string): boolean {
  const namespace = pluginNamespace(project)[CONTENT_TEMPLATES_PLUGIN_KEY];
  if (!record(namespace) || !record(namespace.instances)) return false;
  return Object.keys(namespace.instances).some((instanceId) => clipId === `clip-${instanceId}`);
}

function exact(value: UnknownRecord, keys: readonly string[], id: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    fail('PLAN_INVALID_OPERATION', `Operation "${id}" contains unsupported fields.`);
}

function isTitleInstance(value: unknown): value is TitleInstanceV1 {
  if (!record(value) || !record(value.lines) || !record(value.font)) return false;
  if (!record(value.placement) || !record(value.motion) || !record(value.layout)) return false;
  const placement = value.placement;
  const motion = value.motion;
  const layout = value.layout;
  const primaryLines: unknown = layout.primaryLines;
  const secondaryLines: unknown = layout.secondaryLines;
  return (
    (value.templateId === 'joy.p0.lower-third' || value.templateId === 'joy.p0.title') &&
    value.templateVersion === 1 &&
    typeof value.templateSha256 === 'string' &&
    value.compilerVersion === 1 &&
    typeof value.objectId === 'string' &&
    typeof value.clipId === 'string' &&
    typeof value.lines.primary === 'string' &&
    typeof value.lines.secondary === 'string' &&
    value.font.family === 'Noto Sans Arabic' &&
    (value.font.weight === 400 || value.font.weight === 700) &&
    typeof value.font.sha256 === 'string' &&
    (value.direction === 'ltr' || value.direction === 'rtl' || value.direction === 'auto') &&
    ['xPx', 'yPx', 'maxWidthPx', 'safeInsetPx'].every((key) => safeInteger(placement[key])) &&
    (motion.presetId === 'joy-fade-in' ||
      motion.presetId === 'joy-slide-up' ||
      motion.presetId === 'hold') &&
    safeInteger(motion.inUs) &&
    safeInteger(motion.outUs) &&
    stringArray(primaryLines) &&
    stringArray(secondaryLines) &&
    ['fontSizePx', 'secondarySizePx', 'lineHeightPx', 'boxHeightPx'].every((key) =>
      safeInteger(layout[key]),
    )
  );
}

function root(project: CliProjectDocument): { comp: UnknownRecord; tracks: TitleTrack[] } {
  const comp: unknown = project.compositions[project.rootCompositionId];
  if (!record(comp) || !Array.isArray(comp.tracks))
    fail('PROJECT_FILE_INVALID', 'Project has no root composition.');
  const rawTracks: unknown[] = comp.tracks;
  const tracks: TitleTrack[] = [];
  for (const rawTrack of rawTracks) {
    if (!record(rawTrack)) fail('PROJECT_FILE_INVALID', 'Project has an invalid root track.');
    const rawClips: unknown = rawTrack.clips;
    if (!Array.isArray(rawClips))
      fail('PROJECT_FILE_INVALID', 'Project has an invalid root track.');
    const clipValues: unknown[] = rawClips;
    for (const rawClip of clipValues) {
      if (!record(rawClip)) fail('PROJECT_FILE_INVALID', 'Project has an invalid root clip.');
    }
    if (!recordArray(rawClips)) fail('PROJECT_FILE_INVALID', 'Project has an invalid root clip.');
    if (typeof rawTrack.id !== 'string' || typeof rawTrack.kind !== 'string')
      fail('PROJECT_FILE_INVALID', 'Project has an invalid root track.');
    tracks.push({ ...rawTrack, id: rawTrack.id, kind: rawTrack.kind, clips: rawClips });
  }
  return { comp, tracks };
}

function titleInstanceRecords(project: unknown): UnknownRecord {
  const namespace = pluginNamespace(project)[CONTENT_TEMPLATES_PLUGIN_KEY];
  if (!record(namespace) || !record(namespace.instances)) return {};
  return namespace.instances;
}

function instances(project: CliProjectDocument): Record<string, TitleInstanceV1> {
  const raw = titleInstanceRecords(project);
  const result: Record<string, TitleInstanceV1> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (isTitleInstance(value)) result[id] = value;
  }
  return result;
}

function finiteRange(op: PreparedOperation, key: string, min: number, max: number): number {
  const value = op[key];
  if (!safeInteger(value)) fail('RANGE_ERROR', `${key} must be a safe integer.`);
  if (value < min || value > max) fail('RANGE_ERROR', `${key} must be between ${min} and ${max}.`);
  return value;
}

function parseLines(value: unknown, patch: boolean): { primary: string; secondary: string } {
  if (!record(value)) fail('PLAN_INVALID_OPERATION', 'lines must be an object.');
  if (
    Object.keys(value).some((key) => key !== 'primary' && key !== 'secondary') ||
    (patch && Object.keys(value).length === 0)
  )
    fail('PLAN_INVALID_OPERATION', 'lines must be a non-empty primary/secondary patch.');
  if (!patch && (!Object.hasOwn(value, 'primary') || !Object.hasOwn(value, 'secondary')))
    fail('PLAN_INVALID_OPERATION', 'instantiateTemplate lines require primary and secondary.');
  for (const text of Object.values(value)) {
    if (typeof text !== 'string' || Array.from(text).length > 512)
      fail('RANGE_ERROR', 'Text must be a string of at most 512 Unicode code points.');
  }
  const primary = value.primary;
  const secondary = value.secondary;
  return {
    primary: typeof primary === 'string' ? primary : '',
    secondary: typeof secondary === 'string' ? secondary : '',
  };
}

function ensureProjectLimits(project: CliProjectDocument): void {
  const { comp } = root(project);
  const width = comp.width;
  const height = comp.height;
  const frameRate = comp.frameRate;
  const durationUs = comp.durationUs;
  if (
    !safeInteger(width) ||
    !safeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 1920 ||
    height > 1920 ||
    !record(frameRate) ||
    !safeInteger(frameRate.num) ||
    !safeInteger(frameRate.den) ||
    frameRate.num < 1 ||
    frameRate.den < 1 ||
    frameRate.num > 60 * frameRate.den ||
    !safeInteger(durationUs) ||
    durationUs > 60_000_000
  )
    fail(
      'RANGE_ERROR',
      'Title operations require a composition up to 60 seconds, 1920x1920 and 60 fps.',
    );
}

function trackAndConflict(
  project: CliProjectDocument,
  instanceId: string,
  trackId: string,
  startUs: number,
  durationUs: number,
): void {
  const { tracks } = root(project);
  const currentInstances = titleInstanceRecords(project);
  const clipId = `clip-${instanceId}`;
  const objectId = `object-${instanceId}`;
  const clipExists = Object.values(project.compositions).some((composition) => {
    if (!record(composition) || !Array.isArray(composition.tracks)) return false;
    return composition.tracks.some((rawTrack) => {
      if (!record(rawTrack) || !Array.isArray(rawTrack.clips)) return false;
      return rawTrack.clips.some((rawClip) => record(rawClip) && rawClip.id === clipId);
    });
  });
  if (Object.hasOwn(currentInstances, instanceId) || project.visualObjects[objectId] || clipExists)
    fail('ID_CONFLICT', `Title ids for "${instanceId}" already exist.`);
  const track = tracks.find((candidate) => candidate.id === trackId);
  if (!track) fail('TRACK_NOT_FOUND', `Track "${trackId}" not found.`);
  if (track.kind !== 'video' || track.family === 'audio' || track.family === 'caption')
    fail('TRACK_KIND_MISMATCH', `Track "${trackId}" is not visual.`);
  if (track.enabled === false || track.locked === true)
    fail('TRACK_LOCKED', `Track "${trackId}" is unavailable.`);
  const overlap = track.clips.find((clip) => {
    const clipStart = clip.startUs;
    const clipDuration = clip.durationUs;
    return (
      safeInteger(clipStart) &&
      safeInteger(clipDuration) &&
      startUs < clipStart + clipDuration &&
      clipStart < startUs + durationUs
    );
  });
  if (overlap)
    fail('CLIP_OVERLAP', `Title overlaps clip "${String(overlap.id)}" on track "${trackId}".`);
  if (Object.keys(currentInstances).length >= 8)
    fail('SLICE_LIMIT', 'A project can contain at most 8 title instances.');
}

function applyFrozen(project: CliProjectDocument, op: TitleOperation): CliProjectDocument {
  if (!isTitleInstance(op.resolved))
    fail('PLAN_INVALID_OPERATION', 'Title operation is missing frozen resolved data.');
  const instance = op.resolved;
  const next: UnknownRecord = structuredClone(project) as unknown as UnknownRecord;
  const nextProject = next as unknown as CliProjectDocument;
  const { tracks } = root(nextProject);
  const compositionId = nextProject.rootCompositionId;
  const trackValue = op.trackId ?? op['resolvedTrackId'];
  const trackId = str(trackValue) ? trackValue : '';
  const startValue = op.startUs ?? op['resolvedStartUs'];
  const durationValue = op.durationUs ?? op['resolvedDurationUs'];
  if (op.op === 'instantiateTemplate') {
    const instanceId = op.instanceId;
    if (!str(instanceId))
      fail('PLAN_INVALID_OPERATION', 'Frozen title operation requires an instanceId.');
    if (!safeInteger(startValue) || !safeInteger(durationValue))
      fail('PLAN_INVALID_OPERATION', 'Frozen title operation requires integer timing fields.');
    const track = tracks.find((candidate) => candidate.id === trackId);
    if (!track) fail('TRACK_NOT_FOUND', `Track "${trackId}" not found.`);
    track.clips.push({
      id: instance.clipId,
      kind: track.kind,
      startUs: startValue,
      durationUs: durationValue,
    });
    const visualObjects = record(next.visualObjects) ? next.visualObjects : {};
    next.visualObjects = {
      ...visualObjects,
      [instance.objectId]: {
        id: instance.objectId,
        kind: 'html-scene',
        scenePackageId: instance.templateId,
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotationDeg: 0,
          opacity: 1,
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      },
    };
    const currentInstances = titleInstanceRecords(nextProject);
    const namespace = pluginNamespace(nextProject);
    next['pluginData'] = {
      ...namespace,
      [CONTENT_TEMPLATES_PLUGIN_KEY]: {
        version: 1,
        instances: { ...currentInstances, [instanceId]: instance },
      },
    };
    const updatedNamespace = pluginNamespace(nextProject);
    const rawBindings = updatedNamespace['joy.clipObjects'];
    next['pluginData'] = {
      ...updatedNamespace,
      'joy.clipObjects': {
        ...(record(rawBindings) ? rawBindings : {}),
        [instance.clipId]: instance.objectId,
      },
    };
    const normalized = normalizeUniversalTimeline(next as never);
    const element = createTimelineElementBindingPlacement({
      clipId: instance.clipId,
      compositionId,
      trackId,
      elementKind: 'html-scene',
      startUs: startValue,
      durationUs: durationValue,
      source: { kind: 'object', id: instance.objectId },
    });
    const items = normalized.document.items.filter((item) => item.id !== element.id);
    const order =
      items
        .filter((item) => item.compositionId === compositionId && item.trackId === trackId)
        .reduce((maximum, item) => Math.max(maximum, item.withinTrackOrder), -1) + 1;
    next['universalTimeline'] = {
      schemaVersion: normalized.document.schemaVersion,
      items: [...items, { ...element, withinTrackOrder: order }],
    };
  } else {
    const currentInstances = titleInstanceRecords(nextProject);
    const id = op.instanceId;
    if (!str(id) || !isTitleInstance(currentInstances[id]))
      fail('TEMPLATE_NOT_FOUND', `Title instance "${String(id)}" not found.`);
    const namespace = pluginNamespace(nextProject);
    next['pluginData'] = {
      ...namespace,
      [CONTENT_TEMPLATES_PLUGIN_KEY]: {
        version: 1,
        instances: { ...currentInstances, [id]: instance },
      },
    };
  }
  return nextProject;
}

export function isTitleOperation(op: PreparedOperation): boolean {
  return op.op === 'instantiateTemplate' || op.op === 'updateTemplateText';
}

/** Resolve title layout during prepare, then write only the frozen result during apply. */
export function applyPreparedTitleOperation(
  project: CliProjectDocument,
  operation: PreparedOperation,
  prepare: boolean,
): { project: CliProjectDocument; operation: PreparedOperation } {
  if (!isTitleOperation(operation))
    fail(
      'PLAN_UNSUPPORTED_OPERATION',
      `Operation "${operation.op}" is not supported by prepared edits.`,
    );
  const op = operation as TitleOperation;
  if (prepare && !getTitleTextMeasurer())
    fail(
      'SETUP_REQUIRED',
      'Title text measurement needs a Chromium browser; set JOY_CHROMIUM_PATH',
    );
  ensureProjectLimits(project);
  let normalized: PreparedOperation;
  if (op.op === 'instantiateTemplate') {
    exact(
      op,
      [
        'id',
        'op',
        'instanceId',
        'templateId',
        'trackId',
        'lines',
        'font',
        'direction',
        'startUs',
        'durationUs',
        'placement',
        'motion',
        ...(prepare ? [] : ['resolved']),
      ],
      op.id,
    );
    if (!prepare) return { project: applyFrozen(project, op), operation: op };
    const instanceId = op.instanceId;
    const trackId = op.trackId;
    if (!str(instanceId) || !str(trackId))
      fail('PLAN_INVALID_OPERATION', 'instanceId and trackId are required.');
    if (Array.from(instanceId).length > 505)
      fail('RANGE_ERROR', 'instanceId is too long for derived object and clip ids.');
    const startUs = finiteRange(op, 'startUs', 0, 60_000_000);
    const durationUs = finiteRange(op, 'durationUs', 1_000, 60_000_000);
    const { comp } = root(project);
    const compositionDurationUs = comp.durationUs;
    if (
      !safeInteger(compositionDurationUs) ||
      startUs + durationUs > 60_000_000 ||
      startUs + durationUs > compositionDurationUs
    )
      fail('RANGE_ERROR', 'Title timing must fit within the composition duration.');
    if (!record(op.font) || !record(op.placement) || !record(op.motion))
      fail('PLAN_INVALID_OPERATION', 'font, placement and motion must have valid fields.');
    exact(op.font, ['family', 'weight'], op.id);
    exact(op.placement, ['xPx', 'yPx', 'maxWidthPx', 'safeInsetPx'], op.id);
    exact(op.motion, ['presetId', 'inUs', 'outUs'], op.id);
    const fontFamily = op.font.family;
    const fontWeight = op.font.weight;
    if (fontFamily !== 'Noto Sans Arabic' || (fontWeight !== 400 && fontWeight !== 700))
      fail('FONT_UNAVAILABLE', 'font family or weight is unsupported.');
    const placementValues = op.placement;
    if (
      !safeInteger(placementValues.xPx) ||
      !safeInteger(placementValues.yPx) ||
      !safeInteger(placementValues.maxWidthPx) ||
      !safeInteger(placementValues.safeInsetPx) ||
      Object.keys(placementValues).length !== 4
    )
      fail(
        'PLAN_INVALID_OPERATION',
        'placement requires integer values for all documented fields.',
      );
    const placement: TitlePlacement = {
      xPx: placementValues.xPx,
      yPx: placementValues.yPx,
      maxWidthPx: placementValues.maxWidthPx,
      safeInsetPx: placementValues.safeInsetPx,
    };
    if (
      placement.xPx < 0 ||
      placement.xPx > 1920 ||
      placement.yPx < 0 ||
      placement.yPx > 1920 ||
      placement.maxWidthPx < 1 ||
      placement.maxWidthPx > 1920 ||
      placement.safeInsetPx < 0 ||
      placement.safeInsetPx > 200
    )
      fail('RANGE_ERROR', 'placement values are outside supported pixel ranges.');
    const motionValue = op.motion;
    const presetId = motionValue.presetId;
    const inUs = motionValue.inUs;
    const outUs = motionValue.outUs;
    if (
      (presetId !== 'joy-fade-in' && presetId !== 'joy-slide-up' && presetId !== 'hold') ||
      !safeInteger(inUs) ||
      !safeInteger(outUs)
    )
      fail('PLAN_INVALID_OPERATION', 'motion requires a supported preset and integer windows.');
    const motion: TitleMotion = { presetId, inUs, outUs };
    if (inUs < 0 || outUs < 0 || inUs + outUs > durationUs)
      fail('RANGE_ERROR', 'Motion windows must fit within clip duration.');
    const text = parseLines(op.lines, false);
    if (!text.primary.trim()) fail('PLAN_INVALID_OPERATION', 'Primary text must not be blank.');
    const direction = op.direction;
    if (direction !== 'ltr' && direction !== 'rtl' && direction !== 'auto')
      fail('PLAN_INVALID_OPERATION', 'direction must be ltr, rtl, or auto.');
    const templateId = op.templateId;
    if (templateId !== 'joy.p0.lower-third' && templateId !== 'joy.p0.title')
      fail('TEMPLATE_UNSUPPORTED', 'templateId is unsupported.');
    trackAndConflict(project, instanceId, trackId, startUs, durationUs);
    const frameWidth = comp.width;
    const frameHeight = comp.height;
    if (!safeInteger(frameWidth) || !safeInteger(frameHeight))
      fail('RANGE_ERROR', 'Title operations require integer composition dimensions.');
    const result = compileTitleInstance(
      {
        instanceId,
        templateId,
        clipId: `clip-${instanceId}`,
        objectId: `object-${instanceId}`,
        lines: text,
        direction,
        font: { family: fontFamily, weight: fontWeight },
        fontSha256: FONT_SHA[fontWeight] ?? '',
        placement,
        motion,
        clipDurationUs: durationUs,
        frame: { widthPx: frameWidth, heightPx: frameHeight },
      },
      requireTitleTextMeasurer(),
    );
    if (!result.ok) fail(result.code, result.message);
    normalized = { ...op, startUs, durationUs, resolved: result.instance };
  } else {
    exact(op, ['id', 'op', 'instanceId', 'lines', ...(prepare ? [] : ['resolved'])], op.id);
    const id = op.instanceId;
    if (!str(id)) fail('TEMPLATE_NOT_FOUND', `Title instance "${String(id)}" not found.`);
    const original = instances(project)[id];
    if (!original) fail('TEMPLATE_NOT_FOUND', `Title instance "${String(id)}" not found.`);
    if (!prepare) return { project: applyFrozen(project, op), operation: op };
    const patch = parseLines(op.lines, true);
    if (!record(op.lines)) fail('PLAN_INVALID_OPERATION', 'lines must be an object.');
    const updatedLines = {
      primary: Object.hasOwn(op.lines, 'primary') ? patch.primary : original.lines.primary,
      secondary: Object.hasOwn(op.lines, 'secondary') ? patch.secondary : original.lines.secondary,
    };
    if (!updatedLines.primary.trim())
      fail('PLAN_INVALID_OPERATION', 'Primary text must not be blank.');
    const { comp, tracks } = root(project);
    const clip = tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === original.clipId);
    if (!clip || !safeInteger(clip.durationUs) || !safeInteger(clip.startUs))
      fail('RANGE_ERROR', 'Title timing must fit within the composition duration.');
    const durationUs = clip.durationUs;
    const startUs = clip.startUs;
    if (
      durationUs < 1_000 ||
      startUs < 0 ||
      !safeInteger(comp.durationUs) ||
      startUs + durationUs > comp.durationUs ||
      startUs + durationUs > 60_000_000
    )
      fail('RANGE_ERROR', 'Title timing must fit within the composition duration.');
    if (!safeInteger(comp.width) || !safeInteger(comp.height))
      fail('RANGE_ERROR', 'Title operations require integer composition dimensions.');
    const result = compileTitleInstance(
      {
        instanceId: id,
        templateId: original.templateId,
        clipId: original.clipId,
        objectId: original.objectId,
        lines: updatedLines,
        direction: original.direction,
        font: { family: original.font.family, weight: original.font.weight },
        fontSha256: original.font.sha256,
        placement: original.placement,
        motion: original.motion,
        clipDurationUs: durationUs,
        frame: { widthPx: comp.width, heightPx: comp.height },
      },
      requireTitleTextMeasurer(),
    );
    if (!result.ok) fail(result.code, result.message);
    normalized = { ...op, resolved: result.instance };
  }
  return { project: applyFrozen(project, normalized as TitleOperation), operation: normalized };
}

export function validateFrozenTitleOutput(project: CliProjectDocument): void {
  // The v1 body validator is shared by later additive schema versions; normalize only its version
  // discriminator so the body and content-template namespace receive the same validation.
  const diagnostics = validateJoyProjectV1({ ...project, schemaVersion: 1 });
  if (diagnostics.length)
    fail(
      'PROJECT_VALIDATION_FAILED',
      `Frozen title output failed project validation: ${diagnostics[0]!.message}`,
    );
}
