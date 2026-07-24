/**
 * CapCut/Premiere-like effects browser — SVG catalog + stack controls.
 */

import type { ReactElement } from 'react';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  BlurIcon,
  GlowIcon,
  GrainIcon,
  ShadowIcon,
  SharpenIcon,
  TrashIcon,
  VignetteIcon,
} from './icons.js';

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

const CATALOG: readonly {
  readonly kind: EffectKind;
  readonly label: string;
  readonly defaults: Record<string, number>;
  readonly Icon: () => ReactElement;
}[] = [
  { kind: 'blur', label: 'Gaussian Blur', defaults: { amount: 4 }, Icon: BlurIcon },
  { kind: 'glow', label: 'Glow', defaults: { amount: 0.4, threshold: 0.6 }, Icon: GlowIcon },
  { kind: 'shadow', label: 'Drop Shadow', defaults: { opacity: 0.5, distance: 8 }, Icon: ShadowIcon },
  { kind: 'vignette', label: 'Vignette', defaults: { amount: 0.35 }, Icon: VignetteIcon },
  { kind: 'sharpen', label: 'Sharpen', defaults: { amount: 0.3 }, Icon: SharpenIcon },
  { kind: 'grain', label: 'Film Grain', defaults: { amount: 0.2 }, Icon: GrainIcon },
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

  if (objectId === undefined) return <p className="empty-hint">Select a visual object.</p>;

  return (
    <article className="effects-panel">
      <div className="effects-catalog">
        {CATALOG.map((item) => (
          <button
            key={item.kind}
            type="button"
            className="icon-button"
            data-guide={item.label}
            aria-label={`Add ${item.label}`}
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
            <item.Icon />
          </button>
        ))}
      </div>
      {(stack?.effects ?? []).length === 0 ? (
        <p className="empty-hint">No effects on this object.</p>
      ) : (
        <ul className="effects-stack">
          {(stack?.effects ?? []).map((effect, index) => {
            const meta = CATALOG.find((item) => item.kind === effect.kind);
            const Icon = meta?.Icon ?? BlurIcon;
            return (
              <li key={effect.id}>
                <div className="audio-strip-flags">
                  <span className="icon-tool" data-guide={meta?.label ?? effect.kind}>
                    <Icon />
                  </span>
                  <label className="icon-tool" data-guide={effect.enabled ? 'Enabled' : 'Bypassed'}>
                    <input
                      type="checkbox"
                      checked={effect.enabled}
                      aria-label={`Toggle ${effect.kind}`}
                      title={effect.enabled ? 'Enabled' : 'Bypassed'}
                      onChange={(event) => {
                        const effects = (stack?.effects ?? []).map((item, i) =>
                          i === index ? { ...item, enabled: event.currentTarget.checked } : item,
                        );
                        write({ ...stacks, [objectId]: { effects } });
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${effect.kind}`}
                    data-guide="Remove"
                    onClick={() => {
                      const effects = (stack?.effects ?? []).filter((_, i) => i !== index);
                      write({ ...stacks, [objectId]: { effects } });
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
                {Object.entries(effect.params).map(([key, value]) => (
                  <div className="control-row" key={key}>
                    <span className="sr-only">{key}</span>
                    <input
                      type="range"
                      min={0}
                      max={key === 'distance' ? 40 : key === 'amount' && effect.kind === 'blur' ? 20 : 1}
                      step={0.01}
                      value={value}
                      aria-label={`${effect.kind} ${key}`}
                      data-guide={key}
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
                    <span className="value">{value.toFixed(2)}</span>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
