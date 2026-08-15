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
    </PanelShell>
  );
}
