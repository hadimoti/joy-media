import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { BrowserAsset, BrowserControlPlaneClient } from './control-plane-client.js';
import type { OpfsOriginalAssetCache } from './opfs-original-asset-cache.js';

export interface ProjectMediaSource {
  readonly url: string;
  readonly mimeType: string;
  readonly source: 'opfs' | 'cloud' | 'reference';
}

export interface ProjectMediaResolverOptions {
  readonly projectId: string;
  /** Project-scoped API calls wait until the authenticated owner is known. */
  readonly controlPlaneReady?: boolean;
  readonly project?: JoyProjectV1;
  readonly client: Pick<
    BrowserControlPlaneClient,
    'assets' | 'originalBytes' | 'sharedCloudOriginalBytes'
  >;
  readonly originalCache: Pick<OpfsOriginalAssetCache, 'get'>;
}

const REFERENCE_ASSET_IDS = new Set(['asset-intro', 'asset-product', 'asset-outro']);

function mediaMimeType(asset: BrowserAsset | undefined, blob: Blob): string {
  const blobType = blob.type.trim().toLowerCase();
  const expectedPrefix = asset === undefined ? undefined : `${asset.kind}/`;
  if (expectedPrefix !== undefined && blobType.startsWith(expectedPrefix)) return blobType;
  return asset?.descriptor.mimeType || blobType || 'application/octet-stream';
}

/**
 * Resolves project media without exposing storage locations to creative data.
 * OPFS is preferred for offline-first playback; an owner-authorized API read is
 * the durable fallback. Reference files are intentionally allowlisted.
 */
export class ProjectMediaResolver {
  readonly #options: ProjectMediaResolverOptions;
  readonly #sources = new Map<string, ProjectMediaSource>();
  readonly #pending = new Map<string, Promise<ProjectMediaSource>>();
  #epoch = 0;

  constructor(options: ProjectMediaResolverOptions) {
    this.#options = options;
  }

  async resolve(assetId: string): Promise<ProjectMediaSource> {
    const existing = this.#sources.get(assetId);
    if (existing !== undefined) return existing;
    const pending = this.#pending.get(assetId);
    if (pending !== undefined) return pending;
    const epoch = this.#epoch;
    const request = this.#resolve(assetId, epoch).finally(() => {
      // An older request must not remove a new epoch's in-flight lookup.
      if (this.#pending.get(assetId) === request) this.#pending.delete(assetId);
      this.#assertEpoch(epoch);
    });
    this.#pending.set(assetId, request);
    return request;
  }

  clear(): void {
    this.#epoch += 1;
    for (const source of this.#sources.values()) {
      if (source.source !== 'reference') URL.revokeObjectURL(source.url);
    }
    this.#sources.clear();
    this.#pending.clear();
  }

  async #resolve(assetId: string, epoch: number): Promise<ProjectMediaSource> {
    const descriptor = await this.#descriptor(assetId);
    this.#assertEpoch(epoch);
    const local = await this.#options.originalCache.get(assetId);
    this.#assertEpoch(epoch);
    if (local !== undefined && (await matchesDescriptor(local, descriptor))) {
      const source = this.#remember(
        assetId,
        {
          url: URL.createObjectURL(local),
          mimeType: mediaMimeType(descriptor, local),
          source: 'opfs',
        },
        epoch,
      );
      return source;
    }
    this.#assertEpoch(epoch);

    if (this.#options.controlPlaneReady === false) {
      if (
        REFERENCE_ASSET_IDS.has(assetId) &&
        (descriptor === undefined || !/^[a-f0-9]{64}$/.test(descriptor.sha256))
      ) {
        return this.#remember(
          assetId,
          {
            url: `/media/reference/${encodeURIComponent(assetId)}.mp4`,
            mimeType: 'video/mp4',
            source: 'reference',
          },
          epoch,
        );
      }
      throw new Error('Authenticated media session is not ready');
    }

    try {
      let cloud: Blob;
      try {
        cloud = await this.#options.client.originalBytes(this.#options.projectId, assetId);
      } catch {
        this.#assertEpoch(epoch);
        // User-library assets can be placed on another project's timeline.
        // They remain owner-authorized through the shared library endpoint.
        cloud = await this.#options.client.sharedCloudOriginalBytes(assetId);
      }
      this.#assertEpoch(epoch);
      if (!(await matchesDescriptor(cloud, descriptor)))
        throw new Error(`owner media integrity check failed for ${assetId}`);
      return this.#remember(
        assetId,
        {
          url: URL.createObjectURL(cloud),
          mimeType: mediaMimeType(descriptor, cloud),
          source: 'cloud',
        },
        epoch,
      );
    } catch (error) {
      this.#assertEpoch(epoch);
      if (
        REFERENCE_ASSET_IDS.has(assetId) &&
        (descriptor === undefined || !/^[a-f0-9]{64}$/.test(descriptor.sha256))
      ) {
        return this.#remember(
          assetId,
          {
            url: `/media/reference/${encodeURIComponent(assetId)}.mp4`,
            mimeType: 'video/mp4',
            source: 'reference',
          },
          epoch,
        );
      }
      throw new Error(
        `Media ${descriptor?.displayName ?? assetId} is unavailable in local cache and owner storage`,
        { cause: error },
      );
    }
  }

  async #descriptor(assetId: string): Promise<BrowserAsset | undefined> {
    const projectAsset = this.#options.project?.assets[assetId];
    if (this.#options.controlPlaneReady === false)
      return projectAssetDescriptor(projectAsset, this.#options.projectId);
    try {
      const catalogAsset = (await this.#options.client.assets(this.#options.projectId)).find(
        (asset) => asset.id === assetId,
      );
      if (catalogAsset !== undefined) return catalogAsset;
    } catch {
      /* OPFS and reference projects can resolve without a catalog request. */
    }
    return projectAssetDescriptor(projectAsset, this.#options.projectId);
  }

  #assertEpoch(epoch: number): void {
    if (epoch !== this.#epoch) throw new Error('Media resolution was invalidated');
  }

  #remember(assetId: string, source: ProjectMediaSource, epoch: number): ProjectMediaSource {
    if (epoch !== this.#epoch) {
      if (source.source !== 'reference') URL.revokeObjectURL(source.url);
      this.#assertEpoch(epoch);
    }
    const existing = this.#sources.get(assetId);
    if (existing !== undefined) {
      if (source.source !== 'reference') URL.revokeObjectURL(source.url);
      return existing;
    }
    this.#sources.set(assetId, source);
    return source;
  }
}

function projectAssetDescriptor(
  projectAsset: JoyProjectV1['assets'][string] | undefined,
  projectId: string,
): BrowserAsset | undefined {
  if (projectAsset === undefined) return undefined;
  return {
    id: projectAsset.id,
    projectId,
    kind:
      projectAsset.kind === 'other' || projectAsset.kind === 'lut' ? 'image' : projectAsset.kind,
    displayName: projectAsset.displayName,
    sha256: projectAsset.sha256 ?? '',
    bytes: projectAsset.bytes ?? 0,
    descriptor: projectAsset.descriptor ?? { mimeType: 'application/octet-stream' },
    createdAt: Date.now(),
    cloudBacked: false,
  };
}

async function matchesDescriptor(
  blob: Blob,
  descriptor: BrowserAsset | undefined,
): Promise<boolean> {
  if (descriptor?.bytes !== undefined && descriptor.bytes > 0 && blob.size !== descriptor.bytes)
    return false;
  const expected = descriptor?.sha256?.toLowerCase();
  if (expected === undefined || !/^[a-f0-9]{64}$/.test(expected)) return true;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return actual === expected;
}
