import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerBuiltins, effectRegistry } from '@joy-media/visual-effects';
import { effectEffectIds, filterEffectIds } from '../../../../apps/editor-web/src/library-homes.js';
import {
  parseCliArgs,
  parseLibraryAuditMarkdown,
  planParameterVariations,
  selectKeyframePlan,
} from './audit-metadata.mjs';
import {
  buildLibraryMarkdownReport,
  computeRgbaDiffMetrics,
  computeRgbaSpread,
} from './report.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const AUDIT_PATH = resolve(REPO_ROOT, 'docs/qa/v1.1.1/LIBRARY-AUDIT.md');

describe('library test harness metadata and reporting', () => {
  it('parses CLI options and rejects invalid values', () => {
    const parsed = parseCliArgs([
      '--kind',
      'effects',
      '--items',
      'brightness-contrast, halftone ,crt',
      '--limit',
      '3',
      '--out',
      './tmp-out',
      '--face',
      './face.png',
    ]);
    expect(parsed.kind).toBe('effects');
    expect(parsed.items).toEqual(['brightness-contrast', 'halftone', 'crt']);
    expect(parsed.limit).toBe(3);
    expect(parsed.outDir).toBe('./tmp-out');
    expect(parsed.facePath).toBe('./face.png');

    expect(parseCliArgs(['--kind', 'transitions']).kind).toBe('transitions');
    expect(() => parseCliArgs(['--kind', 'unknown-kind'])).toThrow(/Invalid --kind/);
    expect(() => parseCliArgs(['--limit', '0'])).toThrow(/Invalid --limit/);
    expect(() => parseCliArgs(['--items'])).toThrow(/Missing value/);
    expect(() => parseCliArgs(['--bogus'])).toThrow(/Unknown CLI argument/);
  });

  it('parses all 33 rows of LIBRARY-AUDIT.md matching library-homes and descriptors', () => {
    registerBuiltins();
    const auditMap = parseLibraryAuditMarkdown(readFileSync(AUDIT_PATH, 'utf8'));
    const filters = filterEffectIds();
    const effects = effectEffectIds();

    expect(filters).toHaveLength(15);
    expect(effects).toHaveLength(18);
    expect(auditMap.size).toBe(33);

    for (const id of filters) {
      const row = auditMap.get(id);
      expect(row?.home).toBe('filters');
      expect(effectRegistry.getEffect(id)).toBeDefined();
    }
    for (const id of effects) {
      const row = auditMap.get(id);
      expect(row?.home).toBe('effects');
      expect(effectRegistry.getEffect(id)).toBeDefined();
    }

    expect(auditMap.get('crt')?.keyframesPolicy).toBe('no');
    expect(auditMap.get('noise')?.keyframesPolicy).toBe('amount-only');
    expect(auditMap.get('unsharp-mask')?.keyframesPolicy).toBe('amount-only');
    expect(auditMap.get('sepia')?.exportFlag).toBe('yes');
    expect(auditMap.get('brightness-contrast')?.exportFlag).toBe('yes');
    expect(auditMap.get('halftone')?.exportFlag).toBe('no');
  });

  it('plans low/default/high parameter variations and keyframe plans for all 33 library items', () => {
    registerBuiltins();
    const auditMap = parseLibraryAuditMarkdown(readFileSync(AUDIT_PATH, 'utf8'));
    const allIds = [...filterEffectIds(), ...effectEffectIds()];

    for (const id of allIds) {
      const descriptor = effectRegistry.getEffect(id)!;
      const variations = planParameterVariations(descriptor);
      expect(variations.length).toBe(descriptor.params.length);

      for (const paramPlan of variations) {
        expect(paramPlan.cases.map((c) => c.tag)).toEqual(['low', 'default', 'high']);
        expect(paramPlan.resetSeed).not.toEqual(paramPlan.defaultValue);
      }

      const kfPlan = selectKeyframePlan(descriptor, auditMap.get(id));
      if (id === 'crt') {
        expect(kfPlan.skip).toBe(true);
      } else {
        expect(kfPlan.skip).toBe(false);
        expect(kfPlan.paramKey).toBeTypeOf('string');
        if (id === 'noise' || id === 'unsharp-mask') {
          expect(kfPlan.paramKey).toBe('amount');
        }
      }
    }
  });

  it('computes RGBA diffs, spread, and formats clean Markdown reports', () => {
    const black = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    const gray = new Uint8ClampedArray([30, 60, 90, 255, 0, 0, 0, 255]);
    const metrics = computeRgbaDiffMetrics(black, gray);
    expect(metrics.meanAbsDiff).toBeCloseTo(30, 5);
    expect(metrics.maxDiff).toBe(90);
    expect(metrics.changedPixels).toBe(1);
    expect(metrics.totalPixels).toBe(2);

    const spread = computeRgbaSpread(gray);
    expect(spread.maxChannelRange).toBe(90);

    const markdown = buildLibraryMarkdownReport({
      kind: 'filters',
      generatedAt: '2026-11-14T00:00:00.000Z',
      gitCommit: 'deadbeef',
      previewResolution: { width: 960, height: 540 },
      benchmarkResolution: { width: 1920, height: 1080 },
      exportDurationSec: 2,
      exportFps: 30,
      knownTestFramePath: 'known-test-frame-1080p.png',
      items: [
        {
          id: 'sepia',
          label: 'Sepia',
          passed: true,
          failureReasons: [],
          preview: { passed: true, vsBeforeMeanDiff: 18.4 },
          exportComparison: {
            ok: true,
            exportMode: 'offline-mp4',
            ffmpegBackendNative: true,
            meanAbsoluteChannelDelta: 1.25,
            maxChannelDelta: 9,
          },
          paramChecks: [{ key: 'amount', passed: true }],
          resetUndoRedo: { passed: true },
          keyframes: {
            skipped: false,
            policy: 'yes',
            paramKey: 'amount',
            midVsStartMeanDiff: 9.1,
            midVsEndMeanDiff: 9.4,
            passed: true,
          },
          perf1080p: { meanMsPerFrame: 2.34 },
          consoleErrors: [],
          pageErrors: [],
        },
      ],
    });

    expect(markdown).toContain('# Library Test Harness Report — filters');
    expect(markdown).toContain('`sepia`');
    expect(markdown).toContain('PASS Δ=1.25');
    expect(markdown).toContain('ffmpeg:native');
    expect(markdown).toContain('**PASS**');
  });
});
