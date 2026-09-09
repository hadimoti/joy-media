/**
 * Living Looks panel (R2 / L2 wiring).
 *
 * Lists the built-in Look packs with the same honest availability the R1
 * recipe picker uses, lets the operator bind each pack's semantic slots to real
 * project entities and set its few controls, and runs one Look through the
 * shared staged-preview + approval path (`onRun`). Agent-issued and manual
 * Look runs compile the identical inputs.
 */

import { useMemo, useState, type ReactElement } from 'react';
import type { LookCatalogEntry } from './joy-agent/look-operations.js';
import type { LookControl } from '@joy-media/motion-core';

export interface LivingLooksEntityOption {
  readonly id: string;
  readonly label: string;
  /** 'visual-object' | 'caption-clip' — which slots it can fill. */
  readonly kind: 'visual-object' | 'caption-clip';
}

/**
 * One operator (or user-directed agent) intent. `apply` is a first apply;
 * `update` / `reset` recompile a stored instance; `detach` drops the record and
 * leaves the authored keyframes. The panel and an agent capability emit the
 * identical shape and it flows through one host op (GAP 1b + 5).
 */
export type LivingLooksRunInput =
  | {
      readonly kind: 'apply';
      readonly definitionId: string;
      readonly definitionVersion: number;
      readonly entityBindings: Readonly<Record<string, string>>;
      readonly controlValues: Readonly<Record<string, number | string | boolean>>;
    }
  | {
      readonly kind: 'update';
      readonly instanceId: string;
      readonly nextControlValues: Readonly<Record<string, number | string | boolean>>;
    }
  | { readonly kind: 'reset'; readonly instanceId: string; readonly bindingIds: readonly string[] }
  | { readonly kind: 'detach'; readonly instanceId: string };

/** An applied Look instance, as the panel needs to render + adjust it. */
export interface LivingLooksAppliedView {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly title: string;
  readonly controlValues: Readonly<Record<string, number | string | boolean>>;
  readonly overriddenBindingIds: readonly string[];
  /** A bound visual object was deleted after the Look was applied. */
  readonly orphaned: boolean;
}

export interface LivingLooksPanelProps {
  readonly hidden: boolean;
  readonly catalog: readonly LookCatalogEntry[];
  readonly entities: readonly LivingLooksEntityOption[];
  /** Looks already applied to the active composition. */
  readonly applied?: readonly LivingLooksAppliedView[];
  readonly runningLookId: string | undefined;
  readonly busy: boolean;
  readonly onRun: (input: LivingLooksRunInput) => void;
}

function controlDefault(control: LookControl): number | string | boolean {
  return control.default;
}

