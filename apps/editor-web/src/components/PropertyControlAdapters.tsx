import { useRef, type ChangeEvent, type KeyboardEvent, type PointerEvent } from 'react';
import {
  TransientPropertyInteraction,
  type PropertyInteractionHost,
} from '../property-interaction.js';

export interface TransientControlAdapter<T> {
  readonly begin: () => void;
  readonly preview: (value: T) => void;
  readonly commit: () => void;
  readonly cancel: () => void;
}

/**
 * Maps a DOM gesture to the shared interaction protocol. It is intentionally
 * value-generic: compound vector/color controls pass their complete snapshot,
 * so a coordinated edit remains one durable undo command.
 */
export function createTransientControlAdapter<T>(
  interaction: TransientPropertyInteraction<T>,
  label: string,
): TransientControlAdapter<T> {
  const begin = () => {
    if (!interaction.active) interaction.begin();
  };

  return {
    begin,
    preview: (value) => {
      begin();
      interaction.update(value);
    },
    commit: () => {
      if (interaction.active) interaction.commit(label);
    },
    cancel: () => {
      if (interaction.active) interaction.cancel();
    },
  };
}

/**
 * React-safe factory for an adapter. Hosts may close over current editor state;
 * the controller always reads the latest host while retaining the gesture's
 * initial snapshot until commit or Escape.
 */
export function useTransientPropertyControl<T>(
  host: PropertyInteractionHost<T>,
  label: string,
): TransientControlAdapter<T> {
  const hostRef = useRef(host);
  const labelRef = useRef(label);
  hostRef.current = host;
  labelRef.current = label;

  const interactionRef = useRef<TransientPropertyInteraction<T> | undefined>(undefined);
  if (interactionRef.current === undefined) {
    interactionRef.current = new TransientPropertyInteraction<T>({
      read: () => hostRef.current.read(),
      preview: (value) => hostRef.current.preview(value),
      restore: (value) => hostRef.current.restore(value),
      commit: (change) => hostRef.current.commit(change),
    });
  }

  const adapterRef = useRef<TransientControlAdapter<T> | undefined>(undefined);
  if (adapterRef.current === undefined) {
    adapterRef.current = createTransientControlAdapter(interactionRef.current, labelRef.current);
  }
  return {
    ...adapterRef.current,
    commit: () => {
      if (interactionRef.current?.active) interactionRef.current.commit(labelRef.current);
    },
  };
}

function cancelOnEscape<T>(event: KeyboardEvent<HTMLElement>, adapter: TransientControlAdapter<T>) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  adapter.cancel();
  event.currentTarget.blur();
}

function commitOnEnter<T>(event: KeyboardEvent<HTMLElement>, adapter: TransientControlAdapter<T>) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  adapter.commit();
  event.currentTarget.blur();
}

export interface NumericPropertyControlProps {
  readonly id: string;
  readonly value: number;
  readonly adapter: TransientControlAdapter<number>;
  readonly ariaLabel: string;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly step?: number | undefined;
  readonly disabled?: boolean | undefined;
}

export function NumericPropertyControl({
  id,
  value,
  adapter,
  ariaLabel,
  min,
  max,
  step,
  disabled = false,
}: NumericPropertyControlProps) {
  const preview = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.currentTarget.valueAsNumber;
    if (Number.isFinite(next)) adapter.preview(next);
  };
  return (
    <input
      id={id}
      className="property-control-input"
      type="number"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onFocus={adapter.begin}
      onChange={preview}
      onBlur={adapter.commit}
      onKeyDown={(event) => {
        cancelOnEscape(event, adapter);
        commitOnEnter(event, adapter);
      }}
    />
  );
}

export interface SliderPropertyControlProps {
  readonly value: number;
  readonly adapter: TransientControlAdapter<number>;
  readonly ariaLabel: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly disabled?: boolean | undefined;
}

export function SliderPropertyControl({
  value,
  adapter,
  ariaLabel,
  min,
  max,
  step,
  disabled = false,
}: SliderPropertyControlProps) {
  const begin = (_event: PointerEvent<HTMLInputElement>) => adapter.begin();
  return (
    <input
      className="property-control-slider"
      type="range"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onFocus={adapter.begin}
      onPointerDown={begin}
      onPointerUp={adapter.commit}
      onPointerCancel={adapter.cancel}
      onChange={(event) => adapter.preview(event.currentTarget.valueAsNumber)}
      onBlur={adapter.commit}
      onKeyDown={(event) => {
        cancelOnEscape(event, adapter);
        commitOnEnter(event, adapter);
      }}
    />
  );
}

export interface ColorPropertyControlProps {
  readonly id: string;
  readonly value: string;
  readonly adapter: TransientControlAdapter<string>;
  readonly ariaLabel: string;
  readonly disabled?: boolean | undefined;
}

export function ColorPropertyControl({
  id,
  value,
  adapter,
  ariaLabel,
  disabled = false,
}: ColorPropertyControlProps) {
  return (
    <input
      id={id}
      className="property-control-color"
      type="color"
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onFocus={adapter.begin}
      onInput={(event) => adapter.preview(event.currentTarget.value)}
      onChange={(event) => {
        adapter.preview(event.currentTarget.value);
        adapter.commit();
      }}
      onBlur={adapter.commit}
      onKeyDown={(event) => cancelOnEscape(event, adapter)}
    />
  );
}

export interface SelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export interface SelectPropertyControlProps<T extends string> {
  readonly id: string;
  readonly value: T;
  readonly options: readonly SelectOption<T>[];
  readonly adapter: TransientControlAdapter<T>;
  readonly ariaLabel: string;
  readonly disabled?: boolean | undefined;
}

export function SelectPropertyControl<T extends string>({
  id,
  value,
  options,
  adapter,
  ariaLabel,
  disabled = false,
}: SelectPropertyControlProps<T>) {
  return (
    <select
      id={id}
      className="property-control-select"
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onFocus={adapter.begin}
      onChange={(event) => adapter.preview(event.currentTarget.value as T)}
      onBlur={adapter.commit}
      onKeyDown={(event) => {
        cancelOnEscape(event, adapter);
        commitOnEnter(event, adapter);
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface SwitchPropertyControlProps {
  readonly checked: boolean;
  readonly adapter: TransientControlAdapter<boolean>;
  readonly ariaLabel: string;
  readonly disabled?: boolean | undefined;
}

export function SwitchPropertyControl({
  checked,
  adapter,
  ariaLabel,
  disabled = false,
}: SwitchPropertyControlProps) {
  return (
    <input
      className="property-control-switch"
      type="checkbox"
      role="switch"
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onFocus={adapter.begin}
      onChange={(event) => adapter.preview(event.currentTarget.checked)}
      onBlur={adapter.commit}
      onKeyDown={(event) => {
        cancelOnEscape(event, adapter);
        commitOnEnter(event, adapter);
      }}
    />
  );
}
