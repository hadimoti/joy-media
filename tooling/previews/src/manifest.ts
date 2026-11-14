import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const PREVIEW_DIFF_WIDTH = 64;
export const PREVIEW_DIFF_HEIGHT = 48;
export const PREVIEW_MIN_MEAN_DIFF_FROM_BEFORE = 1.5;
export const PREVIEW_MIN_STDDEV = 2.0;

/**
 * Showcase preview parameter overrides for effects whose neutral builtin defaults are 0
 * so the preview thumbnail clearly shows the effect while clip defaults stay neutral.
 */
export const PREVIEW_PARAM_OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
  {
    'brightness-contrast': { brightness: 0.18, contrast: 0.32 },
    'hue-saturation': { hue: 0.28, saturation: 0.45 },
    vibrance: { amount: 0.85 },
    curves: { shadows: -0.22, midtones: 0.2, highlights: 0.24 },
    bulge: { amount: 0.65, radius: 0.48 },
    twist: { angle: 1.35, radius: 0.55 },
  };

/** Bump whenever cropping, framing, encoding, or strip layout changes. */
export const BUILDER_VERSION = 't-v02-v1';

/** Fixed 4:3 crop centered on the fox and "O" in the 1457x904 owner source images. */
export const PREVIEW_CROP = {
  x: 281,
  y: 144,
  width: 920,
  height: 690,
} as const;

export const EFFECT_STILL_SPEC = {
  width: 320,
  height: 240,
  quality: 82,
} as const;

export const TRANSITION_STRIP_SPEC = {
  frameCount: 24,
  frameWidth: 144,
  frameHeight: 108,
  quality: 60,
  holdStartFrames: 3,
  holdEndFrames: 4,
} as const;

export const PREVIEW_SIZE_BUDGETS = {
  maxStillsTotalBytes: 1_000_000,
  maxTransitionBytes: 150_000,
  maxTotalBytes: 2_000_000,
} as const;

export const PREVIEW_MANIFEST_PATH = 'tooling/previews/manifest.json';
export const PREVIEW_SOURCES_DIR = 'apps/editor-web/preview-sources';
export const EFFECT_PREVIEW_PUBLIC_DIR = 'apps/editor-web/public/effects/preview';
export const TRANSITION_PREVIEW_PUBLIC_DIR = 'apps/editor-web/public/transitions/preview';

export const DEFAULT_EFFECT_SOURCE = 'filter-preview-source-2.jpg';
export const SECOND_SOURCE_PHOTO = 'autumn-path.png';
export const TRANSITION_PIC1_SOURCE = 'transition-preview-pic1.jpg';
export const TRANSITION_PIC2_SOURCE = 'transition-preview-pic2.jpg';

/** Default list of effect IDs rendered from the photo source instead of flat art (populated in T-V04). */
export const DEFAULT_SECOND_SOURCE_EFFECT_IDS: readonly string[] = [];

export interface EffectDescriptorInput {
  readonly id: string;
  readonly params: readonly { readonly key: string; readonly defaultValue: unknown }[];
}

export interface TransitionShaderInput {
  readonly id: string;
  readonly glslFile: string;
  readonly glsl: string;
  readonly defaultParams: Readonly<Record<string, unknown>>;
}

export interface PreviewEntryInputs {
  readonly sourcePicture: string;
  readonly sourceSha256: string;
  readonly shaderSource: string;
  readonly defaultValues: Record<string, unknown>;
  readonly builderVersion: string;
  readonly secondSource: boolean;
}

export interface EffectPreviewManifestEntry {
  readonly id: string;
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly outputSha256: string;
  readonly inputHash: string;
  readonly inputs: PreviewEntryInputs;
}

export interface TransitionPreviewManifestEntry {
  readonly id: string;
  readonly safeId: string;
  readonly outputPath: string;
  readonly frameCount: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly outputSha256: string;
  readonly inputHash: string;
  readonly inputs: {
    readonly sourcePictures: readonly string[];
    readonly sourceSha256s: readonly string[];
    readonly shaderSource: string;
    readonly defaultValues: Record<string, unknown>;
    readonly builderVersion: string;
  };
}

