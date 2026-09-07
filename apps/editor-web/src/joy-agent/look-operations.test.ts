import { describe, expect, it } from 'vitest';
import type { LookCompileInput, LookDefinition, LookOperation } from '@joy-media/motion-core';
import { JOY_CODE_OPERATION_KINDS } from '@joy-media/agent-tools';
import {
  catalog,
  describe as describeLook,
  prepareLookPlan,
  translateLookOperations,
} from './look-operations.js';

function fixtureDefinition(overrides: Partial<LookDefinition> = {}): LookDefinition {
  return {
    schemaVersion: 1,
    id: 'editorial-clean',
    version: 2,
    title: 'Editorial Clean',
    description: 'Restrained hierarchy and clean title rhythm.',
    slots: [
      { id: 'headline', label: 'Headline', ownerKind: 'visual-object', required: true },
      { id: 'deck', label: 'Deck', ownerKind: 'visual-object', required: false },
      { id: 'captions', label: 'Captions', ownerKind: 'caption-clip', required: false },
    ],
    bindingTargets: [
      {
        bindingId: 'headline-scale-x',
        channel: 'keyframe',
        ownerSlotId: 'headline',
        ownerKind: 'visual-object',
        propertyId: 'scaleX',
        timeDomain: 'composition',
      },
      {
        bindingId: 'headline-opacity',
        channel: 'keyframe',
        ownerSlotId: 'headline',
        ownerKind: 'visual-object',
        propertyId: 'opacity',
        timeDomain: 'composition',
      },
      {
        bindingId: 'headline-template',
        channel: 'text-template',
        ownerSlotId: 'headline',
        ownerKind: 'visual-object',
        propertyId: 'text-template',
        timeDomain: 'composition',
      },
    ],
    controls: [
      {
        id: 'energy',
        label: 'Energy',
        kind: 'scalar',
        default: 0.5,
        drives: [
          {
            bindingId: 'headline-scale-x',
            min: 1,
            max: 1.4,
            atFractions: [0, 0.2, 1],
            interpolation: 'eased',
          },
        ],
      },
      {
        id: 'palette',
        label: 'Palette',
        kind: 'color',
        default: 'ink-on-paper',
        palettePairs: [
          { id: 'ink-on-paper', foreground: '#111111', background: '#fafafa' },
          { id: 'paper-on-ink', foreground: '#fafafa', background: '#111111' },
        ],
        drives: [
          {
            bindingId: 'headline-template',
            target: 'text',
            templateByOption: { 'ink-on-paper': 'clean-title', 'paper-on-ink': 'bold-stack' },
          },
        ],
      },
    ],
    constraints: {
      portrait: { safeMarginPx: 96, maxHeadlineChars: 42, minHoldUs: 500_000 },
      landscape: { safeMarginPx: 64, maxHeadlineChars: 64, minHoldUs: 500_000 },
    },
    provenance: { author: 'JOY', license: 'internal' },
    requiredOperationKinds: ['motion.setKeyframe', 'text.setTemplate'],
    requiredFonts: [],
    verification: [
      { id: 'safe-margins', method: 'structural', summary: 'Headline stays inside safe margins.' },
    ],
    ...overrides,
  };
}

function baseInput(overrides: Partial<LookCompileInput> = {}): LookCompileInput {
  return {
    definition: fixtureDefinition(),
    definitionVersion: 2,
    compositionId: 'root',
    compositionDurationUs: 10_000_000,
    format: 'portrait',
    entityBindings: { headline: 'title-1', deck: 'title-2', captions: 'cap-1' },
    controlValues: { energy: 0.5, entrance: 'fade', palette: 'ink-on-paper', 'show-deck': true },
    overriddenBindingIds: [],
    resolvedFonts: {},
    ...overrides,
  };
}

