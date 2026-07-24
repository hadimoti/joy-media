/**
 * CapCut/Premiere-like effects browser + nondestructive stack on the selected object.
 */

import type { JoyProjectV1 } from '@joy-media/project-schema';
import { PlusIcon, TrashIcon } from './icons.js';

export type EffectKind = 'blur' | 'glow' | 'shadow' | 'vignette' | 'sharpen' | 'grain';

export interface EffectInstance {
  readonly id: string;
  readonly kind: EffectKind;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, number>>;
}

export interface EffectStack {
  readonly effects: readonly EffectInstance[];
}

const CATALOG: readonly { readonly kind: EffectKind; readonly label: string; readonly defaults: Record<string, number> }[] =
  [
    { kind: 'blur', label: 'Gaussian Blur', defaults: { amount: 4 } },
    { kind: 'glow', label: 'Glow', defaults: { amount: 0.4, threshold: 0.6 } },
    { kind: 'shadow', label: 'Drop Shadow', defaults: { opacity: 0.5, distance: 8 } },
    { kind: 'vignette', label: 'Vignette', defaults: { amount: 0.35 } },
    { kind: 'sharpen', label: 'Sharpen', defaults: { amount: 0.3 } },
    { kind: 'grain', label: 'Film Grain', defaults: { amount: 0.2 } },
  ];

export function readEffectStacks(project: JoyProjectV1): Readonly<Record<string, EffectStack>> {
  const raw = project.pluginData['joy.effects'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as unknown as Readonly<Record<string, EffectStack>>;
}

interface EffectsPanelProps {
  readonly project: JoyProjectV1;
  readonly objectId: string | undefined;
  readonly onChange: (next: JoyProjectV1) => void;
}

export function EffectsPanel({ project, objectId, onChange }: EffectsPanelProps) {
  const stacks = readEffectStacks(project);
  const stack = objectId === undefined ? undefined : stacks[objectId];

  const write = (nextStacks: Readonly<Record<string, EffectStack>>) => {
    onChange({
      ...project,
      pluginData: {
        ...project.pluginData,
        'joy.effects': nextStacks as unknown as import('@joy-media/project-schema').JsonValue,
      },
      updatedAt: new Date().toISOString(),
    });
  };

  if (objectId === undefined) return <p>Select a visual object to apply effects.</p>;

  return (
    <article className="effects-panel">
      <h3>Effects</h3>
      <div className="effects-catalog">
        {CATALOG.map((item) => (
          <button
            key={item.kind}
            type="button"
            className="icon-button icon-button-labeled"
            onClick={() => {
              const effect: EffectInstance = {
                id: `${item.kind}-${Date.now()}`,
                kind: item.kind,
                enabled: true,
                params: item.defaults,
              };
              const effects = [...(stack?.effects ?? []), effect];
              write({ ...stacks, [objectId]: { effects } });
            }}
          >
            <PlusIcon />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <h3>Stack · {objectId}</h3>
      {(stack?.effects ?? []).length === 0 ? (
        <p className="empty-hint">No effects on this object.</p>
      ) : (
        <ul className="effects-stack">
          {(stack?.effects ?? []).map((effect, index) => (
            <li key={effect.id}>
              <label>
                <input
                  type="checkbox"
                  checked={effect.enabled}
                  onChange={(event) => {
                    const effects = (stack?.effects ?? []).map((item, i) =>
                      i === index ? { ...item, enabled: event.currentTarget.checked } : item,
                    );
                    write({ ...stacks, [objectId]: { effects } });
                  }}
                />
                {effect.kind}
              </label>
              {Object.entries(effect.params).map(([key, value]) => (
                <label key={key}>
                  {key}
                  <input
                    type="range"
                    min={0}
                    max={key === 'distance' ? 40 : 1}
                    step={0.01}
                    value={value}
                    onChange={(event) => {
                      const effects = (stack?.effects ?? []).map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              params: {
                                ...item.params,
                                [key]: event.currentTarget.valueAsNumber,
                              },
                            }
                          : item,
                      );
                      write({ ...stacks, [objectId]: { effects } });
                    }}
                  />
                </label>
              ))}
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${effect.kind}`}
                onClick={() => {
                  const effects = (stack?.effects ?? []).filter((_, i) => i !== index);
                  write({ ...stacks, [objectId]: { effects } });
                }}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