export interface PreviewManifest {
  readonly version: 1;
  readonly builderVersion: string;
  readonly crop: typeof PREVIEW_CROP;
  readonly secondSourceEffectIds: readonly string[];
  readonly before: Omit<EffectPreviewManifestEntry, 'id'>;
  readonly effects: readonly EffectPreviewManifestEntry[];
  readonly transitions: readonly TransitionPreviewManifestEntry[];
  readonly summary: {
    readonly stillsCount: number;
    readonly stillsTotalBytes: number;
    readonly transitionsCount: number;
    readonly transitionsTotalBytes: number;
    readonly maxTransitionBytes: number;
    readonly totalBytes: number;
  };
}

/** Converts a transition registry id (e.g. `gl:fade`) into a filesystem-safe basename (`gl-fade`). */
export function safeTransitionFileId(transitionId: string): string {
  return transitionId.replace(/:/g, '-');
}

/** Computes progress values in [0, 1] across a 24-frame hold -> transition -> hold strip. */
export function transitionStripProgresses(
  spec: typeof TRANSITION_STRIP_SPEC = TRANSITION_STRIP_SPEC,
): readonly number[] {
  const { frameCount, holdStartFrames, holdEndFrames } = spec;
  const activeFrames = frameCount - holdStartFrames - holdEndFrames;
  if (activeFrames <= 0) {
    throw new RangeError('Transition strip must have at least one active transition frame');
  }
  const values: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    if (i < holdStartFrames) {
      values.push(0);
    } else if (i >= frameCount - holdEndFrames) {
      values.push(1);
    } else {
      const step = i - holdStartFrames + 1;
      values.push(Number((step / (activeFrames + 1)).toFixed(6)));
    }
  }
  return values;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Recursively sorts object keys for canonical hashing. */
export function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalizeValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function computeInputHash(payload: unknown): string {
  return sha256Hex(JSON.stringify(canonicalizeValue(payload)));
}

export function extractEffectDefaults(descriptor: EffectDescriptorInput): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const param of descriptor.params) {
    defaults[param.key] = canonicalizeValue(param.defaultValue);
  }
  return canonicalizeValue(defaults) as Record<string, unknown>;
}

/** Resolves effective preview parameters, applying showcase overrides only when builtin defaults are 0. */
export function resolveEffectPreviewParams(
  descriptor: EffectDescriptorInput,
): Record<string, unknown> {
  const defaults = extractEffectDefaults(descriptor);
  const overrides = PREVIEW_PARAM_OVERRIDES[descriptor.id];
  if (!overrides) return defaults;
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof merged[key] === 'number' && merged[key] === 0) {
      merged[key] = value;
    }
  }
  return canonicalizeValue(merged) as Record<string, unknown>;
}

export interface StillPixelMetrics {
  readonly meanAbsDiff: number;
  readonly stddev: number;
}

/** Downsamples a WebP image to raw 64x48 RGB24 bytes via ffmpeg area resampling. */
export function downsampleWebpTo64x48Rgb(absWebpPath: string): Buffer {
  const expectedLength = PREVIEW_DIFF_WIDTH * PREVIEW_DIFF_HEIGHT * 3;
  const rgb = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      absWebpPath,
      '-vf',
      `scale=${PREVIEW_DIFF_WIDTH}:${PREVIEW_DIFF_HEIGHT}:flags=area`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 1024 * 1024 },
  );
  if (rgb.length !== expectedLength) {
    throw new Error(
      `Expected ${expectedLength} RGB24 bytes from ${absWebpPath}, got ${rgb.length}`,
    );
  }
  return rgb;
}

