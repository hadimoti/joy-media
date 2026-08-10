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

  constructor(options: ProjectMediaResolverOptions) {
    this.#options = options;
  }

  async resolve(assetId: string): Promise<ProjectMediaSource> {
    const existing = this.#sources.get(assetId);
    if (existing !== undefined) return existing;
    const pending = this.#pending.get(assetId);
    if (pending !== undefined) return pending;
    const request = this.#resolve(assetId).finally(() => this.#pending.delete(assetId));
    this.#pending.set(assetId, request);
    return request;
  }

  clear(): void {
    for (const source of this.#sources.values()) {
      if (source.source !== 'reference') URL.revokeObjectURL(source.url);
    }
    this.#sources.clear();
    this.#pending.clear();
  }

  async #resolve(assetId: string): Promise<ProjectMediaSource> {
    const descriptor = await this.#descriptor(assetId);
    const local = await this.#options.originalCache.get(assetId);
    if (local !== undefined && (await matchesDescriptor(local, descriptor))) {
      const source = this.#remember(assetId, {
        url: URL.createObjectURL(local),
        mimeType: mediaMimeType(descriptor, local),
        source: 'opfs',
      });
      return source;
    }

    try {
      let cloud: Blob;
      try {
        cloud = await this.#options.client.originalBytes(this.#options.projectId, assetId);
      } catch {
        // User-library assets can be placed on another project's timeline.
        // They remain owner-authorized through the shared library endpoint.
        cloud = await this.#options.client.sharedCloudOriginalBytes(assetId);
      }
      if (!(await matchesDescriptor(cloud, descriptor)))
        throw new Error(`owner media integrity check failed for ${assetId}`);
      return this.#remember(assetId, {
        url: URL.createObjectURL(cloud),
        mimeType: mediaMimeType(descriptor, cloud),
        source: 'cloud',
      });
    } catch (error) {
      if (
        REFERENCE_ASSET_IDS.has(assetId) &&
        (descriptor === undefined || !/^[a-f0-9]{64}$/.test(descriptor.sha256))
      ) {
        return this.#remember(assetId, {
          url: `/media/reference/${encodeURIComponent(assetId)}.mp4`,
          mimeType: 'video/mp4',
          source: 'reference',
        });
      }
      throw new Error(
        `Media ${descriptor?.displayName ?? assetId} is unavailable in local cache and owner storage`,
        { cause: error },
      );
    }
  }

  async #descriptor(assetId: string): Promise<BrowserAsset | undefined> {
    const projectAsset = this.#options.project?.assets[assetId];
    try {
      const catalogAsset = (await this.#options.client.assets(this.#options.projectId)).find(
        (asset) => asset.id === assetId,
      );
      if (catalogAsset !== undefined) return catalogAsset;
    } catch {
      /* OPFS and reference projects can resolve without a catalog request. */
    }
    if (projectAsset === undefined) return undefined;
    return {
      id: projectAsset.id,
      projectId: this.#options.projectId,
      kind: projectAsset.kind === 'other' ? 'image' : projectAsset.kind,
      displayName: projectAsset.displayName,
      sha256: projectAsset.sha256 ?? '',
      bytes: projectAsset.bytes ?? 0,
      descriptor: projectAsset.descriptor ?? { mimeType: 'application/octet-stream' },
      createdAt: Date.now(),
      cloudBacked: false,
    };
  }

  #remember(assetId: string, source: ProjectMediaSource): ProjectMediaSource {
    const existing = this.#sources.get(assetId);
    if (existing !== undefined) {
      if (source.source !== 'reference') URL.revokeObjectURL(source.url);
      return existing;
    }
    this.#sources.set(assetId, source);
    return source;
  }
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
