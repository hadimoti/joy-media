/**
 * Camera panel (WP-10.2, ADR-0015): create/select depth-only 2.5D camera
 * objects, edit their position/roll/field-of-view, parent them like any other
 * object, and pick the active camera for the composition. Cameras render
 * nothing and carry no timeline clip, so — unlike the Inspector/Motion panels —
 * this panel keeps its own local selection instead of following the timeline's
 * selected clip. Every edit is a durable command: it undoes/redoes and
 * persists exactly like any other project edit.
 */

import { useEffect, useState } from 'react';
import {
  canonicalBindingKey,
  type AnimationCurveV1,
  type CompositionV1,
  type JoyProjectV1,
  type PropertyBindingV2,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { parentChain, sampleCurve } from '@joy-media/motion-core';
import { CameraUiIcon, PlusIcon } from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import {
  NumericPropertyControl,
  useTransientPropertyControl,
} from './components/PropertyControlAdapters.js';
import { PropertyRow, type PropertyAnimationState } from './components/PropertyRow.js';

const TABS: readonly PanelTabSpec[] = [
  { id: 'rig', label: 'Rig' },
  { id: 'transform', label: 'Transform' },
];

interface CameraPanelProps {
  readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
  readonly composition: CompositionV1;
  readonly project?: Pick<JoyProjectV1, 'propertyAnimations'> | undefined;
  readonly playheadUs?: number;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}

type CameraTransformField = 'x' | 'y' | 'positionZ' | 'rotationDeg';

const TRANSFORM_FIELDS: readonly { key: CameraTransformField; label: string }[] = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'positionZ', label: 'Depth (Z)' },
  { key: 'rotationDeg', label: 'Roll' },
];

type CameraAnimatedProperty = CameraTransformField | 'camera.fieldOfView';
type CameraObject = VisualObjectV1 & { readonly kind: 'camera' };

interface CameraNumberRowProps {
  readonly camera: CameraObject | undefined;
  readonly property: CameraAnimatedProperty;
  readonly label: string;
  readonly value: number;
  readonly defaultValue: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly project?: Pick<JoyProjectV1, 'propertyAnimations'> | undefined;
  readonly playheadUs: number;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}

function cameraBinding(cameraId: string, property: CameraAnimatedProperty): PropertyBindingV2 {
  return {
    ownerKind: 'visual-object',
    ownerId: cameraId,
    propertyId: property,
    timeDomain: 'composition',
  };
}

function scalarCurve(
  project: Pick<JoyProjectV1, 'propertyAnimations'> | undefined,
  camera: CameraObject | undefined,
  binding: PropertyBindingV2,
  property: CameraAnimatedProperty,
): AnimationCurveV1 | undefined {
  const universal = project?.propertyAnimations?.[canonicalBindingKey(binding)]?.value;
  if (universal?.kind === 'scalar') return universal.curve;
  if (camera === undefined || property === 'camera.fieldOfView') return undefined;
  return camera.animations?.[property];
}

