import {
  useId,
  useState,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from 'react';
import { PlusIcon, StarFilledIcon, StarIcon } from './icons.js';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.js';

/**
 * A preview is a node, or a function of `isActive`: true while the pointer or keyboard
 * focus is on the card and the system does not ask for reduced motion.
 */
export type LibraryCardPreview = ReactNode | ((isActive: boolean) => ReactNode);

export function LibraryCard({
  id,
  name,
  description,
  preview,
  isFavorite,
  onToggleFavorite,
  onAdd,
  addAriaLabel,
  disabled = false,
  disabledTitle,
  active = false,
  linked = false,
  badges,
  status,
  extraActions,
  className,
  title,
  ariaDescribedBy,
  ariaKeyShortcuts,
  onPointerDown,
  onDoubleClick,
  onKeyDown,
}: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly preview: LibraryCardPreview;
  readonly isFavorite: boolean;
  readonly onToggleFavorite: () => void;
  readonly onAdd: () => void;
  readonly addAriaLabel?: string;
  readonly disabled?: boolean;
  readonly disabledTitle?: string;
  readonly active?: boolean;
  readonly linked?: boolean;
  readonly badges?: ReactNode;
  readonly status?: ReactNode;
  readonly extraActions?: ReactNode;
  readonly className?: string;
  readonly title?: string;
  readonly ariaDescribedBy?: string;
  readonly ariaKeyShortcuts?: string;
  readonly onPointerDown?: PointerEventHandler<HTMLElement>;
  readonly onDoubleClick?: React.MouseEventHandler<HTMLElement>;
  readonly onKeyDown?: KeyboardEventHandler<HTMLElement>;
}) {
  const [previewActive, setPreviewActive] = useState(false);
  const nameId = useId();
  const reducedMotion = usePrefersReducedMotion();
  const previewContent =
    typeof preview === 'function' ? preview(previewActive && !reducedMotion) : preview;
  const classes = [
    'library-card',
    className,
    disabled ? 'is-unavailable' : undefined,
    active ? 'is-active' : undefined,
    linked ? 'is-linked' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  const deactivatePreview = () => setPreviewActive(false);

  return (
    <article
      className={classes}
      data-library-card="true"
      data-library-id={id}
      data-library-linked={linked ? 'true' : undefined}
      aria-labelledby={nameId}
      aria-describedby={ariaDescribedBy}
      aria-keyshortcuts={ariaKeyShortcuts}
      tabIndex={onKeyDown === undefined ? undefined : 0}
      title={title}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setPreviewActive(true)}
      onMouseLeave={deactivatePreview}
      onFocusCapture={() => setPreviewActive(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget))
          deactivatePreview();
      }}
    >
      <div className="library-card-preview">{previewContent}</div>
      <div className="library-card-content">
        <div className="library-card-copy">
          <strong id={nameId} className="library-card-name">
            {name}
          </strong>
          <span className="library-card-description">{description}</span>
        </div>
        {badges !== undefined && <div className="library-card-badges">{badges}</div>}
        {status !== undefined && <div className="library-card-status">{status}</div>}
        <div className="library-card-actions">
          <button
            type="button"
            className="icon-button library-card-favorite"
            data-release-observer-favorite="true"
            aria-label={isFavorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
            aria-pressed={isFavorite}
            title={isFavorite ? 'Remove favorite' : 'Add favorite'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite();
            }}
          >
            {isFavorite ? <StarFilledIcon /> : <StarIcon />}
          </button>
          <button
            type="button"
            className="library-card-add"
            aria-label={addAriaLabel ?? `Add ${name}`}
            title={disabledTitle ?? `Add ${name}`}
            aria-describedby={ariaDescribedBy}
            disabled={disabled}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onAdd();
            }}
          >
            <PlusIcon />
          </button>
          {extraActions}
        </div>
      </div>
    </article>
  );
}
