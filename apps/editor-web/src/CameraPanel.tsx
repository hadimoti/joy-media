/**
 * Camera panel (WP-10.2, ADR-0015): create/select depth-only 2.5D camera
 * objects, edit their position/roll/field-of-view, parent them like any other
 * object, and pick the active camera for the composition. Cameras render
 * nothing and carry no timeline clip, so — unlike the Inspector/Motion panels —
 * this panel keeps its own local selection instead of following the timeline's
 * selected clip. Every edit is a durable command: it undoes/redoes and
 * persists exactly like any other project edit.
 */

import { useState } from 'react';
import type { CompositionV1, VisualObjectV1 } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { parentChain } from '@joy-media/motion-core';
import { CameraUiIcon, PlusIcon } from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

const TABS: readonly PanelTabSpec[] = [
  { id: 'rig', label: 'Rig' },
  { id: 'transform', label: 'Transform' },
];

interface CameraPanelProps {
  readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
  readonly composition: CompositionV1;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}

type CameraTransformField = 'x' | 'y' | 'positionZ' | 'rotationDeg';

const TRANSFORM_FIELDS: readonly { key: CameraTransformField; label: string }[] = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'positionZ', label: 'Depth (Z)' },
  { key: 'rotationDeg', label: 'Roll' },
];

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

export function CameraPanel({ allObjects, composition, onDispatch }: CameraPanelProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState('rig');
  const cameraList = listCameras(allObjects);
  const selected = selectedId !== undefined ? allObjects[selectedId] : undefined;
  const camera = selected?.kind === 'camera' ? selected : undefined;

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

  const setTransformField = (key: CameraTransformField, value: number) => {
    if (camera === undefined || !Number.isFinite(value)) return;
    onDispatch({
      label: `Set camera ${key}`,
      commands: [
        { type: 'object.setTransformProperty', payload: { objectId: camera.id, key, value } },
      ],
    });
  };

  const setFieldOfView = (value: number) => {
    if (camera === undefined || !Number.isFinite(value)) return;
    onDispatch({
      label: 'Set field of view',
      commands: [
        {
          type: 'camera.setFieldOfView',
          payload: { objectId: camera.id, fieldOfViewDeg: value },
        },
      ],
    });
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
      {...(transformInactive ? { note: 'Create or select a camera to edit it.' } : {})}
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
              No cameras yet. Add one to move the composition in 2.5D.
            </p>
          )}
        </>
      )}

      {tab === 'transform' && (
        <>
          <div className="camera-controls">
            {TRANSFORM_FIELDS.map((field) => (
              <label key={field.key} className="camera-field">
                {field.label}
                <input
                  type="number"
                  value={camera?.transform[field.key] ?? 0}
                  disabled={noCamera}
                  onChange={(event) =>
                    setTransformField(field.key, event.currentTarget.valueAsNumber)
                  }
                />
              </label>
            ))}
            <label className="camera-field">
              Field of view
              <input
                type="number"
                min={1}
                max={170}
                value={camera?.camera?.fieldOfViewDeg ?? 54}
                disabled={noCamera}
                onChange={(event) => setFieldOfView(event.currentTarget.valueAsNumber)}
              />
            </label>
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
            Depth (Z) moves the camera along its view axis; layers with a deeper{' '}
            <code>positionZ</code> shrink toward the horizon and shift less under a pan — the
            parallax effect (§20.3, ADR-0015). This camera only affects rendering once it's the
            active camera above.
          </p>
        </>
      )}
    </PanelShell>
  );
}
