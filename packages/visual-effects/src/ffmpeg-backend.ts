/**
 * ffmpeg native filter backend for supported visual effects.
 *
 * Maps each effect ID to an ffmpeg filtergraph snippet that produces
 * equivalent output. Effects without ffmpeg support return undefined.
 */

import type { EffectInstanceV1 } from './types.js';

/**
 * Params are a union (number | string | boolean | tuples), so every numeric
 * read has to narrow. Previously these were used in arithmetic directly, which
 * both failed to typecheck and would have emitted `NaN` into a filtergraph had
 * a non-numeric value ever reached here.
 */
function numParam(params: EffectInstanceV1['params'], key: string, fallback: number): number {
  const raw = params[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

/** ffmpeg filterchain string for one effect instance, or undefined if unsupported. */
export function effectToFfmpegFilter(
  effect: EffectInstanceV1,
  inputLabel: string,
  outputLabel: string,
): string | undefined {
  if (!effect.enabled) return undefined;

  switch (effect.effectId) {
    case 'brightness-contrast': {
      const brightness = numParam(effect.params, 'brightness', 0);
      const contrast = numParam(effect.params, 'contrast', 0);
      const b = (brightness * 255).toFixed(2);
      const c = (contrast + 1).toFixed(2);
      return `[${inputLabel}]eq=brightness=${b}:contrast=${c}[${outputLabel}]`;
    }

    case 'sepia': {
      const amount = numParam(effect.params, 'amount', 0.5);
      const r = (1 - 0.607 * amount).toFixed(4);
      const g = (1 - 0.314 * amount).toFixed(4);
      const b = (1 - 0.869 * amount).toFixed(4);
      return (
        `[${inputLabel}]colorchannelmixer=` +
        `rr=${r}:rg=${(0.769 * amount).toFixed(4)}:rb=${(0.189 * amount).toFixed(4)}:` +
        `gr=${(0.349 * amount).toFixed(4)}:gg=${g}:gb=${(0.168 * amount).toFixed(4)}:` +
        `br=${(0.272 * amount).toFixed(4)}:bg=${(0.534 * amount).toFixed(4)}:bb=${b}[${outputLabel}]`
      );
    }

    case 'gaussian-blur':
    case 'blur': {
      const radius = Math.max(1, Math.round(numParam(effect.params, 'amount', 4)));
      return `[${inputLabel}]gblur=sigma=${radius.toFixed(1)}[${outputLabel}]`;
    }

    case 'hue-saturation': {
      const hue = numParam(effect.params, 'hue', 0) * 180;
      const sat = (numParam(effect.params, 'saturation', 0) + 1).toFixed(2);
      return `[${inputLabel}]hue=h=${hue.toFixed(1)}:s=${sat}[${outputLabel}]`;
    }

    default:
      return undefined;
  }
}

/** Filtergraph string for a full effect stack applied to one input source. */
export function effectStackToFfmpegFiltergraph(
  effects: readonly EffectInstanceV1[],
  inputLabel: string = '0:v',
): string | undefined {
  if (!effects || effects.length === 0) return undefined;

  const enabledEffects = effects.filter((e) => e.enabled);
  if (enabledEffects.length === 0) return undefined;

  let currentInput = inputLabel;
  const chains: string[] = [];

  for (let i = 0; i < enabledEffects.length; i++) {
    const outputLabel = `e${i}`;
    const chain = effectToFfmpegFilter(enabledEffects[i]!, currentInput, outputLabel);
    if (chain) {
      chains.push(chain);
      currentInput = outputLabel;
    }
  }

  if (chains.length === 0) return undefined;

  return chains.join(';\n') + `;[${currentInput}]null[v]`;
}
