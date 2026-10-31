import { UNHANDLED, type ChannelHandler } from './joy-desktop-bridge.js';
import type { BrowserAsset } from '../../../apps/editor-web/src/control-plane-client.js';

type MediaPayload = Record<string, unknown>;

interface RegisteredAsset {
  readonly asset: BrowserAsset;
  uploaded: boolean;
}

interface StoredDocument {
  readonly projectId: string;
  readonly revisionId: string;
  readonly document: unknown;
  readonly lookInstances?: unknown;
}

/**
 * Creates a bridge handler with in-memory state scoped to one Playwright page.
 * It supports local asset import and project document persistence only; worker
 * jobs and derivative access remain unavailable to the browser harness.
 */
export function createMediaHandlers(): ChannelHandler {
  const registrations = new Map<string, RegisteredAsset>();
  const originals = new Map<string, Uint8Array>();
  const documents = new Map<string, StoredDocument>();
  let activeProjectId = 'joy-media-e2e-project';

  const mimeTypeFor = (asset: MediaPayload): string => {
    const descriptor = asset['descriptor'];
    if (
      typeof descriptor === 'object' &&
      descriptor !== null &&
      typeof (descriptor as MediaPayload)['mimeType'] === 'string'
    ) {
      return (descriptor as MediaPayload)['mimeType'] as string;
    }
    const displayName = typeof asset['displayName'] === 'string' ? asset['displayName'] : '';
    const extension = displayName.slice(displayName.lastIndexOf('.')).toLowerCase();
    const knownTypes: Readonly<Record<string, string>> = {
      '.gif': 'image/gif',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.m4a': 'audio/mp4',
      '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.png': 'image/png',
      '.wav': 'audio/wav',
      '.webm': 'video/webm',
    };
    return knownTypes[extension] ?? 'application/octet-stream';
  };

  const catalogAssets = (): BrowserAsset[] =>
    [...registrations.values()]
      .filter((registration) => registration.uploaded)
      .map((registration) => registration.asset);

  const counts = () => {
    const assets = catalogAssets();
    return {
      total: assets.length,
      audio: assets.filter((asset) => asset.kind === 'audio').length,
      image: assets.filter((asset) => asset.kind === 'image').length,
    };
  };

  return (channel, rawPayload) => {
    const payload =
      typeof rawPayload === 'object' && rawPayload !== null
        ? (rawPayload as MediaPayload)
        : undefined;

    switch (channel) {
      case 'desktop.media.workers.list':
        return [];
      case 'desktop.media.asset.register': {
        const id = payload?.['id'];
        const kind = payload?.['kind'];
        const displayName = payload?.['displayName'];
        const sha256 = payload?.['sha256'];
        const bytes = payload?.['bytes'];
        if (
          typeof id !== 'string' ||
          (kind !== 'video' && kind !== 'audio' && kind !== 'image') ||
          typeof displayName !== 'string' ||
          typeof sha256 !== 'string' ||
          typeof bytes !== 'number'
        )
          return UNHANDLED;
        const descriptorPayload = payload?.['descriptor'];
        const descriptor = {
          ...(typeof descriptorPayload === 'object' && descriptorPayload !== null
            ? (descriptorPayload as Partial<BrowserAsset['descriptor']>)
            : {}),
          mimeType:
            typeof descriptorPayload === 'object' &&
            descriptorPayload !== null &&
            typeof (descriptorPayload as MediaPayload)['mimeType'] === 'string'
              ? ((descriptorPayload as MediaPayload)['mimeType'] as string)
              : mimeTypeFor(payload!),
        };
        const relativePath = `${kind === 'audio' ? 'audio' : kind === 'image' ? 'images' : 'video'}/${id}`;
        registrations.set(id, {
          asset: {
            id,
            projectId:
              typeof payload?.['projectId'] === 'string' ? payload['projectId'] : activeProjectId,
            kind,
            displayName,
            sha256,
            bytes,
            descriptor,
            createdAt: Date.now(),
            cloudBacked: false,
            relativePath,
          },
          uploaded: false,
        });
        return { id };
      }
      case 'desktop.media.asset.upload-original': {
        const assetId = payload?.['assetId'];
        const bytes = payload?.['bytes'];
        if (typeof assetId !== 'string' || !(bytes instanceof Uint8Array)) return UNHANDLED;
        const registration = registrations.get(assetId);
        if (registration === undefined) return UNHANDLED;
        originals.set(assetId, bytes.slice());
        registration.uploaded = true;
        return { assetId };
      }
      case 'desktop.asset-library.get-catalog': {
        const assets = catalogAssets();
        return { version: 1, counts: counts(), assets };
      }
      case 'desktop.asset-library.get-settings':
        return {
          directory: 'memory://joy-media-e2e/asset-library',
          exists: true,
          hasCatalog: true,
          isDefault: false,
          counts: counts(),
        };
      case 'desktop.media.project.document.get': {
        const projectId = payload?.['projectId'];
        const revisionId = payload?.['revisionId'];
        if (typeof projectId !== 'string') return UNHANDLED;
        activeProjectId = projectId;
        const stored = documents.get(projectId);
        return stored === undefined ||
          (revisionId !== undefined && revisionId !== stored.revisionId)
          ? null
          : stored;
      }
      case 'desktop.media.project.document.put': {
        const projectId = payload?.['projectId'];
        const revisionId = payload?.['revisionId'];
        if (typeof projectId !== 'string' || typeof revisionId !== 'string') return UNHANDLED;
        activeProjectId = projectId;
        const stored: StoredDocument = {
          projectId,
          revisionId,
          document: payload?.['document'],
          ...(payload?.['lookInstances'] === undefined
            ? {}
            : { lookInstances: payload['lookInstances'] }),
        };
        documents.set(projectId, stored);
        return { kind: 'saved', projectId, revisionId };
      }
      default:
        // Render jobs, job lifecycle, and derivative bytes need real local
        // workers or media stores; the harness does not fabricate their result.
        return UNHANDLED;
    }
  };
}
