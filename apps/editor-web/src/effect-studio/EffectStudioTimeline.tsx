import { effectRegistry, type EffectInstanceV1 } from '@joy-media/visual-effects';
import { KeyframeActiveIcon, PauseIcon, PlayIcon } from '../icons.js';

interface EffectStudioTimelineProps {
  readonly effect: EffectInstanceV1 | undefined;
  readonly durationMs: number;
  readonly playheadMs: number;
  readonly playing: boolean;
  readonly onSeek: (timeMs: number) => void;
  readonly onTogglePlayback: () => void;
  readonly onToggleKeyframe: (key: string) => void;
}

export function EffectStudioTimeline({
  effect,
  durationMs,
  playheadMs,
  playing,
  onSeek,
  onTogglePlayback,
  onToggleKeyframe,
}: EffectStudioTimelineProps) {
  const descriptor = effect === undefined ? undefined : effectRegistry.getEffect(effect.effectId);
  const params =
    descriptor?.params.filter((param) => param.animatable && param.type === 'number') ?? [];

  return (
    <section className="es-panel es-automation">
      <div className="es-automation-header">
        <div className="es-automation-title">
          <span className="es-panel-eyebrow">Time domain</span>
          <strong>Parameter automation</strong>
        </div>
        <button type="button" className="es-play-button" onClick={onTogglePlayback}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="es-automation-time">
          {(playheadMs / 1_000).toFixed(2)}s / {(durationMs / 1_000).toFixed(2)}s
        </span>
        <input
          className="es-master-scrubber"
          type="range"
          min="0"
          max={durationMs}
          step="1"
          value={playheadMs}
          onChange={(event) => onSeek(Number(event.currentTarget.value))}
        />
      </div>
      <div className="es-lanes">
        {effect === undefined || params.length === 0 ? (
          <p>Select an effect with animatable numeric parameters.</p>
        ) : (
          params.map((param) => {
            const keyframes = effect.animations?.[param.key]?.keyframes ?? [];
            return (
              <div className="es-lane" key={param.key}>
                <button type="button" onClick={() => onToggleKeyframe(param.key)}>
                  <KeyframeActiveIcon />
                </button>
                <span>{param.label}</span>
                <div className="es-lane-track">
                  <i style={{ left: `${(playheadMs / durationMs) * 100}%` }} />
                  {keyframes.map((keyframe) => (
                    <button
                      key={keyframe.timeUs}
                      type="button"
                      className="es-keyframe"
                      style={{ left: `${keyframe.timeUs / (durationMs * 10)}%` }}
                      title={`${(keyframe.timeUs / 1_000_000).toFixed(2)}s`}
                      onClick={() => onSeek(keyframe.timeUs / 1_000)}
                    />
                  ))}
                </div>
                <output>{String(effect.params[param.key] ?? param.defaultValue)}</output>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