/** Computes mean absolute pixel difference vs Before and spread over 64x48 RGB24 buffers. */
export function measureStillVsBefore(beforeRgb: Buffer, effectRgb: Buffer): StillPixelMetrics {
  if (beforeRgb.length === 0 || beforeRgb.length !== effectRgb.length) {
    throw new RangeError(`RGB buffer length mismatch (${beforeRgb.length} vs ${effectRgb.length})`);
  }
  const channelCount = effectRgb.length;
  let sumDiff = 0;
  let sumVal = 0;
  let sumSq = 0;
  for (let i = 0; i < channelCount; i++) {
    const e = effectRgb[i]!;
    const b = beforeRgb[i]!;
    sumDiff += Math.abs(e - b);
    sumVal += e;
    sumSq += e * e;
  }
  const mean = sumVal / channelCount;
  const variance = Math.max(0, sumSq / channelCount - mean * mean);
  return {
    meanAbsDiff: sumDiff / channelCount,
    stddev: Math.sqrt(variance),
  };
}

/** Returns an error string naming the item id when a still is blank or too close to Before. */
export function checkEffectStillMetrics(
  effectId: string,
  metrics: StillPixelMetrics,
  minMeanDiff = PREVIEW_MIN_MEAN_DIFF_FROM_BEFORE,
  minStddev = PREVIEW_MIN_STDDEV,
): string | null {
  if (metrics.stddev < minStddev) {
    return `effect "${effectId}": preview still is blank/uniform (64x48 stddev=${metrics.stddev.toFixed(2)} < ${minStddev})`;
  }
  if (metrics.meanAbsDiff < minMeanDiff) {
    return `effect "${effectId}": preview still is too close to before (64x48 meanAbsDiff=${metrics.meanAbsDiff.toFixed(2)} < ${minMeanDiff})`;
  }
  return null;
}

/** Measures every effect preview still against Before over a 64x48 RGB downsample. */
export function inspectEffectStillsMetrics(
  manifest: PreviewManifest,
  repoRoot: string,
): Map<string, StillPixelMetrics> {
  const beforeAbs = resolve(repoRoot, manifest.before.outputPath);
  const results = new Map<string, StillPixelMetrics>();
  if (!existsSync(beforeAbs)) return results;
  const beforeRgb = downsampleWebpTo64x48Rgb(beforeAbs);
  for (const entry of manifest.effects) {
    const absPath = resolve(repoRoot, entry.outputPath);
    if (!existsSync(absPath)) continue;
    results.set(entry.id, measureStillVsBefore(beforeRgb, downsampleWebpTo64x48Rgb(absPath)));
  }
  return results;
}

interface EffectShaderFiles {
  readonly effectsPixi: string;
  readonly creativeEffects: string;
  readonly brightnessContrastFilter: string;
  readonly browserRenderer: string;
}

export function readEffectShaderFiles(repoRoot: string): EffectShaderFiles {
  return {
    effectsPixi: normalizeLineEndings(
      readFileSync(resolve(repoRoot, 'packages/renderer-pixi/src/effects-pixi.ts'), 'utf8'),
    ),
    creativeEffects: normalizeLineEndings(
      readFileSync(resolve(repoRoot, 'packages/renderer-pixi/src/creative-effects.ts'), 'utf8'),
    ),
    brightnessContrastFilter: normalizeLineEndings(
      readFileSync(
        resolve(repoRoot, 'packages/visual-effects/src/factories/pixi/BrightnessContrastFilter.ts'),
        'utf8',
      ),
    ),
    browserRenderer: normalizeLineEndings(
      readFileSync(resolve(repoRoot, 'packages/renderer-pixi/src/browser.ts'), 'utf8'),
    ),
  };
}

export function readTransitionWrapperSource(repoRoot: string): string {
  return normalizeLineEndings(
    readFileSync(resolve(repoRoot, 'packages/renderer-pixi/src/gl-transition-filter.ts'), 'utf8'),
  );
}

/** Computes a deterministic hash covering all Pixi effect shader implementations and dispatch code. */
export function effectShaderImplementationDigest(files: EffectShaderFiles): string {
  return sha256Hex(
    [
      'effects-pixi.ts:',
      files.effectsPixi,
      'creative-effects.ts:',
      files.creativeEffects,
      'BrightnessContrastFilter.ts:',
      files.brightnessContrastFilter,
      'browser.ts:',
      files.browserRenderer,
    ].join('\n'),
  );
}

