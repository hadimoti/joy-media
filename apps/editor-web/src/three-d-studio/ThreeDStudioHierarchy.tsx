import type { BrowserAsset } from '../control-plane-client.js';
import type { Scene3DDocumentV1 } from '@joy-media/scene3d-core';

export function ThreeDStudioHierarchy({
  document,
  assets,
  selectedObjectId,
  onSelect,
  onAdd,
  onRemove,
}: {
  readonly document: Scene3DDocumentV1;
  readonly assets: readonly BrowserAsset[];
  readonly selectedObjectId?: string;
  readonly onSelect: (objectId: string) => void;
  readonly onAdd: (object: {
    readonly kind: 'empty' | 'primitive' | 'light' | 'camera' | 'model';
    readonly assetId?: string;
  }) => void;
  readonly onRemove: () => void;
}) {
  const models = assets.filter((asset) => asset.kind === 'model');
  return (
    <aside className="three-d-studio-hierarchy" aria-label="3D scene hierarchy">
      <div className="three-d-studio-section-title">Hierarchy</div>
      <div className="three-d-studio-adds">
        <button type="button" onClick={() => onAdd({ kind: 'empty' })}>
          Empty
        </button>
        <button type="button" onClick={() => onAdd({ kind: 'primitive' })}>
          Box
        </button>
        <button type="button" onClick={() => onAdd({ kind: 'light' })}>
          Light
        </button>
        <button type="button" onClick={() => onAdd({ kind: 'camera' })}>
          Camera
        </button>
        {models.length > 0 && (
          <select
            aria-label="Add registered model"
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) onAdd({ kind: 'model', assetId: event.target.value });
              event.target.value = '';
            }}
          >
            <option value="">Add model…</option>
            {models.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.displayName}
              </option>
            ))}
          </select>
        )}
      </div>
      <ul className="three-d-studio-object-list">
        {Object.values(document.objects).map((object) => (
          <li key={object.id}>
            <button
              type="button"
              className={object.id === selectedObjectId ? 'is-selected' : ''}
              onClick={() => onSelect(object.id)}
            >
              <span aria-hidden>
                {object.kind === 'model'
                  ? '◇'
                  : object.kind === 'camera'
                    ? '◉'
                    : object.kind === 'light'
                      ? '☼'
                      : '□'}
              </span>
              {object.name}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="three-d-studio-danger"
        disabled={selectedObjectId === undefined}
        onClick={onRemove}
      >
        Delete selected
      </button>
    </aside>
  );
}