function CameraNumberRow({
  camera,
  property,
  label,
  value,
  defaultValue,
  min,
  max,
  step = 1,
  project,
  playheadUs,
  onDispatch,
}: CameraNumberRowProps) {
  const disabled = camera === undefined;
  const binding = camera === undefined ? undefined : cameraBinding(camera.id, property);
  const curve = binding === undefined ? undefined : scalarCurve(project, camera, binding, property);
  const resolvedValue = curve === undefined ? value : sampleCurve(curve, playheadUs);
  const [previewValue, setPreviewValue] = useState(resolvedValue);
  useEffect(() => setPreviewValue(resolvedValue), [resolvedValue]);

  const commitValue = (next: number) => {
    if (camera === undefined || binding === undefined || !Number.isFinite(next)) return;
    if (curve !== undefined) {
      onDispatch({
        label: `Set ${label} keyframe`,
        commands: [
          {
            type: 'propertyAnimation.setKey',
            payload: {
              binding,
              key: {
                kind: 'scalar',
                keyframe: { timeUs: playheadUs, value: next, interpolation: 'linear' },
              },
            },
          },
        ],
      });
      return;
    }
    onDispatch({
      label: `Set camera ${label}`,
      commands: [
        property === 'camera.fieldOfView'
          ? {
              type: 'camera.setFieldOfView',
              payload: { objectId: camera.id, fieldOfViewDeg: next },
            }
          : {
              type: 'object.setTransformProperty',
              payload: { objectId: camera.id, key: property, value: next },
            },
      ],
    });
  };

  const adapter = useTransientPropertyControl(
    {
      read: () => previewValue,
      preview: setPreviewValue,
      restore: setPreviewValue,
      commit: ({ next }) => commitValue(next),
    },
    `Set camera ${label}`,
  );

  const keyed = curve?.keyframes.some((key) => key.timeUs === playheadUs) === true;
  const animationState: PropertyAnimationState = keyed
    ? 'keyed'
    : curve === undefined
      ? 'none'
      : 'between';
  const toggleAnimation = () => {
    if (camera === undefined || binding === undefined) return;
    if (keyed) {
      onDispatch({
        label: `Remove ${label} keyframe`,
        commands: [
          { type: 'propertyAnimation.removeKey', payload: { binding, timeUs: playheadUs } },
        ],
      });
      return;
    }
    onDispatch({
      label: `Add ${label} keyframe`,
      commands: [
        curve === undefined
          ? {
              type: 'propertyAnimation.replace',
              payload: {
                binding,
                value: {
                  kind: 'scalar',
                  curve: {
                    keyframes: [
                      { timeUs: playheadUs, value: previewValue, interpolation: 'linear' },
                    ],
                  },
                },
              },
            }
          : {
              type: 'propertyAnimation.setKey',
              payload: {
                binding,
                key: {
                  kind: 'scalar',
                  keyframe: { timeUs: playheadUs, value: previewValue, interpolation: 'linear' },
                },
              },
            },
      ],
    });
  };

  return (
    <PropertyRow
      label={label}
      controlId={`camera-${camera?.id ?? 'none'}-${property}`}
      value={previewValue.toFixed(2)}
      disabled={disabled}
      onReset={() => {
        setPreviewValue(defaultValue);
        commitValue(defaultValue);
      }}
      onToggleAnimation={toggleAnimation}
      animationState={animationState}
    >
      <NumericPropertyControl
        id={`camera-${camera?.id ?? 'none'}-${property}`}
        value={previewValue}
        adapter={adapter}
        ariaLabel={label}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
      />
    </PropertyRow>
  );
}

function listCameras(
  allObjects: Readonly<Record<string, VisualObjectV1>>,
): readonly VisualObjectV1[] {
  return Object.values(allObjects)
    .filter((object) => object.kind === 'camera')
    .sort((left, right) => left.id.localeCompare(right.id));
}

function nextCameraId(allObjects: Readonly<Record<string, VisualObjectV1>>): string {
  let index = 1;
  while (allObjects[`camera-${index}`] !== undefined) index += 1;
  return `camera-${index}`;
}