export interface ExpectedPreviewHashes {
  readonly beforeInputHash: string;
  readonly beforeInputs: PreviewEntryInputs;
  readonly effects: ReadonlyMap<
    string,
    {
      readonly inputHash: string;
      readonly inputs: PreviewEntryInputs;
      readonly outputPath: string;
    }
  >;
  readonly transitions: ReadonlyMap<
    string,
    {
      readonly safeId: string;
      readonly inputHash: string;
      readonly inputs: TransitionPreviewManifestEntry['inputs'];
      readonly outputPath: string;
    }
  >;
}

export function computeExpectedPreviewHashes(options: {
  readonly repoRoot: string;
  readonly effects: readonly EffectDescriptorInput[];
  readonly transitions: readonly TransitionShaderInput[];
  readonly secondSourceEffectIds?: readonly string[];
  readonly effectShaderDigestOverride?: string;
  readonly transitionWrapperOverride?: string;
}): ExpectedPreviewHashes {
  const { repoRoot, effects, transitions } = options;
  const secondSet = new Set(options.secondSourceEffectIds ?? DEFAULT_SECOND_SOURCE_EFFECT_IDS);

  const defaultSourcePath = resolve(repoRoot, PREVIEW_SOURCES_DIR, DEFAULT_EFFECT_SOURCE);
  const secondSourcePath = resolve(repoRoot, PREVIEW_SOURCES_DIR, SECOND_SOURCE_PHOTO);
  const pic1Path = resolve(repoRoot, PREVIEW_SOURCES_DIR, TRANSITION_PIC1_SOURCE);
  const pic2Path = resolve(repoRoot, PREVIEW_SOURCES_DIR, TRANSITION_PIC2_SOURCE);

  const defaultSourceSha = sha256Hex(readFileSync(defaultSourcePath));
  const secondSourceSha = existsSync(secondSourcePath)
    ? sha256Hex(readFileSync(secondSourcePath))
    : '';
  const pic1Sha = sha256Hex(readFileSync(pic1Path));
  const pic2Sha = sha256Hex(readFileSync(pic2Path));

  const effectShaderDigest =
    options.effectShaderDigestOverride ??
    effectShaderImplementationDigest(readEffectShaderFiles(repoRoot));
  const transitionWrapperSha = sha256Hex(
    options.transitionWrapperOverride ?? readTransitionWrapperSource(repoRoot),
  );

  const beforeInputs: PreviewEntryInputs = {
    sourcePicture: DEFAULT_EFFECT_SOURCE,
    sourceSha256: defaultSourceSha,
    shaderSource: 'none',
    defaultValues: {},
    builderVersion: BUILDER_VERSION,
    secondSource: false,
  };
  const beforeInputHash = computeInputHash({
    ...beforeInputs,
    crop: PREVIEW_CROP,
    stillSpec: EFFECT_STILL_SPEC,
  });

  const expectedEffects = new Map<
    string,
    { readonly inputHash: string; readonly inputs: PreviewEntryInputs; readonly outputPath: string }
  >();
  for (const effect of effects) {
    const useSecond = secondSet.has(effect.id);
    if (useSecond && secondSourceSha.length === 0) {
      throw new Error(`Missing second source photo at ${secondSourcePath} for "${effect.id}"`);
    }
    const builtinDefaults = extractEffectDefaults(effect);
    const defaults = resolveEffectPreviewParams(effect);
    const inputs: PreviewEntryInputs = {
      sourcePicture: useSecond ? SECOND_SOURCE_PHOTO : DEFAULT_EFFECT_SOURCE,
      sourceSha256: useSecond ? secondSourceSha : defaultSourceSha,
      shaderSource: effectShaderDigest,
      defaultValues: defaults,
      builderVersion: BUILDER_VERSION,
      secondSource: useSecond,
    };
    const inputHash = computeInputHash({
      id: effect.id,
      ...inputs,
      builtinDefaults,
      crop: useSecond ? 'center-4:3' : PREVIEW_CROP,
      stillSpec: EFFECT_STILL_SPEC,
    });
    expectedEffects.set(effect.id, {
      inputHash,
      inputs,
      outputPath: `${EFFECT_PREVIEW_PUBLIC_DIR}/${effect.id}.webp`,
    });
  }

  const expectedTransitions = new Map<
    string,
    {
      readonly safeId: string;
      readonly inputHash: string;
      readonly inputs: TransitionPreviewManifestEntry['inputs'];
      readonly outputPath: string;
    }
  >();
  for (const entry of transitions) {
    const safeId = safeTransitionFileId(entry.id);
    const glslSha = sha256Hex(
      JSON.stringify([entry.glslFile, normalizeLineEndings(entry.glsl), transitionWrapperSha]),
    );
    const defaults = canonicalizeValue(entry.defaultParams) as Record<string, unknown>;
    const inputs: TransitionPreviewManifestEntry['inputs'] = {
      sourcePictures: [TRANSITION_PIC1_SOURCE, TRANSITION_PIC2_SOURCE],
      sourceSha256s: [pic1Sha, pic2Sha],
      shaderSource: glslSha,
      defaultValues: defaults,
      builderVersion: BUILDER_VERSION,
    };
    const inputHash = computeInputHash({
      id: entry.id,
      safeId,
      ...inputs,
      crop: PREVIEW_CROP,
      stripSpec: TRANSITION_STRIP_SPEC,
    });
    expectedTransitions.set(entry.id, {
      safeId,
      inputHash,
      inputs,
      outputPath: `${TRANSITION_PREVIEW_PUBLIC_DIR}/${safeId}.webp`,
    });
  }

  return {
    beforeInputHash,
    beforeInputs,
    effects: expectedEffects,
    transitions: expectedTransitions,
  };
}