/** A single Look control input — shared by the apply form and the adjust rows. */
function LookControlInput(props: {
  readonly control: LookControl;
  readonly value: number | string | boolean;
  readonly onChange: (value: number | string | boolean) => void;
}): ReactElement {
  const { control, value, onChange } = props;
  if (control.kind === 'scalar') {
    return (
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={typeof value === 'number' ? value : control.default}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    );
  }
  if (control.kind === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={typeof value === 'boolean' ? value : control.default}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  const optionList =
    control.kind === 'enum'
      ? control.options
      : control.kind === 'color'
        ? control.palettePairs.map((p) => p.id)
        : control.families;
  return (
    <select
      value={typeof value === 'string' ? value : String(control.default)}
      onChange={(event) => onChange(event.target.value)}
    >
      {optionList.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function AppliedLookRow(props: {
  readonly applied: LivingLooksAppliedView;
  readonly controls: readonly LookControl[];
  readonly busy: boolean;
  readonly onRun: (input: LivingLooksRunInput) => void;
}): ReactElement {
  const { applied, controls, busy, onRun } = props;
  return (
    <li className={`applied-look ${applied.orphaned ? 'is-orphaned' : ''}`}>
      <div className="applied-look-head">
        <strong>{applied.title}</strong>
        <button
          type="button"
          className="applied-look-detach"
          disabled={busy}
          onClick={() => onRun({ kind: 'detach', instanceId: applied.instanceId })}
        >
          Detach
        </button>
      </div>
      {applied.orphaned && (
        <p className="applied-look-orphan">Bound object removed — rebind or detach.</p>
      )}
      {applied.overriddenBindingIds.length > 0 && (
        <button
          type="button"
          className="applied-look-reset"
          disabled={busy}
          onClick={() =>
            onRun({
              kind: 'reset',
              instanceId: applied.instanceId,
              bindingIds: applied.overriddenBindingIds,
            })
          }
        >
          Reset {applied.overriddenBindingIds.length} hand-edited binding(s) to Look control
        </button>
      )}
      <div className="applied-look-controls">
        {controls.map((control) => (
          <label key={control.id} className="applied-look-control">
            <span>{control.label}</span>
            <LookControlInput
              control={control}
              value={applied.controlValues[control.id] ?? control.default}
              onChange={(value) =>
                onRun({
                  kind: 'update',
                  instanceId: applied.instanceId,
                  nextControlValues: { [control.id]: value },
                })
              }
            />
          </label>
        ))}
      </div>
    </li>
  );
}

export function LivingLooksPanel(props: LivingLooksPanelProps): ReactElement {
  const { catalog, entities } = props;
  const [selectedId, setSelectedId] = useState<string | undefined>(
    catalog.find((entry) => entry.available)?.definition.id,
  );
  const [bindings, setBindings] = useState<Record<string, Record<string, string>>>({});
  const [values, setValues] = useState<Record<string, Record<string, number | string | boolean>>>(
    {},
  );

  const selected = useMemo(
    () => catalog.find((entry) => entry.definition.id === selectedId),
    [catalog, selectedId],
  );

  const slotBindings = selectedId === undefined ? {} : (bindings[selectedId] ?? {});
  const controlValues = selectedId === undefined ? {} : (values[selectedId] ?? {});

  const setBinding = (slotId: string, entityId: string): void => {
    if (selectedId === undefined) return;
    setBindings((prev) => ({
      ...prev,
      [selectedId]: { ...(prev[selectedId] ?? {}), [slotId]: entityId },
    }));
  };
  const setValue = (controlId: string, value: number | string | boolean): void => {
    if (selectedId === undefined) return;
    setValues((prev) => ({
      ...prev,
      [selectedId]: { ...(prev[selectedId] ?? {}), [controlId]: value },
    }));
  };

  const requiredUnbound =
    selected === undefined
      ? []
      : selected.definition.slots.filter(
          (slot) => slot.required && (slotBindings[slot.id] ?? '').length === 0,
        );

  const canRun =
    selected !== undefined &&
    selected.available &&
    requiredUnbound.length === 0 &&
    props.runningLookId === undefined &&
    !props.busy;

  return (
    <div className="living-looks" role="region" aria-label="Living Looks" hidden={props.hidden}>
      <p className="living-looks-intro">
        Editable art-directed Looks. Each compiles to ordinary operations and runs through the same
        staged preview and approval as a direct edit.
      </p>

      {(props.applied ?? []).length > 0 && (
        <section className="applied-looks" aria-label="Applied Looks">
          <h3>Applied Looks</h3>
          <ul className="applied-looks-list">
            {(props.applied ?? []).map((applied) => {
              const definition = catalog.find(
                (entry) => entry.definition.id === applied.definitionId,
              )?.definition;
              return (
                <AppliedLookRow
                  key={applied.instanceId}
                  applied={applied}
                  controls={definition?.controls ?? []}
                  busy={props.busy || props.runningLookId !== undefined}
                  onRun={props.onRun}
                />
              );
            })}
          </ul>
        </section>
      )}

      <ul className="living-looks-list">
        {catalog.map((entry) => {
          const missing = [...entry.missingOperationKinds, ...entry.missingFonts];
          const active = entry.definition.id === selectedId;
          return (
            <li
              key={entry.definition.id}
              className={`living-look ${entry.available ? '' : 'is-unavailable'} ${
                active ? 'is-selected' : ''
              }`}
            >
              <button
                type="button"
                className="living-look-select"
                aria-pressed={active}
                disabled={!entry.available}
                onClick={() => setSelectedId(entry.definition.id)}
              >
                <strong>{entry.definition.title}</strong>
                <span>{entry.definition.description}</span>
                {!entry.available && missing.length > 0 && (
                  <span className="living-look-missing">Needs: {missing.join(', ')}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {selected !== undefined && selected.available && (
        <form
          className="living-look-editor"
          aria-label={`${selected.definition.title} controls`}
          onSubmit={(event) => {
            event.preventDefault();
            if (!canRun) return;
            props.onRun({
              kind: 'apply',
              definitionId: selected.definition.id,
              definitionVersion: selected.definition.version,
              // Drop optional slots left on the placeholder — the compiler
              // treats an empty id as unbound, so only send real bindings.
              entityBindings: Object.fromEntries(
                Object.entries(slotBindings).filter(([, entityId]) => entityId.length > 0),
              ),
              controlValues: {
                ...Object.fromEntries(
                  selected.definition.controls.map((c) => [c.id, controlDefault(c)]),
                ),
                ...controlValues,
              },
            });
          }}
        >
          <fieldset className="living-look-slots">
            <legend>Bind slots</legend>
            {selected.definition.slots.map((slot) => {
              const options = entities.filter((entity) =>
                slot.ownerKind === 'caption-clip'
                  ? entity.kind === 'caption-clip'
                  : entity.kind === 'visual-object',
              );
              return (
                <label key={slot.id} className="living-look-slot">
                  <span>
                    {slot.label}
                    {slot.required ? ' *' : ''}
                  </span>
                  <select
                    value={slotBindings[slot.id] ?? ''}
                    onChange={(event) => setBinding(slot.id, event.target.value)}
                  >
                    <option value="">—</option>
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </fieldset>

          <fieldset className="living-look-controls">
            <legend>Controls</legend>
            {selected.definition.controls.map((control) => {
              const current = controlValues[control.id] ?? control.default;
              if (control.kind === 'scalar') {
                return (
                  <label key={control.id} className="living-look-control">
                    <span>{control.label}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={typeof current === 'number' ? current : control.default}
                      onChange={(event) => setValue(control.id, Number(event.target.value))}
                    />
                  </label>
                );
              }
              if (control.kind === 'boolean') {
                return (
                  <label key={control.id} className="living-look-control">
                    <span>{control.label}</span>
                    <input
                      type="checkbox"
                      checked={typeof current === 'boolean' ? current : control.default}
                      onChange={(event) => setValue(control.id, event.target.checked)}
                    />
                  </label>
                );
              }
              const optionList =
                control.kind === 'enum'
                  ? control.options
                  : control.kind === 'color'
                    ? control.palettePairs.map((p) => p.id)
                    : control.families;
              return (
                <label key={control.id} className="living-look-control">
                  <span>{control.label}</span>
                  <select
                    value={typeof current === 'string' ? current : String(control.default)}
                    onChange={(event) => setValue(control.id, event.target.value)}
                  >
                    {optionList.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </fieldset>

          {requiredUnbound.length > 0 && (
            <p className="living-look-hint">
              Bind {requiredUnbound.map((slot) => slot.label).join(', ')} to run this Look.
            </p>
          )}

          <button
            type="submit"
            className="living-look-run"
            disabled={!canRun}
            aria-label={`Run ${selected.definition.title}`}
          >
            {props.runningLookId === selected.definition.id ? 'Running…' : 'Run Look'}
          </button>
        </form>
      )}
    </div>
  );
}
