import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertPropertyCoverageComplete,
  findPropertyCoverage,
  listPropertyCoverage,
  PROPERTY_COVERAGE,
  PROPERTY_INVENTORY,
} from './property-coverage.js';

type AnyEntry = {
  [key: string]: unknown;
};

function cloneCoverage(): AnyEntry[] {
  return PROPERTY_COVERAGE.map((entry) => ({ ...(entry as unknown as AnyEntry) }));
}

function expectViolation(fn: () => void, pattern: RegExp): void {
  expect(fn).toThrow();
  try {
    fn();
  } catch (err) {
    expect((err as Error).message).toMatch(pattern);
  }
}

describe('property coverage manifest', () => {
  it('is a complete, self-consistent registry', () => {
    expect(() => assertPropertyCoverageComplete()).not.toThrow();
  });

  it('lists exactly the declared families and finds entries by id', () => {
    expect(listPropertyCoverage()).toHaveLength(PROPERTY_COVERAGE.length);
    expect(PROPERTY_COVERAGE).toHaveLength(PROPERTY_INVENTORY.length);
    expect(listPropertyCoverage()).toBe(PROPERTY_COVERAGE);
    expect(findPropertyCoverage('visual.transform.opacity')?.classification).toBe('creative');
    expect(findPropertyCoverage('does.not.exist')).toBeUndefined();
  });

  it('classifies every inventory family exactly once', () => {
    const ids = new Set(PROPERTY_COVERAGE.map((e) => e.id));
    expect(ids.size).toBe(PROPERTY_COVERAGE.length);
    for (const key of PROPERTY_INVENTORY) {
      const matches = PROPERTY_COVERAGE.filter((e) => e.inventoryKey === key);
      expect(matches, `family "${key}" should be classified exactly once`).toHaveLength(1);
    }
  });

  describe('rejects malformed coverage', () => {
    it('rejects duplicate ids', () => {
      const coverage = cloneCoverage();
      coverage[0]!.id = coverage[1]!.id as string;
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /duplicate coverage id/,
      );
    });

    it('rejects a blank label', () => {
      const coverage = cloneCoverage();
      coverage[0]!.label = '   ';
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /blank label/,
      );
    });

    it('rejects a blank rationale', () => {
      const coverage = cloneCoverage();
      coverage[1]!.rationale = '';
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /blank rationale/,
      );
    });

    it('rejects a bad classification', () => {
      const coverage = cloneCoverage();
      coverage[2]!.classification = 'time-travel';
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /bad classification/,
      );
    });

    it('rejects an invalid owner/time-domain pair', () => {
      const coverage = cloneCoverage();
      const creative = coverage.find((e) => e.classification === 'creative');
      creative!.binding = { ownerKind: 'visual-object', timeDomain: 'output' };
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /invalid owner\/time-domain pair/,
      );
    });

    it('rejects an unknown owner kind', () => {
      const coverage = cloneCoverage();
      const creative = coverage.find((e) => e.classification === 'creative');
      creative!.binding = { ownerKind: 'reverse-polarity', timeDomain: 'composition' };
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /unknown owner kind/,
      );
    });

    it('rejects a creative entry missing its policy', () => {
      const coverage = cloneCoverage();
      const creative = coverage.find((e) => e.classification === 'creative');
      delete creative!.policy;
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /missing or invalid policy/,
      );
    });

    it('rejects a creative entry missing its value kind', () => {
      const coverage = cloneCoverage();
      const creative = coverage.find((e) => e.classification === 'creative');
      delete creative!.animationValueKind;
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /invalid animation value kind/,
      );
    });

    it('rejects a creative entry with an invalid animation value kind', () => {
      const coverage = cloneCoverage();
      const creative = coverage.find((e) => e.classification === 'creative');
      creative!.animationValueKind = 'warp';
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /invalid animation value kind/,
      );
    });

    it('rejects a creative entry with an invalid policy shape', () => {
      const coverage = cloneCoverage();
      const creative = coverage.find((e) => e.classification === 'creative');
      creative!.policy = { interpolation: 'smooth', domain: { min: 1, max: 0 } };
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /missing or invalid policy/,
      );
    });

    it('rejects noncreative animation data', () => {
      const coverage = cloneCoverage();
      const staticEntry = coverage.find((e) => e.classification === 'static-with-reason');
      staticEntry!.animationValueKind = 'scalar';
      staticEntry!.policy = { interpolation: 'hold', domain: 'free' };
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /noncreative entry .* carries animation data/,
      );
    });

    it('rejects a ui-only entry that leaks a project binding', () => {
      const coverage = cloneCoverage();
      const uiOnly = coverage.find((e) => e.classification === 'ui-only');
      uiOnly!.binding = { ownerKind: 'visual-object', timeDomain: 'composition' };
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /ui-only entry .* must not carry a project binding/,
      );
    });

    it('rejects a missing inventory classification', () => {
      const coverage = cloneCoverage();
      const removed = coverage.pop() as AnyEntry;
      expect(removed).toBeDefined();
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /has no coverage classification/,
      );
    });

    it('rejects coverage referring to an unknown inventory key', () => {
      const coverage = cloneCoverage();
      coverage[0]!.inventoryKey = 'ghost.surface';
      expectViolation(
        () => assertPropertyCoverageComplete(coverage as never, PROPERTY_INVENTORY),
        /unknown inventory key/,
      );
    });
  });

  describe('covers every property domain', () => {
    it('declares a creative entry for each animatable domain', () => {
      const creative = PROPERTY_COVERAGE.filter((e) => e.classification === 'creative');
      const inventoryByDomain: Record<string, string[]> = {
        visual: ['visual.transform.position', 'visual.transform.scale', 'visual.transform.crop'],
        effect: ['object-effect.params', 'object-effect.enabled'],
        color: [
          'color-output.adjust',
          'color-output.grade-enabled',
          'color-output.wheels',
          'color-output.curves',
          'color-output.hsl',
          'color-output.lut-choice',
          'color-output.lut-intensity',
          'color-clip.adjust',
          'color-clip.grade-enabled',
          'color-clip.wheels',
          'color-clip.curves',
          'color-clip.hsl',
          'color-clip.lut-choice',
          'color-clip.lut-intensity',
        ],
        audio: [
          'audio-clip.gain',
          'audio-bus.pan',
          'audio-bus.insert-amount',
          'audio-bus.send-amount',
          'audio-effect.params',
        ],
        caption: ['caption.style-values', 'caption.alignment-template'],
        camera: ['camera.view'],
        transition: ['transition.shader-uniforms'],
        motion: ['motion.scene-layer-variables'],
      };
      for (const [domain, keys] of Object.entries(inventoryByDomain)) {
        for (const key of keys) {
          expect(
            creative.some((e) => e.inventoryKey === key),
            `${domain} domain should expose "${key}" as creative`,
          ).toBe(true);
        }
      }
    });

    it('covers every classification at least once', () => {
      const classes = PROPERTY_COVERAGE.map((e) => e.classification);
      for (const c of ['creative', 'static-with-reason', 'structural', 'ui-only']) {
        expect(classes, `classification "${c}" should appear`).toContain(c);
      }
    });
  });

  describe('eligibility choices (WP34-03 repair)', () => {
    it('registers crop as a creative vector with smooth-free policy', () => {
      const entry = findPropertyCoverage('visual.transform.crop') as AnyEntry | undefined;
      expect(entry?.classification).toBe('creative');
      expect(entry?.animationValueKind).toBe('vector');
      expect(entry?.policy).toEqual({ interpolation: 'smooth', domain: 'free' });
      expect(entry?.binding).toEqual({ ownerKind: 'visual-object', timeDomain: 'composition' });
    });

    it('registers known object-effect enabled/params as creative, unknown plugin params stay static', () => {
      const enabled = findPropertyCoverage('object-effect.enabled') as AnyEntry | undefined;
      expect(enabled?.classification).toBe('creative');
      expect(enabled?.animationValueKind).toBe('boolean');
      expect(enabled?.policy).toEqual({ interpolation: 'hold', domain: 'free' });

      const params = findPropertyCoverage('object-effect.params') as AnyEntry | undefined;
      expect(params?.classification).toBe('creative');
      expect(params?.animationValueKind).toBe('scalar');

      const unknown = findPropertyCoverage('object-effect.unknown-plugin-params') as
        AnyEntry | undefined;
      expect(unknown?.classification).toBe('static-with-reason');
      expect('animationValueKind' in unknown!).toBe(false);
      expect('policy' in unknown!).toBe(false);
    });

    it('splits audio-bus insert/send into creative amounts and structural ordering', () => {
      for (const key of ['audio-bus.insert-amount', 'audio-bus.send-amount']) {
        const entry = findPropertyCoverage(key) as AnyEntry | undefined;
        expect(entry?.classification).toBe('creative');
        expect(entry?.animationValueKind).toBe('scalar');
        expect(entry?.policy).toEqual({ interpolation: 'smooth', domain: 'free' });
      }
      for (const key of ['audio-bus.insert-order', 'audio-bus.send-routing']) {
        const entry = findPropertyCoverage(key) as AnyEntry | undefined;
        expect(entry?.classification).toBe('structural');
        expect('animationValueKind' in entry!).toBe(false);
        expect('policy' in entry!).toBe(false);
      }
    });

    it('splits LUT choice (string hold) from intensity (scalar smooth) per target grade', () => {
      for (const target of ['color-output', 'color-clip']) {
        const choice = findPropertyCoverage(`${target}.lut-choice`) as AnyEntry | undefined;
        expect(choice?.classification).toBe('creative');
        expect(choice?.animationValueKind).toBe('string');
        expect(choice?.policy).toEqual({ interpolation: 'hold', domain: 'free' });

        const intensity = findPropertyCoverage(`${target}.lut-intensity`) as AnyEntry | undefined;
        expect(intensity?.classification).toBe('creative');
        expect(intensity?.animationValueKind).toBe('scalar');
        expect(intensity?.policy).toEqual({ interpolation: 'smooth', domain: 'free' });
      }
    });

    it('splits caption numeric/colour (creative scalar) from alignment/template (string hold)', () => {
      const values = findPropertyCoverage('caption.style-values') as AnyEntry | undefined;
      expect(values?.classification).toBe('creative');
      expect(values?.animationValueKind).toBe('scalar');
      expect(values?.policy).toEqual({ interpolation: 'smooth', domain: 'free' });

      const alignment = findPropertyCoverage('caption.alignment-template') as AnyEntry | undefined;
      expect(alignment?.classification).toBe('creative');
      expect(alignment?.animationValueKind).toBe('string');
      expect(alignment?.policy).toEqual({ interpolation: 'hold', domain: 'free' });

      for (const key of ['caption.text', 'caption.timing']) {
        expect((findPropertyCoverage(key) as AnyEntry | undefined)?.classification).toBe(
          'structural',
        );
      }
    });
  });

  describe('color bindings address both target grades', () => {
    it.each([
      ['color-output.adjust', 'color-output', 'output'],
      ['color-output.grade-enabled', 'color-output', 'output'],
      ['color-output.wheels', 'color-output', 'output'],
      ['color-output.curves', 'color-output', 'output'],
      ['color-output.hsl', 'color-output', 'output'],
      ['color-output.lut-choice', 'color-output', 'output'],
      ['color-output.lut-intensity', 'color-output', 'output'],
      ['color-clip.adjust', 'color-clip', 'clip-local'],
      ['color-clip.grade-enabled', 'color-clip', 'clip-local'],
      ['color-clip.wheels', 'color-clip', 'clip-local'],
      ['color-clip.curves', 'color-clip', 'clip-local'],
      ['color-clip.hsl', 'color-clip', 'clip-local'],
      ['color-clip.lut-choice', 'color-clip', 'clip-local'],
      ['color-clip.lut-intensity', 'color-clip', 'clip-local'],
    ])('binds %s to %s/%s', (id, ownerKind, timeDomain) => {
      const entry = findPropertyCoverage(id) as AnyEntry | undefined;
      expect(entry?.binding).toEqual({ ownerKind, timeDomain });
    });
  });
});

describe('registry purity', () => {
  it('never imports React or an app package', () => {
    const files = [
      new URL('./property-coverage.ts', import.meta.url),
      new URL('./index.ts', import.meta.url),
    ];
    const forbidden = [
      /(^|['"]|\/)react/,
      /from ['"]@joy-media\/(editor-web|worker|api)/,
      /from ['"]\.\.?\/(apps|editor-web)/,
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${file.pathname} must not match ${pattern}`).toBe(false);
      }
    }
  });

  it('registry source is plain TypeScript with no JSX and no app subpath', () => {
    const source = readFileSync(new URL('./property-coverage.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('apps/editor-web');
    // JSX appears only as close tags (`</Name>` or `</>`); plain TS generics use
    // only opening angle brackets, so a close-tag regex is a reliable signal.
    expect(source).not.toMatch(/<\/[A-Za-z_$}]/);
    expect(source).not.toMatch(/React\./);
    expect(source).not.toContain('.tsx');
  });
});
