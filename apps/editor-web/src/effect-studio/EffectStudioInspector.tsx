import {
  effectRegistry,
  type EffectInstanceV1,
  type EffectParamValue,
} from '@joy-media/visual-effects';
import { KeyframeActiveIcon, KeyframeNoneIcon, RefreshIcon } from '../icons.js';

interface EffectStudioInspectorProps {
  readonly effect: EffectInstanceV1 | undefined;
  readonly playheadMs: number;
  readonly onSetParam: (key: string, value: EffectParamValue) => void;
  readonly onToggleKeyframe: (key: string) => void;
  readonly onReset: () => void;
}

export function EffectStudioInspector({
  effect,
  playheadMs,
  onSetParam,
  onToggleKeyframe,
  onReset,
}: EffectStudioInspectorProps) {
  const descriptor = effect === undefined ? undefined : effectRegistry.getEffect(effect.effectId);
  if (effect === undefined || descriptor === undefined) {
    return (
      <aside className="es-panel es-inspector">
        <div className="es-panel-heading">
          <div>
            <span className="es-panel-eyebrow">Controls</span>
            <h2>Inspector</h2>
          </div>
        </div>
        <div className="es-inspector-empty">
          <span />
          <strong>Select an effect</strong>
          <p>Its parameters, backend support, and automation controls will appear here.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="es-panel es-inspector">
      <div className="es-panel-heading">
        <div>
          <span className="es-panel-eyebrow">{descriptor.category}</span>
          <h2>{descriptor.label}</h2>
        </div>
        <button
          className="es-reset-button"
          type="button"
          onClick={onReset}
          title="Reset parameters"
        >
          <RefreshIcon />
        </button>
      </div>
      <div className="es-inspector-summary">
        <img src={`/effects/preview/${descriptor.id}.png`} alt="" width="54" height="54" />
        <p>{descriptor.description}</p>
      </div>
      <div className="es-backend-row">
        <span className={descriptor.backend.pixiPreview ? 'is-ready' : ''}>Preview</span>
        <span className={descriptor.backend.headless ? 'is-ready' : ''}>Render</span>
        <span className={descriptor.backend.ffmpeg ? 'is-ready' : ''}>FFmpeg</span>
        <span data-cost={descriptor.cost}>{descriptor.cost} cost</span>
      </div>
      <div className="es-parameter-list">
        {descriptor.params.map((param) => {
          const value = effect.params[param.key] ?? param.defaultValue;
          const timeUs = Math.round(playheadMs * 1_000);
          const keyed =
            effect.animations?.[param.key]?.keyframes.some(
              (keyframe) => keyframe.timeUs === timeUs,
            ) ?? false;
          return (
            <div className="es-parameter" key={param.key}>
              <div className="es-parameter-label">
                <label htmlFor={`es-param-${effect.id}-${param.key}`}>{param.label}</label>
                <div>
                  {param.unit && <small>{param.unit}</small>}
                  {param.animatable && param.type === 'number' && (
                    <button
                      type="button"
                      className={keyed ? 'is-keyed' : ''}
                      title={keyed ? 'Remove keyframe' : 'Add keyframe'}
                      onClick={() => onToggleKeyframe(param.key)}
                    >
                      {keyed ? <KeyframeActiveIcon /> : <KeyframeNoneIcon />}
                    </button>
                  )}
                </div>
              </div>
              {param.type === 'number' && typeof value === 'number' && (
                <div className="es-number-control">
                  <input
                    id={`es-param-${effect.id}-${param.key}`}
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={value}
                    onChange={(event) => onSetParam(param.key, Number(event.currentTarget.value))}
                  />
                  <input
                    type="number"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={value}
                    aria-label={`${param.label} value`}
                    onChange={(event) => onSetParam(param.key, Number(event.currentTarget.value))}
                  />
                </div>
              )}
              {param.type === 'boolean' && typeof value === 'boolean' && (
                <button
                  id={`es-param-${effect.id}-${param.key}`}
                  type="button"
                  className={`es-toggle${value ? ' is-on' : ''}`}
                  onClick={() => onSetParam(param.key, !value)}
                >
                  <span />
                  {value ? 'On' : 'Off'}
                </button>
              )}
              {param.type === 'enum' && (
                <select
                  id={`es-param-${effect.id}-${param.key}`}
                  value={String(value)}
                  onChange={(event) => {
                    const option = param.options?.find(
                      (candidate) => String(candidate.value) === event.currentTarget.value,
                    );
                    if (option !== undefined) onSetParam(param.key, option.value);
                  }}
                >
                  {param.options?.map((option) => (
                    <option key={String(option.value)} value={String(option.value)}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
              {param.type === 'color' && typeof value === 'string' && (
                <input
                  id={`es-param-${effect.id}-${param.key}`}
                  type="color"
                  value={value}
                  onChange={(event) => onSetParam(param.key, event.currentTarget.value)}
                />
              )}
              {param.type === 'vector2' && Array.isArray(value) && (
                <div className="es-vector-control">
                  {[0, 1].map((index) => (
                    <label key={index}>
                      {index === 0 ? 'X' : 'Y'}
                      <input
                        type="number"
                        value={value[index] ?? 0}
                        onChange={(event) => {
                          const next: [number, number] = [
                            Number(value[0] ?? 0),
                            Number(value[1] ?? 0),
                          ];
                          next[index] = Number(event.currentTarget.value);
                          onSetParam(param.key, next);
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