export function CameraPanel({
  allObjects,
  composition,
  project,
  playheadUs = 0,
  onDispatch,
}: CameraPanelProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState('rig');
  const cameraList = listCameras(allObjects);
  const selected = selectedId !== undefined ? allObjects[selectedId] : undefined;
  const camera: CameraObject | undefined =
    selected?.kind === 'camera' ? (selected as CameraObject) : undefined;

  const createCamera = () => {
    const id = nextCameraId(allObjects);
    const object: VisualObjectV1 = {
      id,
      kind: 'camera',
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        positionZ: -800,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
      camera: { fieldOfViewDeg: 54 },
    };
    onDispatch({
      label: `Create ${id}`,
      commands: [{ type: 'camera.create', payload: { object } }],
    });
    setSelectedId(id);
  };

  const setParent = (parentId: string) => {
    if (camera === undefined) return;
    onDispatch({
      label: 'Set camera parent',
      commands: [
        {
          type: 'object.setParent',
          payload: parentId === '' ? { objectId: camera.id } : { objectId: camera.id, parentId },
        },
      ],
    });
  };

  const setActiveCamera = (cameraId: string) => {
    onDispatch({
      label: cameraId === '' ? 'Clear active camera' : 'Set active camera',
      commands: [
        {
          type: 'composition.setActiveCamera',
          payload:
            cameraId === ''
              ? { compositionId: composition.id }
              : { compositionId: composition.id, cameraId },
        },
      ],
    });
  };

  const parentCandidates =
    camera === undefined
      ? []
      : Object.values(allObjects).filter(
          (candidate) =>
            candidate.id !== camera.id &&
            !parentChain(candidate.id, allObjects).some((ancestor) => ancestor.id === camera.id),
        );

  // §3c: the Transform tab keeps its fields on screen with no camera selected;
  // they render disabled rather than collapsing to "create or select a camera".
  const noCamera = camera === undefined;
  const transformInactive = tab === 'transform' && noCamera;

  return (
    <PanelShell
      title="Camera"
      iconUrl={panelTabIconUrl('camera')}
      className="camera-panel"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      inactive={transformInactive}
      {...(transformInactive ? { note: 'Create or select a camera to edit.' } : {})}
      actions={
        <button
          type="button"
          className="icon-button"
          aria-label="Create camera"
          title="Create camera"
          data-guide="Create camera"
          onClick={createCamera}
        >
          <PlusIcon />
        </button>
      }
    >
      {tab === 'rig' && (
        <>
          <label className="camera-field">
            Camera
            <select
              value={selectedId ?? ''}
              onChange={(event) =>
                setSelectedId(event.target.value === '' ? undefined : event.target.value)
              }
            >
              <option value="">(select a camera)</option>
              {cameraList.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          </label>

          <label className="camera-field">
            Active camera on {composition.name}
            <select
              value={composition.activeCameraId ?? ''}
              onChange={(event) => setActiveCamera(event.target.value)}
            >
              <option value="">(none — no camera, plain 2D)</option>
              {cameraList.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          </label>

          {cameraList.length === 0 && (
            <p className="empty-hint">
              <CameraUiIcon />
              <br />
              No cameras yet. Add a camera to move the composition in 2.5D space.
            </p>
          )}
        </>
      )}

      {tab === 'transform' && (
        <>
          <div className="camera-controls">
            {TRANSFORM_FIELDS.map((field) => (
              <CameraNumberRow
                key={field.key}
                camera={camera}
                property={field.key}
                label={field.label}
                value={camera?.transform[field.key] ?? 0}
                defaultValue={field.key === 'positionZ' ? -800 : 0}
                step={field.key === 'rotationDeg' ? 0.1 : 1}
                project={project}
                playheadUs={playheadUs}
                onDispatch={onDispatch}
              />
            ))}
            <CameraNumberRow
              camera={camera}
              property="camera.fieldOfView"
              label="Field of view"
              value={camera?.camera?.fieldOfViewDeg ?? 54}
              defaultValue={54}
              min={1}
              max={170}
              step={0.1}
              project={project}
              playheadUs={playheadUs}
              onDispatch={onDispatch}
            />
            <label className="camera-field">
              Parent
              <select
                value={camera?.parentId ?? ''}
                disabled={noCamera}
                onChange={(event) => setParent(event.target.value)}
              >
                <option value="">(none)</option>
                {parentCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.id}
                    {candidate.kind === 'null' ? ' (null)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="camera-hint">
            Depth <bdi>(Z)</bdi> moves the camera along the view axis; layers with{' '}
            <code>positionZ</code> farther back shrink toward the horizon and move less when panning
            — the parallax effect <bdi>(§20.3, ADR-0015)</bdi>. This camera only affects render when
            selected as the active camera above.
          </p>
        </>
      )}
    </PanelShell>
  );
}
