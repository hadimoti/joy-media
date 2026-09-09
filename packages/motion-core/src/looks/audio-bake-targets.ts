/**
 * Audio-reactive bake targets for a Look (R2 / L4).
 *
 * `resolveLookAudioBakeTargets` returns, for the keyframe bindings a Look would
 * drive under the operator's current control values, the `(rest, peak)` numeric
 * range an audio-reactive bake needs. It is a pure function of the definition
 * and the control values — exactly what `compileLook` reads — so the bake drives
 * the same binding, between the same rest and the same ceiling, that the slider
 * would; the baked keyframes then supersede that slider drive
 * (`LookCompileInput.audioBakes`).
 *
 * Template-swap drives and non-keyframe channels are ignored: an audio bake only
 * makes sense for a numeric keyframe track.
 */

import { mapLookControl } from './compile.js';
import type { LookDefinition } from './types.js';

export interface LookAudioBakeTarget {
  readonly bindingId: string;
  readonly propertyId: string;
  readonly ownerSlotId: string;
  /** The value at profile weight 0 — where the motion rests between beats. */
  readonly restValue: number;
  /** The value at profile weight 1 — the ceiling a full beat reaches. */
  readonly peakValue: number;
}

export function resolveLookAudioBakeTargets(
  definition: LookDefinition,
  controlValues: Readonly<Record<string, number | string | boolean>>,
): readonly LookAudioBakeTarget[] {
  const keyframeBindings = new Map(
    definition.bindingTargets
      .filter((target) => target.channel === 'keyframe')
      .map((target) => [target.bindingId, target] as const),
  );
  const seen = new Set<string>();
  const out: LookAudioBakeTarget[] = [];

  const add = (bindingId: string, restValue: number, peakValue: number): void => {
    const target = keyframeBindings.get(bindingId);
    if (target === undefined) return;
    if (seen.has(bindingId)) return;
    if (!Number.isFinite(restValue) || !Number.isFinite(peakValue)) return;
    if (peakValue === restValue) return;
    seen.add(bindingId);
    out.push({
      bindingId,
      propertyId: target.propertyId,
      ownerSlotId: target.ownerSlotId,
      restValue,
      peakValue,
    });
  };

  for (const control of definition.controls) {
    const raw = controlValues[control.id];
    switch (control.kind) {
      case 'scalar': {
        const value01 =
          typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1
            ? raw
            : control.default;
        for (const drive of control.drives) {
          add(drive.bindingId, drive.min, mapLookControl(value01, drive.min, drive.max));
        }
        break;
      }
      case 'enum': {
        const option =
          typeof raw === 'string' && control.options.includes(raw) ? raw : control.default;
        for (const drive of control.drives) {
          const rest = drive.byOption[option];
          if (typeof rest !== 'number') continue;
          add(drive.bindingId, rest, drive.settled ?? rest);
        }
        break;
      }
      case 'boolean': {
        const on = typeof raw === 'boolean' ? raw : control.default;
        if (!on) break;
        for (const drive of control.drives) {
          add(drive.bindingId, drive.rest ?? 0, drive.whenTrue);
        }
        break;
      }
      // color / font are template-swap only — nothing to bake.
      default:
        break;
    }
  }

  return out;
}
