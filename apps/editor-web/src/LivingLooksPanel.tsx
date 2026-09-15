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
import type { LookAudioBakeInput, LookControl } from '@joy-media/motion-core';

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
      /**
       * Pre-baked audio-reactive keyframe tracks (R2 / L4, GAP 2). When present
       * the baked keys supersede the slider drive on those bindings.
       */
      readonly audioBakes?: readonly LookAudioBakeInput[];
    }
  | {
      readonly kind: 'update';
      readonly instanceId: string;
      /** Omit to change only bindings; omit both for a no-op recompile. */
      readonly nextControlValues?: Readonly<Record<string, number | string | boolean>>;
      /** An agent may rebind slots (e.g. after an object was replaced). */
      readonly nextEntityBindings?: Readonly<Record<string, string>>;
      /** Re-bake audio-reactive tracks for this instance (GAP 2). */
      readonly audioBakes?: readonly LookAudioBakeInput[];
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
  /**
   * Ask the JOY agent to apply / adjust / reset / detach a Look in words. The
   * agent drives the same `look_*` tools; the result is a staged change the
   * operator approves through the same approval card as a manual run (GAP 5).
   * Absent when no structured-tool model is configured.
   */
  readonly onAgentRun?: (prompt: string) => void;
  readonly agentBusy?: boolean;
  /**
   * Bake the composition's audio beat onto this Look's keyframe bindings
   * (R2 / GAP 2), then run it. Absent when the composition has no audio track.
   */
  readonly onBakeFromAudio?: (
    request: Extract<LivingLooksRunInput, { kind: 'apply' | 'update' }>,
  ) => void;
  /** Toggle the sibling Joy Code activity history without stealing the Looks viewport. */
  readonly activityOpen?: boolean;
  readonly onToggleActivity?: () => void;
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
  readonly bakeable: boolean;
  readonly onRun: (input: LivingLooksRunInput) => void;
  readonly onBakeFromAudio?: (
    request: Extract<LivingLooksRunInput, { kind: 'apply' | 'update' }>,
  ) => void;
}): ReactElement {
  const { applied, controls, busy, bakeable, onRun, onBakeFromAudio } = props;
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
      {bakeable && onBakeFromAudio !== undefined && (
        <button
          type="button"
          className="applied-look-bake-audio"
          disabled={busy}
          onClick={() => onBakeFromAudio({ kind: 'update', instanceId: applied.instanceId })}
        >
          Bake motion from composition audio
        </button>
      )}
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
  type LooksTab = 'browse' | 'configure' | 'applied';
  const [selectedId, setSelectedId] = useState<string | undefined>(
    catalog.find((entry) => entry.available)?.definition.id,
  );
  const [activeTab, setActiveTab] = useState<LooksTab>('browse');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState('');
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

  const selectLook = (definitionId: string): void => {
    setSelectedId(definitionId);
    setControlsOpen(false);
    setActiveTab('configure');
  };

  const renderAppliedLooks = (): ReactElement => (
    <section className="applied-looks" aria-label="Applied Looks">
      <div className="living-looks-section-heading">
        <div>
          <span className="living-looks-kicker">Applied</span>
          <h3>Applied Looks</h3>
        </div>
        <span className="living-looks-count">{(props.applied ?? []).length}</span>
      </div>
      {(props.applied ?? []).length === 0 ? (
        <p className="living-looks-empty">Applied Looks will appear here after approval.</p>
      ) : (
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
                bakeable={definition?.bindingTargets.some((t) => t.channel === 'keyframe') === true}
                onRun={props.onRun}
                {...(props.onBakeFromAudio === undefined
                  ? {}
                  : { onBakeFromAudio: props.onBakeFromAudio })}
              />
            );
          })}
        </ul>
      )}
    </section>
  );

  const renderBrowse = (): ReactElement => (
    <section
      id="living-looks-browse"
      className="living-looks-tab-panel"
      role="tabpanel"
      aria-labelledby="living-looks-tab-browse"
    >
      <p className="living-looks-intro">
        Editable art-directed Looks. Choose a pack to configure its bindings and controls, then run
        it through the same staged preview and approval as a direct edit.
      </p>

      {props.onAgentRun !== undefined && (
        <form
          className="living-looks-agent"
          aria-label="Ask the agent to work with Looks"
          onSubmit={(event) => {
            event.preventDefault();
            const prompt = agentPrompt.trim();
            if (prompt.length === 0 || props.agentBusy === true || props.busy) return;
            props.onAgentRun?.(prompt);
            setAgentPrompt('');
          }}
        >
          <label htmlFor="living-looks-agent-prompt">Ask JOY to work with a Look</label>
          <textarea
            id="living-looks-agent-prompt"
            className="living-looks-agent-prompt"
            rows={2}
            placeholder="e.g. apply Editorial Clean to the headline, then soften the entrance"
            value={agentPrompt}
            disabled={props.agentBusy === true || props.busy}
            onChange={(event) => setAgentPrompt(event.target.value)}
          />
          <button
            type="submit"
            className="living-looks-agent-run"
            disabled={agentPrompt.trim().length === 0 || props.agentBusy === true || props.busy}
          >
            {props.agentBusy === true ? 'JOY is working…' : 'Ask JOY'}
          </button>
        </form>
      )}

      <ul className="living-looks-list" aria-label="Look packs">
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
                onClick={() => selectLook(entry.definition.id)}
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
    </section>
  );

  const renderConfigure = (): ReactElement => (
    <section
      id="living-looks-configure"
      className="living-looks-tab-panel living-looks-configure"
      role="tabpanel"
      aria-labelledby="living-looks-tab-configure"
    >
      {selected === undefined || !selected.available ? (
        <p className="living-looks-empty">Choose an available Look from Browse to configure it.</p>
      ) : (
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
          <div className="living-look-configure-header">
            <button
              type="button"
              className="living-look-back"
              onClick={() => setActiveTab('browse')}
            >
              ← Browse Looks
            </button>
            <strong>{selected.definition.title}</strong>
          </div>

          <details className="living-look-accordion" open>
            <summary>Bind slots</summary>
            <fieldset className="living-look-slots">
              <legend className="sr-only">Bind slots</legend>
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
          </details>

          <details className="living-look-accordion" open={controlsOpen}>
            <summary
              onClick={(event) => {
                event.preventDefault();
                setControlsOpen((open) => !open);
              }}
            >
              Controls
            </summary>
            <fieldset className="living-look-controls">
              <legend className="sr-only">Controls</legend>
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
          </details>

          {requiredUnbound.length > 0 && (
            <p className="living-look-hint">
              Bind {requiredUnbound.map((slot) => slot.label).join(', ')} to run this Look.
            </p>
          )}

          <div className="living-look-editor-footer">
            <button
              type="submit"
              className="living-look-run"
              disabled={!canRun}
              aria-label={`Run ${selected.definition.title}`}
            >
              {props.runningLookId === selected.definition.id ? 'Running…' : 'Run Look'}
            </button>

            {props.onBakeFromAudio !== undefined &&
              selected.definition.bindingTargets.some((t) => t.channel === 'keyframe') && (
                <button
                  type="button"
                  className="living-look-bake-audio"
                  disabled={!canRun}
                  onClick={() =>
                    props.onBakeFromAudio?.({
                      kind: 'apply',
                      definitionId: selected.definition.id,
                      definitionVersion: selected.definition.version,
                      entityBindings: Object.fromEntries(
                        Object.entries(slotBindings).filter(([, entityId]) => entityId.length > 0),
                      ),
                      controlValues: {
                        ...Object.fromEntries(
                          selected.definition.controls.map((c) => [c.id, controlDefault(c)]),
                        ),
                        ...controlValues,
                      },
                    })
                  }
                >
                  Run with motion baked from composition audio
                </button>
              )}
          </div>
        </form>
      )}
    </section>
  );

  return (
    <div className="living-looks" role="region" aria-label="Living Looks" hidden={props.hidden}>
      <div className="living-looks-header">
        <div className="living-looks-title-row">
          <div>
            <span className="living-looks-kicker">Joy Code</span>
            <h2>Living Looks</h2>
          </div>
          {props.onToggleActivity !== undefined && (
            <button
              type="button"
              className="living-looks-activity"
              aria-expanded={props.activityOpen === true}
              onClick={props.onToggleActivity}
            >
              Activity
              {props.activityOpen === true ? ' (hide)' : ''}
            </button>
          )}
        </div>
        <div className="living-looks-tabs" role="tablist" aria-label="Living Looks sections">
          {(['browse', 'configure', 'applied'] as const).map((tab, index, tabs) => (
            <button
              key={tab}
              id={`living-looks-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`living-looks-${tab}`}
              tabIndex={activeTab === tab ? 0 : -1}
              onClick={() => setActiveTab(tab)}
              onKeyDown={(event) => {
                const direction =
                  event.key === 'ArrowRight' || event.key === 'ArrowDown'
                    ? 1
                    : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                      ? -1
                      : event.key === 'Home'
                        ? -index
                        : event.key === 'End'
                          ? tabs.length - 1 - index
                          : 0;
                if (direction === 0) return;
                event.preventDefault();
                const nextIndex = (index + direction + tabs.length) % tabs.length;
                const nextTab = tabs[nextIndex]!;
                setActiveTab(nextTab);
                document.getElementById(`living-looks-tab-${nextTab}`)?.focus();
              }}
            >
              {tab[0]!.toUpperCase() + tab.slice(1)}
              {tab === 'applied' && (props.applied ?? []).length > 0
                ? ` (${(props.applied ?? []).length})`
                : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="living-looks-viewport">
        {activeTab === 'browse' && renderBrowse()}
        {activeTab === 'configure' && renderConfigure()}
        {activeTab === 'applied' && renderAppliedLooks()}
      </div>
    </div>
  );
}