/** Verifies manifest completeness, file presence, output hashes, input hashes, byte budgets, and 64x48 pixel diff gate. */
export function verifyPreviewManifest(
  manifest: PreviewManifest,
  expected: ExpectedPreviewHashes,
  repoRoot: string,
  options: { readonly verifyPixels?: boolean } = {},
): readonly string[] {
  const verifyPixels = options.verifyPixels ?? true;
  const errors: string[] = [];

  if (manifest.builderVersion !== BUILDER_VERSION) {
    errors.push(
      `manifest builderVersion mismatch: ${manifest.builderVersion} !== ${BUILDER_VERSION}`,
    );
  }

  const checkFile = (
    label: string,
    relPath: string,
    expectedSha: string,
    expectedBytes: number,
  ) => {
    const absPath = resolve(repoRoot, relPath);
    if (!existsSync(absPath)) {
      errors.push(`${label}: missing file ${relPath}`);
      return;
    }
    const stat = statSync(absPath);
    if (stat.size !== expectedBytes) {
      errors.push(
        `${label}: byte size mismatch for ${relPath} (${stat.size} !== ${expectedBytes})`,
      );
    }
    const buf = readFileSync(absPath);
    const header = buf.subarray(0, 4).toString('ascii');
    const brand = buf.subarray(8, 12).toString('ascii');
    if (header !== 'RIFF' || brand !== 'WEBP') {
      errors.push(`${label}: ${relPath} does not have a valid RIFF/WEBP signature`);
    }
    const actualSha = sha256Hex(buf);
    if (actualSha !== expectedSha) {
      errors.push(`${label}: outputSha256 mismatch for ${relPath}`);
    }
  };

  if (manifest.before.inputHash !== expected.beforeInputHash) {
    errors.push('before: stale inputHash (source picture or builder changed)');
  }
  checkFile(
    'before',
    manifest.before.outputPath,
    manifest.before.outputSha256,
    manifest.before.bytes,
  );

  const byEffectId = new Map(manifest.effects.map((entry) => [entry.id, entry]));
  for (const [id, exp] of expected.effects) {
    const actual = byEffectId.get(id);
    if (actual === undefined) {
      errors.push(`effect "${id}": missing from manifest`);
      continue;
    }
    if (actual.outputPath !== exp.outputPath) {
      errors.push(`effect "${id}": outputPath ${actual.outputPath} !== ${exp.outputPath}`);
    }
    if (actual.inputHash !== exp.inputHash) {
      errors.push(`effect "${id}": stale inputHash (shader, defaults, or source changed)`);
    }
    checkFile(`effect "${id}"`, actual.outputPath, actual.outputSha256, actual.bytes);
  }
  for (const actual of manifest.effects) {
    if (!expected.effects.has(actual.id)) {
      errors.push(`effect "${actual.id}": unexpected entry in manifest`);
    }
  }

  const byTransitionId = new Map(manifest.transitions.map((entry) => [entry.id, entry]));
  for (const [id, exp] of expected.transitions) {
    const actual = byTransitionId.get(id);
    if (actual === undefined) {
      errors.push(`transition "${id}": missing from manifest`);
      continue;
    }
    if (actual.outputPath !== exp.outputPath) {
      errors.push(`transition "${id}": outputPath ${actual.outputPath} !== ${exp.outputPath}`);
    }
    if (actual.inputHash !== exp.inputHash) {
      errors.push(`transition "${id}": stale inputHash (GLSL, defaults, or source changed)`);
    }
    if (actual.bytes > PREVIEW_SIZE_BUDGETS.maxTransitionBytes) {
      errors.push(
        `transition "${id}": ${actual.bytes} bytes exceeds ${PREVIEW_SIZE_BUDGETS.maxTransitionBytes} budget`,
      );
    }
    checkFile(`transition "${id}"`, actual.outputPath, actual.outputSha256, actual.bytes);
  }
  for (const actual of manifest.transitions) {
    if (!expected.transitions.has(actual.id)) {
      errors.push(`transition "${actual.id}": unexpected entry in manifest`);
    }
  }

  const stillsTotalBytes =
    manifest.before.bytes + manifest.effects.reduce((sum, entry) => sum + entry.bytes, 0);
  const transitionsTotalBytes = manifest.transitions.reduce((sum, entry) => sum + entry.bytes, 0);
  const totalBytes = stillsTotalBytes + transitionsTotalBytes;

  if (stillsTotalBytes > PREVIEW_SIZE_BUDGETS.maxStillsTotalBytes) {
    errors.push(
      `stills total ${stillsTotalBytes} bytes exceeds ${PREVIEW_SIZE_BUDGETS.maxStillsTotalBytes} budget`,
    );
  }
  if (totalBytes >= PREVIEW_SIZE_BUDGETS.maxTotalBytes) {
    errors.push(
      `total preview set ${totalBytes} bytes must be < ${PREVIEW_SIZE_BUDGETS.maxTotalBytes}`,
    );
  }

  if (verifyPixels) {
    const beforeAbsPath = resolve(repoRoot, manifest.before.outputPath);
    if (existsSync(beforeAbsPath)) {
      const beforeRgb = downsampleWebpTo64x48Rgb(beforeAbsPath);
      const beforeSpread = measureStillVsBefore(beforeRgb, beforeRgb);
      if (beforeSpread.stddev < PREVIEW_MIN_STDDEV) {
        errors.push(
          `before: preview still is blank/uniform (64x48 stddev=${beforeSpread.stddev.toFixed(2)} < ${PREVIEW_MIN_STDDEV})`,
        );
      }
      for (const actual of manifest.effects) {
        const effectAbsPath = resolve(repoRoot, actual.outputPath);
        if (!existsSync(effectAbsPath)) continue;
        const effectRgb = downsampleWebpTo64x48Rgb(effectAbsPath);
        const metrics = measureStillVsBefore(beforeRgb, effectRgb);
        const pixelError = checkEffectStillMetrics(actual.id, metrics);
        if (pixelError !== null) {
          errors.push(pixelError);
        }
      }
    }
  }

  return errors;
}
