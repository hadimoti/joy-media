/**
 * Universal transform evaluation at the render boundary.
 *
 * V2 bindings take precedence over an addressed legacy curve, while existing
 * expressions still win last. The local resolver is injected into the normal
 * parent/camera composition path, so a V2 transform does not lose parenting.
 */
import { projectThroughCamera } from '@joy-media/camera-core';
import {
  parentChain,
  resolveObjectTransformWithExpressions,
  resolveWorldTransform,
  sampleCurve,
  sampleSpatialPath,
} from '@joy-media/motion-core';
import {
  canonicalBindingKey,
  type AnimatablePropertyV1,
  type NormalizedPropertyAnimationsV2,
  type PropertyBindingV2,
  type TimeUs,
  type VisualObjectTransformV1,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import { evaluateFrameProperty, type EvaluatedFrameProperty } from './frame-property-evaluator.js';

const SCALAR_CHANNELS = [
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotationDeg',
  'opacity',
  'positionZ',
] as const;
type ScalarChannel = (typeof SCALAR_CHANNELS)[number];

const POSITION_PROPERTY = 'visual.transform.position';
const SCALE_PROPERTY = 'visual.transform.scale';
const ROTATION_PROPERTY = 'visual.transform.rotation';
const OPACITY_PROPERTY = 'visual.transform.opacity';
const CAMERA_FOV_PROPERTY = 'camera.fieldOfView';

export interface UniversalTransformDiagnostic {
  readonly channel: string;
  readonly message: string;
}

export interface UniversalTransformResolution {
  readonly transform: VisualObjectTransformV1;
  readonly diagnostics: readonly UniversalTransformDiagnostic[];
}

function binding(objectId: string, propertyId: string): PropertyBindingV2 {
  return {
    ownerKind: 'visual-object',
    ownerId: objectId,
    propertyId,
    timeDomain: 'composition',
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function vector(
  value: unknown,
  fallback: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(fallback).map(([key, staticValue]) => [
      key,
      finiteNumber(record[key], staticValue),
    ]),
  );
}

function scalarValue(
  object: VisualObjectV1,
  channel: ScalarChannel,
  timeUs: TimeUs,
  animations: NormalizedPropertyAnimationsV2 | undefined,
): EvaluatedFrameProperty<number> {
  const staticValue = object.transform[channel] ?? 0;
  const curve = object.animations?.[channel as AnimatablePropertyV1];
  return evaluateFrameProperty<number>({
    binding: binding(object.id, channel),
    staticValue,
    ...(animations === undefined ? {} : { animations }),
    ...(curve === undefined ? {} : { legacy: { sample: (time) => sampleCurve(curve, time) } }),
    time: { compositionTimeUs: timeUs },
    normalize: (value) => finiteNumber(value, staticValue),
  });
}

function vectorValue(
  objectId: string,
  propertyId: string,
  staticValue: Readonly<Record<string, number>>,
  timeUs: TimeUs,
  animations: NormalizedPropertyAnimationsV2 | undefined,
): EvaluatedFrameProperty<Readonly<Record<string, number>>> {
  return evaluateFrameProperty<Readonly<Record<string, number>>>({
    binding: binding(objectId, propertyId),
    staticValue,
    ...(animations === undefined ? {} : { animations }),
    time: { compositionTimeUs: timeUs },
    normalize: (value) => vector(value, staticValue),
  });
}

function hasV2(
  animations: NormalizedPropertyAnimationsV2 | undefined,
  objectId: string,
  propertyId: string,
): boolean {
  const key = canonicalBindingKey(binding(objectId, propertyId));
  return animations?.[key] !== undefined;
}

/** Evaluates one object's local transform through V2, legacy, and expressions. */
export function evaluateUniversalObjectTransform(
  object: VisualObjectV1,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
  animations?: NormalizedPropertyAnimationsV2,
): UniversalTransformResolution {
  const expressionResolution = resolveObjectTransformWithExpressions(
    object.id,
    objectsById,
    timeUs,
  );
  const values = Object.fromEntries(
    SCALAR_CHANNELS.map((channel) => [channel, scalarValue(object, channel, timeUs, animations)]),
  ) as Record<ScalarChannel, EvaluatedFrameProperty<number>>;

  const position = vectorValue(
    object.id,
    POSITION_PROPERTY,
    { x: values.x.value, y: values.y.value },
    timeUs,
    animations,
  );
  const scale = vectorValue(
    object.id,
    SCALE_PROPERTY,
    { scaleX: values.scaleX.value, scaleY: values.scaleY.value },
    timeUs,
    animations,
  );
  const rotation = scalarValue(object, 'rotationDeg', timeUs, animations);
  const opacity = scalarValue(object, 'opacity', timeUs, animations);
  const v2Rotation = evaluateFrameProperty<number>({
    binding: binding(object.id, ROTATION_PROPERTY),
    staticValue: rotation.value,
    ...(animations === undefined ? {} : { animations }),
    time: { compositionTimeUs: timeUs },
    normalize: (value) => finiteNumber(value, rotation.value),
  });
  const v2Opacity = evaluateFrameProperty<number>({
    binding: binding(object.id, OPACITY_PROPERTY),
    staticValue: opacity.value,
    ...(animations === undefined ? {} : { animations }),
    time: { compositionTimeUs: timeUs },
    normalize: (value) => finiteNumber(value, opacity.value),
  });

  let x = position.value.x ?? values.x.value;
  let y = position.value.y ?? values.y.value;
  let scaleX = scale.value.scaleX ?? values.scaleX.value;
  let scaleY = scale.value.scaleY ?? values.scaleY.value;
  let rotationDeg = v2Rotation.value;
  let alpha = v2Opacity.value;
  const positionZ =
    expressionResolution.transform.positionZ ??
    (values.positionZ.source === 'static' && object.transform.positionZ === undefined
      ? undefined
      : values.positionZ.value);

  // A legacy spatial path remains the authoritative position source until a
  // V2 position binding is authored. Expressions remain the final override.
  const positionHasV2 =
    position.source === 'v2' || values.x.source === 'v2' || values.y.source === 'v2';
  if (
    object.spatialPath !== undefined &&
    !positionHasV2 &&
    object.expressions?.x === undefined &&
    object.expressions?.y === undefined
  ) {
    const sample = sampleSpatialPath(object.spatialPath.keyframes, timeUs);
    x = sample.x;
    y = sample.y;
  }

  if (object.expressions?.x !== undefined) x = expressionResolution.transform.x;
  if (object.expressions?.y !== undefined) y = expressionResolution.transform.y;
  if (object.expressions?.scaleX !== undefined) scaleX = expressionResolution.transform.scaleX;
  if (object.expressions?.scaleY !== undefined) scaleY = expressionResolution.transform.scaleY;
  if (object.expressions?.rotationDeg !== undefined)
    rotationDeg = expressionResolution.transform.rotationDeg;
  if (object.expressions?.opacity !== undefined) alpha = expressionResolution.transform.opacity;

  return {
    transform: {
      ...object.transform,
      x,
      y,
      scaleX: Math.max(0.001, scaleX),
      scaleY: Math.max(0.001, scaleY),
      rotationDeg,
      opacity: Math.min(1, Math.max(0, alpha)),
      ...(positionZ === undefined ? {} : { positionZ }),
    },
    diagnostics: expressionResolution.diagnostics.map((diagnostic) => ({
      channel: diagnostic.property,
      message: diagnostic.message,
    })),
  };
}

/** Parent-aware companion used by renderers for monitor and export frames. */
export function evaluateUniversalWorldTransform(
  objectId: string,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
  animations?: NormalizedPropertyAnimationsV2,
): UniversalTransformResolution {
  const diagnostics: UniversalTransformDiagnostic[] = [];
  const transform = resolveWorldTransform(objectId, objectsById, timeUs, (object, localTimeUs) => {
    const resolved = evaluateUniversalObjectTransform(object, objectsById, localTimeUs, animations);
    diagnostics.push(...resolved.diagnostics);
    return resolved.transform;
  });
  return { transform, diagnostics };
}

/** Camera-aware render entry point; V2 x/y/scale values remain parent-composed before projection. */
export function evaluateUniversalCameraTransform(
  objectId: string,
  cameraId: string | undefined,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
  compositionHeight: number,
  animations?: NormalizedPropertyAnimationsV2,
): UniversalTransformResolution {
  const world = evaluateUniversalWorldTransform(objectId, objectsById, timeUs, animations);
  if (cameraId === undefined) return world;
  const cameraWorld = evaluateUniversalWorldTransform(cameraId, objectsById, timeUs, animations);
  const cameraObject = objectsById[cameraId];
  if (
    cameraObject === undefined ||
    cameraObject.kind !== 'camera' ||
    cameraObject.camera === undefined
  ) {
    return world;
  }
  const cameraDepth = universalWorldDepth(cameraId, objectsById, timeUs, animations);
  const fieldOfView = evaluateFrameProperty<number>({
    binding: binding(cameraId, CAMERA_FOV_PROPERTY),
    staticValue: cameraObject.camera.fieldOfViewDeg,
    ...(animations === undefined ? {} : { animations }),
    time: { compositionTimeUs: timeUs },
    normalize: (value) =>
      Math.min(170, Math.max(0.001, finiteNumber(value, cameraObject.camera!.fieldOfViewDeg))),
  });
  const projected = projectThroughCamera(
    world.transform,
    universalWorldDepth(objectId, objectsById, timeUs, animations),
    {
      x: cameraWorld.transform.x,
      y: cameraWorld.transform.y,
      z: cameraDepth,
      rollDeg: cameraWorld.transform.rotationDeg,
      fieldOfViewDeg: fieldOfView.value,
    },
    compositionHeight,
  );
  return {
    transform: projected,
    diagnostics: [...world.diagnostics, ...cameraWorld.diagnostics],
  };
}

function universalWorldDepth(
  objectId: string,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
  animations: NormalizedPropertyAnimationsV2 | undefined,
): number {
  const object = objectsById[objectId];
  if (object === undefined) return 0;
  return [object, ...parentChain(objectId, objectsById)].reduce((depth, node) => {
    const local = evaluateUniversalObjectTransform(node, objectsById, timeUs, animations);
    return depth + (local.transform.positionZ ?? 0);
  }, 0);
}

/** True only for the V2 bindings consumed by the transform render slice. */
export function hasUniversalTransformAnimation(
  objectId: string,
  animations: NormalizedPropertyAnimationsV2 | undefined,
): boolean {
  return [
    ...SCALAR_CHANNELS,
    POSITION_PROPERTY,
    SCALE_PROPERTY,
    ROTATION_PROPERTY,
    OPACITY_PROPERTY,
    'positionZ',
  ].some((propertyId) => hasV2(animations, objectId, propertyId));
}
