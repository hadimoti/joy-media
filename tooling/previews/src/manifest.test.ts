import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTransitionShaders } from '../../../packages/transition-shaders/src/index.js';
import { listBuiltinEffects } from '../../../packages/visual-effects/src/index.js';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECOND_SOURCE_EFFECT_IDS,
  PREVIEW_DIFF_HEIGHT,
  PREVIEW_DIFF_WIDTH,
  PREVIEW_MANIFEST_PATH,
  PREVIEW_MIN_MEAN_DIFF_FROM_BEFORE,
  PREVIEW_SIZE_BUDGETS,
  PREVIEW_SOURCES_DIR,
  SECOND_SOURCE_PHOTO,
  checkEffectStillMetrics,
  computeExpectedPreviewHashes,
  measureStillVsBefore,
  safeTransitionFileId,
  transitionStripProgresses,
  verifyPreviewManifest,
  type PreviewManifest,
} from './manifest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

describe('preview manifest and generated WebP assets', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(REPO_ROOT, PREVIEW_MANIFEST_PATH), 'utf8'),
  ) as PreviewManifest;
  const effects = listBuiltinEffects();
  const transitions = listTransitionShaders();

  it('covers every built-in filter, effect, before still, and transition catalog entry cleanly', () => {
    expect(effects.length).toBe(33);
    expect(transitions.length).toBe(38);
    expect(manifest.effects.length).toBe(effects.length);
    expect(manifest.transitions.length).toBe(transitions.length);

    const expected = computeExpectedPreviewHashes({
      repoRoot: REPO_ROOT,
      effects,
      transitions,
      secondSourceEffectIds: DEFAULT_SECOND_SOURCE_EFFECT_IDS,
    });
    const errors = verifyPreviewManifest(manifest, expected, REPO_ROOT, { verifyPixels: true });
    expect(errors).toEqual([]);
  });

  it('stays within still, per-transition, and combined preview byte budgets', () => {
    const stillsTotal =
      manifest.before.bytes + manifest.effects.reduce((sum, entry) => sum + entry.bytes, 0);
    const transitionsTotal = manifest.transitions.reduce((sum, entry) => sum + entry.bytes, 0);
    const total = stillsTotal + transitionsTotal;

    expect(stillsTotal).toBeLessThanOrEqual(PREVIEW_SIZE_BUDGETS.maxStillsTotalBytes);
    for (const transition of manifest.transitions) {
      expect(transition.bytes).toBeLessThanOrEqual(PREVIEW_SIZE_BUDGETS.maxTransitionBytes);
      expect(transition.frameCount).toBe(24);
    }
    expect(total).toBeLessThan(PREVIEW_SIZE_BUDGETS.maxTotalBytes);
  });

  it('fails verification when a filter default parameter or shader source changes without rebuilding', () => {
    const mutatedEffects = effects.map((effect, index) =>
      index === 0
        ? {
            ...effect,
            params: effect.params.map((p, pIndex) =>
              pIndex === 0 ? { ...p, defaultValue: 9999 } : p,
            ),
          }
        : effect,
    );
    const expectedFromChangedDefault = computeExpectedPreviewHashes({
      repoRoot: REPO_ROOT,
      effects: mutatedEffects,
      transitions,
    });
    const defaultErrors = verifyPreviewManifest(manifest, expectedFromChangedDefault, REPO_ROOT, {
      verifyPixels: false,
    });
    expect(defaultErrors).toContainEqual(
      expect.stringContaining(`effect "${effects[0]!.id}": stale inputHash`),
    );

    const expectedFromChangedShader = computeExpectedPreviewHashes({
      repoRoot: REPO_ROOT,
      effects,
      transitions,
      effectShaderDigestOverride: 'modified-shader-implementation',
    });
    const shaderErrors = verifyPreviewManifest(manifest, expectedFromChangedShader, REPO_ROOT, {
      verifyPixels: false,
    });
    expect(shaderErrors.length).toBeGreaterThanOrEqual(effects.length);
  });

  it('fails verification when a transition GLSL shader or default parameter changes without rebuilding', () => {
    const mutatedTransitions = transitions.map((entry, index) =>
      index === 0 ? { ...entry, glsl: `${entry.glsl}\n// mutated` } : entry,
    );
    const expected = computeExpectedPreviewHashes({
      repoRoot: REPO_ROOT,
      effects,
      transitions: mutatedTransitions,
    });
    const errors = verifyPreviewManifest(manifest, expected, REPO_ROOT, { verifyPixels: false });
    expect(errors).toContainEqual(
      expect.stringContaining(`transition "${transitions[0]!.id}": stale inputHash`),
    );
  });

  it('fails pixel gate with item id when a still is blank or too close to Before', () => {
    const byteCount = PREVIEW_DIFF_WIDTH * PREVIEW_DIFF_HEIGHT * 3;
    const beforeBuf = Buffer.alloc(byteCount);
    for (let i = 0; i < byteCount; i++) {
      beforeBuf[i] = (i * 17) % 256;
    }

    const blankBuf = Buffer.alloc(byteCount, 24);
    const blankMetrics = measureStillVsBefore(beforeBuf, blankBuf);
    const blankError = checkEffectStillMetrics('pixelate', blankMetrics);
    expect(blankError).toContain('pixelate');
    expect(blankError).toContain('blank');

    const identicalError = checkEffectStillMetrics(
      'edge-detect',
      measureStillVsBefore(beforeBuf, beforeBuf),
    );
    expect(identicalError).toContain('edge-detect');
    expect(identicalError).toContain(`meanAbsDiff=0.00 < ${PREVIEW_MIN_MEAN_DIFF_FROM_BEFORE}`);

    const shiftedBuf = Buffer.from(beforeBuf);
    for (let i = 0; i < byteCount; i++) {
      shiftedBuf[i] = Math.min(255, beforeBuf[i]! + 25);
    }
    expect(
      checkEffectStillMetrics('sepia', measureStillVsBefore(beforeBuf, shiftedBuf)),
    ).toBeNull();
  });

  it('supports switching selected effects onto the second-source photo and maps filesystem-safe IDs', () => {
    expect(existsSync(resolve(REPO_ROOT, PREVIEW_SOURCES_DIR, SECOND_SOURCE_PHOTO))).toBe(true);
    const expectedSecond = computeExpectedPreviewHashes({
      repoRoot: REPO_ROOT,
      effects,
      transitions,
      secondSourceEffectIds: ['vignette'],
    });
    const vignetteExpected = expectedSecond.effects.get('vignette');
    const vignetteManifest = manifest.effects.find((e) => e.id === 'vignette');
    expect(vignetteExpected?.inputs.secondSource).toBe(true);
    expect(vignetteExpected?.inputs.sourcePicture).toBe(SECOND_SOURCE_PHOTO);
    expect(vignetteExpected?.inputHash).not.toBe(vignetteManifest?.inputHash);

    expect(safeTransitionFileId('gl:fade')).toBe('gl-fade');
    expect(safeTransitionFileId('joy:dipToBlack')).toBe('joy-dipToBlack');

    const progresses = transitionStripProgresses();
    expect(progresses).toHaveLength(24);
    expect(progresses.slice(0, 3)).toEqual([0, 0, 0]);
    expect(progresses.slice(-4)).toEqual([1, 1, 1, 1]);
    expect(progresses[3]).toBeGreaterThan(0);
    expect(progresses[19]).toBeLessThan(1);
  });
});
