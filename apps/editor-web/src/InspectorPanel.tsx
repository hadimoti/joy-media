/**
 * Inspector with keyframe and expression controls (WP-04.1, WP-10.4). Each
 * numeric transform channel gets a stopwatch toggle that adds/removes a
 * keyframe at the playhead, and an "ƒx" toggle that reveals a restricted
 * expression (§20.3, ADR-0015) overriding the channel entirely while present.
 * Every edit is a durable command, so keyframes and expressions undo/redo and
 * persist exactly like any other project edit. A channel with a failing
 * expression falls back to its curve/static value and shows the diagnostic
 * inline — it never breaks the rest of the Inspector.
 */

import { useState } from 'react';
import type { AnimatablePropertyV1, VisualObjectV1 } from '@joy-media/project-schema';
import type { NumericTransformProperty, VisualObjectTransaction } from '@joy-media/property-system';
import { VISUAL_INSPECTOR } from '@joy-media/property-system';
import {
  hasKeyframeAt,
  removeKeyframe,
  resolveObjectTransformWithExpressions,
  sampleCurve,
  setKeyframe,
} from '@joy-media/motion-core';

interface InspectorPanelProps {
  readonly object: VisualObjectV1 | undefined;
  readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
  readonly playheadUs: number;
  /**
   * `positionZ` (ADR-0015) is not shown in this Inspector yet — it lands with
   * the dedicated Camera panel (WP-10.2) — so it's excluded here too.
   */
  readonly onSetStatic: (
    objectId: string,
    key: Exclude<NumericTransformProperty, 'positionZ'>,
    value: number,
  ) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}

