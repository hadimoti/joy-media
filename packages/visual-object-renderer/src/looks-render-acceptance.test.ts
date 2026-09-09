import { describe, expect, it } from 'vitest';
import type { RenderFrameIR } from '@joy-media/render-ir';
import {
  canonicalBindingKey,
  type JoyProjectV1,
  type PropertyAnimationV2,
} from '@joy-media/project-schema';
import { BUILT_IN_LOOK_PACKS, compileLook, type LookDefinition } from '@joy-media/motion-core';
import { compareGoldenFrame } from '@joy-media/golden-render';
import { buildRenderFrameIRFromProject } from './index.js';

/**
 * GAP 4 — rendered-frame + preview/export acceptance for the five R2 Look packs.
 *
 * `packs-render-fidelity.test.ts` (in motion-core) samples the compiled curve
 * numerically. This closes the next step: the compiled Look, applied to a
 * project, is evaluated through the **single project→frame boundary the Monitor
 * and the export share** (`buildRenderFrameIRFromProject`), and the resulting IR
 * is rendered by BOTH the Pixi preview adapter and the headless export adapter —
 * asserting pixel-identical output (preview/export parity) and real
 * geometry/timing motion at the first / mid-motion / settle frames.
 *
 * The owner-gated art-direction read (sanitized sample renders in the scorecard)
 * supplements this — a passing parity test is not taste approval.
 */

const PORTRAIT = { width: 1080, height: 1920 } as const;
const LANDSCAPE = { width: 1920, height: 1080 } as const;
const DURATION_US = 8_000_000;

function textObject(id: string, text: string, x: number, y: number) {
  return {
    id,
    kind: 'text' as const,
    text,
    transform: {
      x,
      y,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    },
  };
}

function baseProject(width: number, height: number): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'look-render-acceptance',
    title: 'Look render acceptance',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Main',
        width,
        height,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: DURATION_US,
        background: '#000000ff',
        tracks: [],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {
      headline: textObject('headline', 'JOY LIVE', width / 2, height / 2),
      deck: textObject('deck', 'the sequel', width / 2, height / 2 + 120),
    },
    captionDocuments: {},
    pluginData: {},
  } as JoyProjectV1;
}

function applyLook(
  project: JoyProjectV1,
  definition: LookDefinition,
  format: 'portrait' | 'landscape',
): { readonly project: JoyProjectV1; readonly animatedKeys: readonly string[] } {
  const visualSlots = definition.slots.filter((slot) => slot.ownerKind === 'visual-object');
  const entityBindings = Object.fromEntries(
    visualSlots.map((slot, index) => [slot.id, index === 0 ? 'headline' : 'deck']),
  );
  const compiled = compileLook({
    definition,
    definitionVersion: definition.version,
    compositionId: 'root',
    compositionDurationUs: DURATION_US,
    format,
    entityBindings,
    controlValues: {},
    overriddenBindingIds: [],
    resolvedFonts: Object.fromEntries(definition.requiredFonts.map((f) => [f, f])),
  });
  expect(compiled.ok, `${definition.id} (${format}) compiles`).toBe(true);

  type Keyframe = { timeUs: number; value: number; interpolation: 'hold' | 'linear' | 'eased' };
  const grouped = new Map<
    string,
    { binding: PropertyAnimationV2['binding']; kind: 'scalar' | 'angle'; keyframes: Keyframe[] }
  >();
  for (const op of compiled.operations) {
    if (op.kind !== 'motion.setKeyframe') continue;
    const binding = {
      ownerKind: op.ownerKind,
      ownerId: op.ownerId,
      propertyId: op.propertyId,
      timeDomain: op.timeDomain,
    } as const;
    const key = canonicalBindingKey(binding);
    const entry =
      grouped.get(key) ??
      ({
        binding,
        kind: op.propertyId === 'rotationDeg' ? ('angle' as const) : ('scalar' as const),
        keyframes: [] as Keyframe[],
      } as const);
    entry.keyframes.push({
      timeUs: op.timeUs,
      value: op.value,
      interpolation: op.interpolation,
    });
    grouped.set(key, entry);
  }

  const animations: Record<string, PropertyAnimationV2> = {};
  for (const [key, entry] of grouped) {
    animations[key] = {
      binding: entry.binding,
      value: {
        kind: entry.kind,
        curve: { keyframes: [...entry.keyframes].sort((a, b) => a.timeUs - b.timeUs) },
      },
    } as PropertyAnimationV2;
  }
  return {
    project: { ...project, propertyAnimations: animations },
    animatedKeys: Object.keys(animations),
  };
}

const frameAt = (project: JoyProjectV1, w: number, h: number, timeUs: number): RenderFrameIR =>
  buildRenderFrameIRFromProject(project, 'root', timeUs, w, h);

const headlineNode = (frame: RenderFrameIR) => frame.nodes.find((node) => node.id === 'headline');

describe('R2 Look pack rendered-frame + preview/export acceptance (GAP 4)', () => {
  for (const definition of BUILT_IN_LOOK_PACKS) {
    for (const [name, dims] of [
      ['portrait', PORTRAIT],
      ['landscape', LANDSCAPE],
    ] as const) {
      it(`${definition.id} (${name}): identical preview/export at 3 frames, with real motion`, () => {
        const { project, animatedKeys } = applyLook(
          baseProject(dims.width, dims.height),
          definition,
          name,
        );
        expect(
          animatedKeys.length,
          `${definition.id} drives at least one animated binding`,
        ).toBeGreaterThan(0);

        const first = frameAt(project, dims.width, dims.height, 0);
        const mid = frameAt(project, dims.width, dims.height, Math.round(DURATION_US * 0.3));
        const settle = frameAt(project, dims.width, dims.height, DURATION_US - 1);

        for (const [label, frame] of [
          ['first', first],
          ['mid', mid],
          ['settle', settle],
        ] as const) {
          const comparison = compareGoldenFrame(frame);
          expect(
            comparison.identical,
            `${definition.id} (${name}) ${label}: preview == export`,
          ).toBe(true);
          expect(comparison.previewDigest).toBe(comparison.headlessDigest);

          const node = headlineNode(frame);
          expect(node, `${definition.id} (${name}) ${label}: headline is rendered`).toBeDefined();
          if (node === undefined) continue;
          expect(node.opacity).toBeGreaterThanOrEqual(0);
          expect(node.opacity).toBeLessThanOrEqual(1);
          expect(node.transform.scaleX).toBeGreaterThan(0);
          expect(node.transform.scaleX).toBeLessThan(4);
          expect(node.transform.translateX).toBeGreaterThan(-dims.width);
          expect(node.transform.translateX).toBeLessThan(dims.width * 2);
        }

        const sampled = [first, mid, settle]
          .map(headlineNode)
          .filter((node): node is NonNullable<typeof node> => node !== undefined);
        if (sampled.length === 3) {
          const [a, b, c] = sampled;
          const differs = (x: (typeof sampled)[number], y: (typeof sampled)[number]): boolean =>
            Math.abs(x!.opacity - y!.opacity) > 1e-3 ||
            Math.abs(x!.transform.translateX - y!.transform.translateX) > 1e-3 ||
            Math.abs(x!.transform.translateY - y!.transform.translateY) > 1e-3 ||
            Math.abs(x!.transform.scaleX - y!.transform.scaleX) > 1e-3;
          expect(
            differs(a!, b!) || differs(b!, c!) || differs(a!, c!),
            `${definition.id} (${name}): the rendered frame changes over the motion`,
          ).toBe(true);
        }
      });
    }
  }
});
