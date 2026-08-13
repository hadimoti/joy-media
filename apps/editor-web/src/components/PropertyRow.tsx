import type { ReactNode } from 'react';
import {
  KeyframeActiveIcon,
  KeyframeBetweenIcon,
  KeyframeNoneIcon,
  KeyNextIcon,
  KeyPrevIcon,
} from '../icons.js';

export type PropertyAnimationState = 'none' | 'between' | 'keyed';

export interface PropertyRowProps {
  /** A concise, persistent property name. */
  readonly label: string;
  /** Connects the name to the primary editable control when one exists. */
  readonly controlId?: string | undefined;
  /** The control or formatted read-only value. */
  readonly children: ReactNode;
  /** Optional secondary value, unit, or state displayed beside the label. */
  readonly value?: ReactNode;
  /** A multi-selection has different values for this property. */
  readonly mixed?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  /** A short validation or evaluation failure. */
  readonly error?: string | undefined;
  readonly onReset?: (() => void) | undefined;
  readonly onToggleAnimation?: (() => void) | undefined;
  readonly animationState?: PropertyAnimationState | undefined;
  readonly onPreviousKeyframe?: (() => void) | undefined;
  readonly onNextKeyframe?: (() => void) | undefined;
  readonly onOpenGraph?: (() => void) | undefined;
  /** Use for coordinate and compound rows where the value belongs below the name. */
  readonly layout?: 'compact' | 'two-line' | undefined;
}

function StopwatchIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="9" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 6.5V9l2 1.25M6.5 2.5h3M8 2.5v2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none">
      <path d="M12.5 6.5A5 5 0 1 0 13 9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.5 2.75v3.75H8.75" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none">
      <path
        d="M2.5 13.5h11M2.5 2.5v11M3.5 11l3-3 2.25 1.75L13 5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="6.5" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8.75" cy="9.75" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function AnimationStateIcon({ state }: { readonly state: PropertyAnimationState }) {
  if (state === 'keyed') return <KeyframeActiveIcon />;
  if (state === 'between') return <KeyframeBetweenIcon />;
  return <KeyframeNoneIcon />;
}

/**
 * Shared shell for every property that can sensibly animate. It intentionally
 * owns only semantics and layout: WP34-15 supplies the typed controls and the
 * transient command bridge, while a property owner supplies its actual value.
 */
export function PropertyRow({
  label,
  controlId,
  children,
  value,
  mixed = false,
  disabled = false,
  error,
  onReset,
  onToggleAnimation,
  animationState = 'none',
  onPreviousKeyframe,
  onNextKeyframe,
  onOpenGraph,
  layout = 'compact',
}: PropertyRowProps) {
  const descriptionId = controlId === undefined ? undefined : `${controlId}-description`;
  const animationLabel =
    animationState === 'keyed'
      ? `Remove ${label} keyframe at playhead`
      : `Add ${label} keyframe at playhead`;

  return (
    <div
      className={`property-row property-row-${layout}${mixed ? ' is-mixed' : ''}${disabled ? ' is-disabled' : ''}${error !== undefined ? ' has-error' : ''}`}
      data-property-row={label}
    >
      <div className="property-row-heading">
        <label className="property-row-label" htmlFor={controlId}>
          {label}
        </label>
        {mixed && <span className="property-row-mixed">Mixed</span>}
        {value !== undefined && <span className="property-row-value">{value}</span>}
      </div>
      <div className="property-row-control" aria-describedby={descriptionId}>
        {children}
      </div>
      <div className="property-row-actions" role="group" aria-label={`${label} animation controls`}>
        {onReset !== undefined && (
          <button
            type="button"
            className="property-row-action"
            aria-label={`Reset ${label}`}
            title={`Reset ${label}`}
            disabled={disabled}
            onClick={onReset}
          >
            <ResetIcon />
          </button>
        )}
        {onToggleAnimation !== undefined && (
          <button
            type="button"
            className={`property-row-action property-row-stopwatch is-${animationState}`}
            aria-label={animationLabel}
            aria-pressed={animationState === 'keyed'}
            title={animationLabel}
            disabled={disabled}
            onClick={onToggleAnimation}
          >
            <StopwatchIcon />
            <span className="property-row-key-state" aria-hidden="true">
              <AnimationStateIcon state={animationState} />
            </span>
          </button>
        )}
        {onPreviousKeyframe !== undefined && (
          <button
            type="button"
            className="property-row-action"
            aria-label={`Previous ${label} keyframe`}
            title={`Previous ${label} keyframe`}
            disabled={disabled}
            onClick={onPreviousKeyframe}
          >
            <KeyPrevIcon />
          </button>
        )}
        {onNextKeyframe !== undefined && (
          <button
            type="button"
            className="property-row-action"
            aria-label={`Next ${label} keyframe`}
            title={`Next ${label} keyframe`}
            disabled={disabled}
            onClick={onNextKeyframe}
          >
            <KeyNextIcon />
          </button>
        )}
        {onOpenGraph !== undefined && (
          <button
            type="button"
            className="property-row-action"
            aria-label={`Open ${label} in Graph Editor`}
            title={`Open ${label} in Graph Editor`}
            disabled={disabled}
            onClick={onOpenGraph}
          >
            <GraphIcon />
          </button>
        )}
      </div>
      {(mixed || error !== undefined) && (
        <p
          id={descriptionId}
          className="property-row-description"
          aria-live={error !== undefined ? 'polite' : undefined}
        >
          {error ?? 'Selected items have different values.'}
        </p>
      )}
    </div>
  );
}