const NUMERIC_PROPERTIES = VISUAL_INSPECTOR.filter((property) => property.kind === 'number');

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function InspectorPanel({
  object,
  allObjects,
  playheadUs,
  onSetStatic,
  onDispatch,
}: InspectorPanelProps) {
  const [editingExpression, setEditingExpression] = useState<AnimatablePropertyV1 | undefined>(
    undefined,
  );
  const [draftSource, setDraftSource] = useState('');
  const [commitError, setCommitError] = useState<string | undefined>(undefined);

  if (object === undefined) return <p>Select a visual clip to edit.</p>;
  const timeUs = Math.max(0, Math.round(playheadUs));
  const { transform: resolved, diagnostics } = resolveObjectTransformWithExpressions(
    object.id,
    allObjects,
    timeUs,
  );

  const replaceChannel = (
    property: AnimatablePropertyV1,
    curve: ReturnType<typeof setKeyframe> | undefined,
  ) => {
    onDispatch({
      label: curve === undefined ? `Clear ${property} keyframes` : `Keyframe ${property}`,
      commands: [
        {
          type: 'object.replaceAnimation',
          payload:
            curve === undefined
              ? { objectId: object.id, property }
              : { objectId: object.id, property, curve },
        },
      ],
    });
  };

  const toggleKeyframe = (property: AnimatablePropertyV1, value: number) => {
    const curve = object.animations?.[property];
    if (curve !== undefined && hasKeyframeAt(curve, timeUs)) {
      replaceChannel(property, removeKeyframe(curve, timeUs));
      return;
    }
    replaceChannel(property, setKeyframe(curve, { timeUs, value, interpolation: 'linear' }));
  };

  const commitExpression = (property: AnimatablePropertyV1, source: string) => {
    const trimmed = source.trim();
    try {
      onDispatch({
        label: trimmed === '' ? `Clear ${property} expression` : `Set ${property} expression`,
        commands: [
          {
            type: 'object.setExpression',
            payload:
              trimmed === ''
                ? { objectId: object.id, property }
                : { objectId: object.id, property, source: trimmed },
          },
        ],
      });
      setEditingExpression(undefined);
      setCommitError(undefined);
    } catch (error) {
      // object.setExpression validates by throwing (like curve validation) — catch it here
      // so a malformed expression shows an inline error instead of an uncaught exception.
      setCommitError(error instanceof Error ? error.message : String(error));
    }
  };

  const openExpressionEditor = (property: AnimatablePropertyV1) => {
    setDraftSource(object.expressions?.[property] ?? '');
    setCommitError(undefined);
    setEditingExpression(property);
  };

  return (
    <article>
      <p>Editing {object.id}</p>
      <p className="inspector-time">Playhead {(timeUs / 1_000_000).toFixed(2)}s</p>
      {NUMERIC_PROPERTIES.map((property) => {
        const key = property.key as Exclude<AnimatablePropertyV1, 'positionZ'>;
        const curve = object.animations?.[key];
        const animated = curve !== undefined;
        const keyed = animated && hasKeyframeAt(curve, timeUs);
        const expressionSource = object.expressions?.[key];
        const hasExpression = expressionSource !== undefined;
        const channelDiagnostic = diagnostics.find((diagnostic) => diagnostic.property === key);
        // Expressions override curves/static values (§20.3, ADR-0015), so `resolved[key]`
        // (which already reflects that precedence) wins whenever one is present.
        const value = hasExpression
          ? resolved[key]
          : animated
            ? sampleCurve(curve, timeUs)
            : resolved[key];
        return (
          <div key={key} className="inspector-channel">
            <label className={animated ? 'inspector-row animated' : 'inspector-row'}>
              <button
                type="button"
                className={keyed ? 'kf kf-active' : animated ? 'kf kf-on' : 'kf'}
                aria-label={`${keyed ? 'Remove' : 'Add'} ${property.label} keyframe`}
                aria-pressed={keyed}
                disabled={hasExpression}
                title={
                  hasExpression
                    ? 'Driven by an expression — keyframes are ignored while it applies'
                    : keyed
                      ? `Keyframe at playhead — click to remove`
                      : animated
                        ? `Animated — click to add a keyframe here`
                        : `Animate ${property.label}`
                }
                onClick={() => toggleKeyframe(key, value)}
              >
                {keyed ? '◆' : animated ? '◇' : '○'}
              </button>
              <span className="inspector-label">{property.label}</span>
              <input
                type="number"
                min={property.min}
                max={property.max}
                value={round(value)}
                disabled={hasExpression}
                onChange={(event) => {
                  const next = event.currentTarget.valueAsNumber;
                  if (!Number.isFinite(next)) return;
                  if (animated)
                    replaceChannel(
                      key,
                      setKeyframe(curve, { timeUs, value: next, interpolation: 'linear' }),
                    );
                  else onSetStatic(object.id, key, next);
                }}
              />
              <button
                type="button"
                className={hasExpression ? 'fx fx-on' : 'fx'}
                aria-label={`${hasExpression ? 'Edit' : 'Add'} ${property.label} expression`}
                aria-pressed={hasExpression}
                title={
                  hasExpression
                    ? 'Edit the restricted expression driving this channel'
                    : `Drive ${property.label} with a restricted expression (§20.3)`
                }
                onClick={() =>
                  editingExpression === key
                    ? setEditingExpression(undefined)
                    : openExpressionEditor(key)
                }
              >
                ƒx
              </button>
            </label>
            {editingExpression === key && (
              <div className="inspector-expression-editor">
                <input
                  type="text"
                  className="inspector-expression-input"
                  value={draftSource}
                  autoFocus
                  placeholder="e.g. sin(time) * 10"
                  onChange={(event) => setDraftSource(event.currentTarget.value)}
                  onBlur={() => commitExpression(key, draftSource)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitExpression(key, draftSource);
                    if (event.key === 'Escape') {
                      setEditingExpression(undefined);
                      setCommitError(undefined);
                    }
                  }}
                />
                {commitError !== undefined && (
                  <p className="inspector-expression-error">{commitError}</p>
                )}
              </div>
            )}
            {channelDiagnostic !== undefined && (
              <p className="inspector-expression-error">{channelDiagnostic.message}</p>
            )}
          </div>
        );
      })}
    </article>
  );
}
