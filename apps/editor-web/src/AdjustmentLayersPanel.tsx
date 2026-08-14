import { LayersIcon, PlusIcon, SlidersIcon } from './icons.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

export function AdjustmentLayersPanel({
  targetLabel,
  canCreate,
  onCreate,
}: {
  readonly targetLabel?: string;
  readonly canCreate: boolean;
  readonly onCreate: () => void;
}) {
  return (
    <PanelShell
      title="Adjust"
      iconUrl={panelTabIconUrl('color')}
      className="adjustment-library-panel"
      note={
        canCreate
          ? 'Creates an independent layer. Choose its parent and edit its stack in Inspector.'
          : 'Select a video or picture layer first.'
      }
    >
      <section className="adjustment-library-target" aria-label="Adjustment layer target">
        <span className="adjustment-library-target-icon" aria-hidden="true">
          <LayersIcon />
        </span>
        <span>
          <small>Parent media</small>
          <strong>{targetLabel ?? 'No eligible selection'}</strong>
        </span>
      </section>
      <section className="adjustment-library-card">
        <span className="adjustment-library-card-icon" aria-hidden="true">
          <SlidersIcon />
        </span>
        <div>
          <strong>Adjustment layer</strong>
          <p>One timed controller for effects, filters, and animated corrections.</p>
        </div>
        <button
          type="button"
          className="icon-button icon-button-labeled"
          disabled={!canCreate}
          aria-label="Add adjustment layer"
          onClick={onCreate}
        >
          <PlusIcon />
          Add Adjust
        </button>
      </section>
      <ul className="adjustment-library-rules">
        <li>Lives on its own ADJ timeline lane.</li>
        <li>Targets one video or picture parent without changing source media.</li>
        <li>Effects and keyframes remain editable and undoable.</li>
      </ul>
    </PanelShell>
  );
}
