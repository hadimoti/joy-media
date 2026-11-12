import {
  decodeColorLutReference,
  isColorGradeV2,
  type JoyProjectV1,
} from '@joy-media/project-schema';
import type { ColorGradeIR } from '@joy-media/render-ir';
import { MAX_CUBE_LUT_BYTES, parseCubeLut, type ParsedCubeLut } from '@joy-media/renderer-pixi';

export interface ProjectColorLutResolver {
  /** Synchronous renderer lookup. Missing data starts a deduplicated async read. */
  readonly resolveColorLut: (grade: ColorGradeIR) => ParsedCubeLut | undefined;
  /** Loads every custom LUT referenced by this project before deterministic export. */
  readonly prepareProjectColorLuts: () => Promise<void>;
}

export interface ProjectColorLutResolverOptions {
  readonly project: JoyProjectV1;
  /** Reads by opaque project asset id through the app's existing media channel. */
  readonly loadProjectAssetBlob: (assetId: string) => Promise<Blob | undefined>;
  readonly onReady?: () => void;
  readonly onWarning?: (message: string) => void;
}

interface CustomLutReference {
  readonly assetId: string;
  readonly sha256: string;
}

/**
 * Parses integrity-checked .cube asset bytes for the synchronous renderer.
 * This helper never receives or opens a filesystem path.
 */
export function createProjectColorLutResolver(
  options: ProjectColorLutResolverOptions,
): ProjectColorLutResolver {
  const ready = new Map<string, ParsedCubeLut>();
  const pending = new Map<string, Promise<void>>();
  const warned = new Set<string>();

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    options.onWarning?.(message);
  };

  const prepareReference = (reference: CustomLutReference): Promise<void> => {
    const key = referenceKey(reference);
    if (ready.has(key)) return Promise.resolve();
    const existing = pending.get(key);
    if (existing !== undefined) return existing;

    const asset = options.project.assets[reference.assetId];
    if (
      asset?.kind !== 'lut' ||
      asset.sha256 !== reference.sha256 ||
      !/^[a-f0-9]{64}$/.test(reference.sha256)
    ) {
      warnOnce(
        key,
        `${asset?.displayName ?? 'Custom LUT'} could not be used because its project asset reference is missing or changed. The rest of the color grade is still applied.`,
      );
      return Promise.resolve();
    }

    const request = (async () => {
      const blob = await options.loadProjectAssetBlob(reference.assetId);
      if (blob === undefined) throw new Error('the project asset could not be read');
      if (blob.size > MAX_CUBE_LUT_BYTES)
        throw new Error(`the file exceeds the ${MAX_CUBE_LUT_BYTES / (1024 * 1024)} MiB limit`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if ((await sha256Hex(bytes)) !== reference.sha256)
        throw new Error('the file SHA-256 does not match the project reference');
      ready.set(key, parseCubeLut(bytes));
      options.onReady?.();
    })()
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : 'an unknown read error occurred';
        warnOnce(
          key,
          `${asset.displayName} could not be loaded as a .cube LUT (${reason}). The rest of the color grade is still applied without it.`,
        );
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, request);
    return request;
  };

  const resolveColorLut = (grade: ColorGradeIR): ParsedCubeLut | undefined => {
    if (
      grade.lut !== undefined &&
      (grade.lut.assetId !== undefined || grade.lut.sha256 !== undefined) &&
      (grade.lut.assetId === undefined || grade.lut.sha256 === undefined)
    ) {
      const key = JSON.stringify(['incomplete-custom-lut', grade.lut.assetId, grade.lut.sha256]);
      warnOnce(
        key,
        'Custom LUT could not be used because its project asset reference is incomplete. The rest of the color grade is still applied.',
      );
      return undefined;
    }
    const reference = customReference(grade.lut);
    if (reference === undefined) return undefined;
    const key = referenceKey(reference);
    const parsed = ready.get(key);
    if (parsed !== undefined) return parsed;
    void prepareReference(reference);
    return undefined;
  };

  const prepareProjectColorLuts = async (): Promise<void> => {
    await Promise.all(collectProjectColorLutReferences(options.project).map(prepareReference));
  };

  return { resolveColorLut, prepareProjectColorLuts };
}

function customReference(lut: ColorGradeIR['lut']): CustomLutReference | undefined {
  return lut?.assetId === undefined || lut.sha256 === undefined
    ? undefined
    : { assetId: lut.assetId, sha256: lut.sha256 };
}

function collectProjectColorLutReferences(project: JoyProjectV1): CustomLutReference[] {
  const references = new Map<string, CustomLutReference>();
  const add = (reference: CustomLutReference | undefined): void => {
    if (reference !== undefined) references.set(referenceKey(reference), reference);
  };
  const addGrade = (grade: JoyProjectV1['colorGrade'] | undefined): void => {
    if (isColorGradeV2(grade)) add(customReference(grade.lut));
  };

  addGrade(project.colorGrade);
  for (const grade of Object.values(project.clipColorGrades ?? {})) addGrade(grade);
  for (const animation of Object.values(project.propertyAnimations ?? {})) {
    if (
      (animation.binding.ownerKind !== 'color-output' &&
        animation.binding.ownerKind !== 'color-clip') ||
      animation.binding.propertyId !== 'lut.reference' ||
      animation.value.kind !== 'string'
    )
      continue;
    for (const key of animation.value.keys) {
      if (typeof key.value !== 'string') continue;
      const decoded = decodeColorLutReference(key.value);
      if (typeof decoded?.assetId === 'string' && typeof decoded.sha256 === 'string')
        add({ assetId: decoded.assetId, sha256: decoded.sha256 });
    }
  }
  return [...references.values()];
}

function referenceKey(reference: CustomLutReference): string {
  return JSON.stringify([reference.assetId, reference.sha256]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