describe('translateLookOperations', () => {
  it('maps each LookOperation kind 1:1 to a canonical operation', () => {
    const operations: LookOperation[] = [
      {
        kind: 'motion.setKeyframe',
        bindingId: 'b1',
        ownerKind: 'visual-object',
        ownerId: 'title-1',
        propertyId: 'opacity',
        timeDomain: 'composition',
        timeUs: 0,
        value: 1,
        interpolation: 'linear',
      },
      { kind: 'text.setTemplate', bindingId: 'b2', objectId: 'title-1', templateId: 'title-light' },
      {
        kind: 'caption.setTemplate',
        bindingId: 'b3',
        captionClipId: 'cap-1',
        templateId: 'cap-clean',
      },
    ];
    const canonical = translateLookOperations(operations, 'look-x');
    expect(canonical.map((o) => o.kind)).toEqual([
      'motion.setKeyframe',
      'text.setTemplate',
      'caption.setTemplate',
    ]);
    expect(canonical.map((o) => o.id)).toEqual(['look-x-0', 'look-x-1', 'look-x-2']);
    const kf = canonical[0] as Extract<(typeof canonical)[number], { kind: 'motion.setKeyframe' }>;
    expect(kf.binding).toEqual({
      ownerKind: 'visual-object',
      ownerId: 'title-1',
      propertyId: 'opacity',
      timeDomain: 'composition',
    });
    expect(kf.key.kind).toBe('scalar');
  });

  it('only produces kinds that are in the canonical allowlist', () => {
    const { plan } = prepareLookPlan(baseInput(), 'apply Editorial Clean');
    for (const op of plan!.operations) {
      expect(JOY_CODE_OPERATION_KINDS as readonly string[]).toContain(op.kind);
    }
  });

  it('a text.setTemplate on a known object emits a dependent text.setContent that restores the copy', () => {
    const operations: LookOperation[] = [
      { kind: 'text.setTemplate', bindingId: 'b1', objectId: 'title-1', templateId: 'clean-title' },
    ];
    const canonical = translateLookOperations(operations, 'look-x', {
      'title-1': 'Our real headline',
    });
    expect(canonical.map((o) => o.kind)).toEqual(['text.setTemplate', 'text.setContent']);
    const keep = canonical[1] as Extract<(typeof canonical)[number], { kind: 'text.setContent' }>;
    expect(keep.content).toBe('Our real headline');
    expect(keep.dependsOn).toEqual(['look-x-0']);
  });

  it('does not emit a text.setContent when the object text is unknown', () => {
    const canonical = translateLookOperations(
      [
        {
          kind: 'text.setTemplate',
          bindingId: 'b1',
          objectId: 'title-1',
          templateId: 'clean-title',
        },
      ],
      'look-x',
    );
    expect(canonical.map((o) => o.kind)).toEqual(['text.setTemplate']);
  });
});

describe('prepareLookPlan', () => {
  it('wraps a successful compilation in a JoyCodeModelPlanV1', () => {
    const result = prepareLookPlan(baseInput(), 'apply Editorial Clean');
    expect(result.ok).toBe(true);
    expect(result.plan!.schemaVersion).toBe(1);
    expect(result.plan!.operations.length).toBeGreaterThan(0);
    expect(result.plan!.goal).toBe('apply Editorial Clean');
  });

  it('returns ok:false with compiler diagnostics and no plan on failure', () => {
    const result = prepareLookPlan(baseInput({ definitionVersion: 99 }), 'apply');
    expect(result.ok).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(result.compilation.diagnostics.map((d) => d.code)).toContain(
      'LOOK_COMPILE_VERSION_MISMATCH',
    );
  });

  it('does not leak a partial plan when a required slot is unbound', () => {
    const result = prepareLookPlan(baseInput({ entityBindings: { deck: 'title-2' } }), 'apply');
    expect(result.ok).toBe(false);
    expect(result.plan).toBeUndefined();
  });
});

describe('catalog', () => {
  it('marks a Look available when its ops and fonts are all present', () => {
    const entries = catalog([fixtureDefinition()], {
      availableOperationKinds: JOY_CODE_OPERATION_KINDS,
      availableFonts: [],
    });
    expect(entries[0]!.available).toBe(true);
    expect(entries[0]!.missingOperationKinds).toEqual([]);
  });

  it('marks a Look unavailable and names the missing operation kind', () => {
    const entries = catalog([fixtureDefinition()], {
      availableOperationKinds: JOY_CODE_OPERATION_KINDS.filter((k) => k !== 'text.setTemplate'),
      availableFonts: [],
    });
    expect(entries[0]!.available).toBe(false);
    expect(entries[0]!.missingOperationKinds).toContain('text.setTemplate');
  });

  it('marks a Look unavailable when a required font is missing', () => {
    const entries = catalog([fixtureDefinition({ requiredFonts: ['Vazirmatn Variable'] })], {
      availableFonts: [],
    });
    expect(entries[0]!.available).toBe(false);
    expect(entries[0]!.missingFonts).toContain('Vazirmatn Variable');
  });

  it('marks a Look unavailable when its own definition fails validation', () => {
    const entries = catalog([fixtureDefinition({ id: 'Bad Id' })], { availableFonts: [] });
    expect(entries[0]!.available).toBe(false);
    expect(entries[0]!.definitionDiagnostics.length).toBeGreaterThan(0);
  });
});

describe('describe', () => {
  it('returns a compact translation-safe description', () => {
    const d = describeLook(fixtureDefinition());
    expect(d.title).toBe('Editorial Clean');
    expect(d.slots.find((s) => s.id === 'headline')?.required).toBe(true);
    expect(d.controls.map((c) => c.id)).toContain('energy');
  });
});
