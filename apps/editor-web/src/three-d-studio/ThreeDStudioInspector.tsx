import type {
  Scene3DCommand,
  Scene3DDocumentV1,
  Scene3DMaterial,
  Scene3DTransform,
} from '@joy-media/scene3d-core';

export function ThreeDStudioInspector({
  document,
  selectedObjectId,
  onCommand,
}: {
  readonly document: Scene3DDocumentV1;
  readonly selectedObjectId?: string;
  readonly onCommand: (command: Scene3DCommand) => void;
}) {
  const object = selectedObjectId === undefined ? undefined : document.objects[selectedObjectId];
  if (object === undefined)
    return (
      <aside className="three-d-studio-inspector">
        <div className="three-d-studio-section-title">Inspector</div>
        <p>Select an object to edit.</p>
      </aside>
    );
  const setTransform = (key: keyof Scene3DTransform, axis: 'x' | 'y' | 'z', value: string) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    onCommand({
      type: 'object.setTransform',
      payload: {
        objectId: object.id,
        transform: { ...object.transform, [key]: { ...object.transform[key], [axis]: number } },
      },
    });
  };
  const setParent = (parentId: string) => {
    onCommand({
      type: 'object.setParent',
      payload: { objectId: object.id, ...(parentId ? { parentId } : {}) },
    });
  };
  const materials = Object.values(document.materials);
  const setCamera = (key: 'fieldOfViewDeg' | 'near' | 'far', value: string) => {
    if (object.camera === undefined) return;
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    onCommand({
      type: 'object.setCamera',
      payload: { objectId: object.id, camera: { ...object.camera, [key]: number } },
    });
  };
  const setLight = (key: 'kind' | 'intensity' | 'color', value: string) => {
    if (object.light === undefined) return;
    const next = key === 'intensity' ? Number(value) : value;
    if (key === 'intensity' && !Number.isFinite(next)) return;
    onCommand({
      type: 'object.setLight',
      payload: {
        objectId: object.id,
        light: { ...object.light, [key]: next } as NonNullable<typeof object.light>,
      },
    });
  };
  return (
    <aside className="three-d-studio-inspector" aria-label="3D inspector">
      <div className="three-d-studio-section-title">Inspector</div>
      <label>
        Name
        <input value={object.name} readOnly />
      </label>
      <label>
        Parent
        <select value={object.parentId ?? ''} onChange={(event) => setParent(event.target.value)}>
          <option value="">Scene root</option>
          {Object.values(document.objects)
            .filter((candidate) => candidate.id !== object.id)
            .map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
        </select>
      </label>
      {(['position', 'rotation', 'scale'] as const).map((key) => (
        <fieldset key={key}>
          <legend>{key}</legend>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <label key={axis}>
              {axis}
              <input
                type="number"
                step="0.1"
                value={object.transform[key][axis]}
                onChange={(event) => setTransform(key, axis, event.target.value)}
              />
            </label>
          ))}
        </fieldset>
      ))}
      <label>
        Material
        <select
          value={object.materialId ?? ''}
          onChange={(event) =>
            onCommand({
              type: 'object.setMaterial',
              payload: {
                objectId: object.id,
                ...(event.target.value ? { materialId: event.target.value } : {}),
              },
            })
          }
        >
          <option value="">Default</option>
          {materials.map((material: Scene3DMaterial) => (
            <option key={material.id} value={material.id}>
              {material.id}
            </option>
          ))}
        </select>
      </label>
      {object.kind === 'camera' && object.camera !== undefined && (
        <fieldset>
          <legend>Camera</legend>
          {(['fieldOfViewDeg', 'near', 'far'] as const).map((key) => (
            <label key={key}>
              {key}
              <input
                type="number"
                step="0.1"
                value={object.camera![key]}
                onChange={(event) => setCamera(key, event.target.value)}
              />
            </label>
          ))}
          <button
            type="button"
            onClick={() =>
              onCommand({ type: 'scene.setActiveCamera', payload: { cameraId: object.id } })
            }
          >
            Use as active camera
          </button>
        </fieldset>
      )}
      {object.kind === 'light' && object.light !== undefined && (
        <fieldset>
          <legend>Light</legend>
          <label>
            Kind
            <select
              value={object.light.kind}
              onChange={(event) => setLight('kind', event.target.value)}
            >
              {(['ambient', 'directional', 'point', 'spot'] as const).map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <label>
            Intensity
            <input
              type="number"
              step="0.1"
              min="0"
              value={object.light.intensity}
              onChange={(event) => setLight('intensity', event.target.value)}
            />
          </label>
          <label>
            Color
            <input
              type="text"
              value={object.light.color}
              onChange={(event) => setLight('color', event.target.value)}
            />
          </label>
        </fieldset>
      )}
    </aside>
  );
}
