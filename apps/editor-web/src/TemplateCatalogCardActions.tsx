import { PlusIcon, SaveIcon, TrashIcon } from './icons.js';

export function TemplateCatalogCardActions({
  label,
  isMine,
  onApply,
  onSave,
  onDelete,
}: {
  readonly label: string;
  readonly isMine: boolean;
  readonly onApply: () => void;
  readonly onSave: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="icon-button template-card-apply"
        aria-label={`Apply ${label}`}
        title={`Apply ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          onApply();
        }}
      >
        <PlusIcon />
      </button>
      {isMine ? (
        <button
          type="button"
          className="icon-button template-card-delete"
          aria-label={`Delete ${label}`}
          title="Delete template"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <TrashIcon />
        </button>
      ) : (
        <button
          type="button"
          className="icon-button template-card-save"
          aria-label={`Save ${label} to My Templates`}
          title="Save to My Templates"
          onClick={(event) => {
            event.stopPropagation();
            onSave();
          }}
        >
          <SaveIcon />
        </button>
      )}
    </>
  );
}
