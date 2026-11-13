import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

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
    const defaults = extractEffectDefaults(effect);
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

/** Verifies manifest completeness, file presence, output hashes, input hashes, and byte budgets. */
export function verifyPreviewManifest(
  manifest: PreviewManifest,
  expected: ExpectedPreviewHashes,
  repoRoot: string,
): readonly string[] {
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

  return errors;
}
