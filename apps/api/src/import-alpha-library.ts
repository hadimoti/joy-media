/**
 * Root-only import command for the curated JOY Media alpha asset library.
 *
 * The object bytes must already have been rclone-verified in the private
 * ParsPack prefix. This command only registers their opaque refs in PostgreSQL.
 */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { ControlPlaneError, type Actor, type ControlPlane } from './control-plane.js';
import { PostgresControlPlane } from './postgres-control-plane.js';

const PROJECT_ID = 'joy-media-alpha-library';
const PROJECT_TITLE = 'JOY Media Asset Library';
const OWNER_ID = 'joy-media-library';

interface AlphaLibraryManifest {
  readonly schemaVersion: number;
  readonly project: {
    readonly id: string;
    readonly title: string;
    readonly ownerId: string;
  };
  readonly assets: readonly AlphaLibraryAsset[];
}

interface AlphaLibraryAsset {
  readonly id: string;
  readonly ref: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly kind: 'image' | 'audio';
  readonly displayName: string;
  readonly sortName: string;
  readonly tags: readonly string[];
  readonly descriptor: {
    readonly mimeType: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationUs?: number;
  };
}

export interface AlphaLibraryImportResult {
  readonly created: number;
  readonly updated: number;
  readonly total: number;
}

export async function importAlphaLibrary(
  controlPlane: Pick<
    ControlPlane,
    | 'createProject'
    | 'setAssetSync'
    | 'registerAsset'
    | 'attachCloudOriginal'
    | 'updateAssetMetadata'
  >,
  manifest: AlphaLibraryManifest,
): Promise<AlphaLibraryImportResult> {
  validateManifest(manifest);
  const owner: Actor = { id: OWNER_ID };
  try {
    await controlPlane.createProject(owner, PROJECT_ID, PROJECT_TITLE);
  } catch (error) {
    if (!(error instanceof ControlPlaneError) || error.code !== 'PROJECT_EXISTS') throw error;
  }
  // This is an explicit operator-controlled cloud-library import. The consent
  // is recorded before any existing private-object reference is reattached.
  await controlPlane.setAssetSync(owner, PROJECT_ID, true);

  let created = 0;
  let updated = 0;
  for (const asset of manifest.assets) {
    const registration = {
      id: asset.id,
      kind: asset.kind,
      displayName: asset.displayName,
      sha256: asset.sha256,
      bytes: asset.bytes,
      descriptor: asset.descriptor,
      locations: [{ kind: 'private-object' as const, ref: asset.ref }],
    };
    try {
      await controlPlane.registerAsset(owner, PROJECT_ID, registration);
      await controlPlane.updateAssetMetadata(owner, PROJECT_ID, asset.id, {
        tags: asset.tags,
        sortName: asset.sortName,
      });
      created += 1;
    } catch (error) {
      if (!(error instanceof ControlPlaneError) || error.code !== 'ASSET_EXISTS') throw error;
      await controlPlane.attachCloudOriginal(owner, PROJECT_ID, asset.id, {
        kind: 'private-object',
        ref: asset.ref,
      });
      await controlPlane.updateAssetMetadata(owner, PROJECT_ID, asset.id, {
        tags: asset.tags,
        sortName: asset.sortName,
        displayName: asset.displayName,
      });
      updated += 1;
    }
  }
  return { created, updated, total: manifest.assets.length };
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  const databaseUrl = process.env.JOY_MEDIA_DATABASE_URL;
  if (!manifestPath || !databaseUrl) {
    throw new Error(
      'Usage: JOY_MEDIA_DATABASE_URL=... node import-alpha-library.js <cloud-import-manifest.json>',
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AlphaLibraryManifest;
  const pool = new Pool({ connectionString: databaseUrl });
  const controlPlane = new PostgresControlPlane(pool);
  try {
    await controlPlane.initialize();
    console.log(JSON.stringify(await importAlphaLibrary(controlPlane, manifest)));
  } finally {
    await pool.end();
  }
}

function validateManifest(manifest: AlphaLibraryManifest): void {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.project.id !== PROJECT_ID ||
    manifest.project.title !== PROJECT_TITLE ||
    manifest.project.ownerId !== OWNER_ID ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length === 0
  ) {
    throw new TypeError('cloud import manifest does not target the JOY Media library');
  }
  const ids = new Set<string>();
  for (const asset of manifest.assets) {
    const { mimeType, width, height, durationUs } = asset.descriptor;
    const validMediaDescriptor =
      asset.kind === 'image'
        ? mimeType === 'image/png' &&
          Number.isSafeInteger(width) &&
          (width ?? 0) >= 1 &&
          Number.isSafeInteger(height) &&
          (height ?? 0) >= 1 &&
          durationUs === undefined
        : asset.kind === 'audio'
          ? (mimeType === 'audio/wav' || mimeType === 'audio/mpeg') &&
            width === undefined &&
            height === undefined &&
            (durationUs === undefined || (Number.isSafeInteger(durationUs) && durationUs >= 1))
          : false;
    if (
      asset.id !== asset.ref ||
      !/^joylib-[a-f0-9]{64}$/.test(asset.id) ||
      asset.sha256 !== asset.id.slice('joylib-'.length) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      !validMediaDescriptor ||
      typeof asset.displayName !== 'string' ||
      asset.displayName.length === 0 ||
      asset.displayName.length > 255 ||
      /[\\/]/.test(asset.displayName) ||
      typeof asset.sortName !== 'string' ||
      asset.sortName.length === 0 ||
      asset.sortName.length > 255 ||
      !Array.isArray(asset.tags) ||
      asset.tags.length > 32 ||
      asset.tags.some(
        (tag: unknown) => typeof tag !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,47}$/.test(tag),
      ) ||
      ids.has(asset.id)
    ) {
      throw new TypeError('invalid cloud library asset: ' + asset.id);
    }
    ids.add(asset.id);
  }
}

if (process.argv[1]?.endsWith('import-alpha-library.js')) {
  await main();
}
