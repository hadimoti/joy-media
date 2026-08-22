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
    </aside>
  );
}
