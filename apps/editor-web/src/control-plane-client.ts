import type {
  JoyProjectV1,
  LookInstancesDocument,
  ProjectRevisionId,
} from '@joy-media/project-schema';

export interface BrowserWorker {
  readonly id: string;
  readonly paired: boolean;
  readonly revoked: boolean;
  readonly capabilities: readonly string[];
  readonly localAssetIds?: readonly string[];
  readonly lastSeenAt?: number;
  readonly modelInventory?: {
    readonly managerVersion: string;
    readonly cacheStatus: 'ready' | 'read-only' | 'unavailable';
    readonly freeBytes?: number;
    readonly models: readonly {
      readonly modelId: string;
      readonly version: string;
      readonly state: string;
      readonly progress?: number;
      readonly installedBytes?: number;
      readonly errorCode?: string;
    }[];
  };
}

export interface BrowserJob {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly assetId?: string;
  readonly state: 'queued' | 'leased' | 'completed' | 'canceled' | 'failed';
  readonly progress: number;
  readonly cancelRequested: boolean;
  readonly error?: string;
  readonly derivative?: {
    readonly id: string;
    readonly jobId: string;
    readonly kind: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly workerRef: string;
    readonly resultRef: string;
    readonly verifiedAt: number;
  };
}

/** Owner-safe catalog metadata. Locations are deliberately not exposed to the editor UI. */
export interface BrowserAsset {
  readonly id: string;
  readonly projectId: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: BrowserMediaDescriptor;
  readonly tags?: readonly string[];
  readonly sortName?: string;
  readonly createdAt: number;
  readonly cloudBacked: boolean;
  readonly relativePath?: string;
}

export interface BrowserMediaDescriptor {
  readonly mimeType: string;
  readonly durationUs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly animation?: BrowserAnimationDescriptor;
}

export interface BrowserAnimationDescriptor {
  readonly frameCount: number;
  readonly cycleDurationUs: number;
  /** Zero means the source declares infinite looping. */
  readonly loopCount: number;
  readonly hasAlpha: boolean;
}

export interface BrowserDerivative {
  readonly id: string;
  readonly projectId: string;
  readonly assetId: string;
  readonly kind: 'thumbnail' | 'proxy' | 'audio' | 'mask' | 'upscale';
  readonly profile: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: BrowserMediaDescriptor;
  readonly availability: 'pending' | 'available-local' | 'available-cloud' | 'evicted' | 'invalid';
  readonly verifiedAt: number;
}

export interface BrowserReasoningProvider {
  readonly providerId: string;
  readonly state:
    'unconfigured' | 'configured' | 'healthy' | 'degraded' | 'offline' | 'unauthorized';
  readonly models: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly version?: string;
  }[];
  readonly adapterVersion: string;
}

export interface BrowserSpectralDenoiseResult {
  readonly assetId: string;
  readonly mimeType: string;
  readonly bytesBase64: string;
  readonly method: 'ffmpeg-afftdn';
  readonly strength: number;
}

export interface BrowserSpectralDenoiseOperation {
  readonly projectId: string;
  readonly operationId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly result?: BrowserSpectralDenoiseResult;
  readonly error?: string;
  readonly leaseExpiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BrowserProjectMetadata {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly ownerId: string;
  readonly assetSyncEnabled: boolean;
  readonly trashedAt?: number;
  readonly activeJobCount: number;
}

/** Owner-authorized canonical document returned by the control plane. */
export interface BrowserProjectDocument {
  readonly projectId: string;
  readonly revisionId: ProjectRevisionId;
  readonly document: JoyProjectV1;
  /**
   * The canonical Look Instances document (R2 / GAP 1a). Absent when the server
   * row predates Look sync (or has never carried Look info) — a Look-aware
   * client then keeps its local Look document untouched.
   */
  readonly lookInstances?: LookInstancesDocument;
}

export interface BrowserProjectDuplicateResult {
  readonly project: BrowserProjectMetadata;
  readonly assetIdMap: Readonly<Record<string, string>>;
  readonly derivativeIdMap: Readonly<Record<string, string>>;
}

export interface BrowserGpuPreviewSession {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly workerId: string;
  readonly expiresAtMs: number;
}

export interface BrowserGpuPreviewFrame {
  readonly blob: Blob;
  readonly requestId: number;
  readonly renderer: 'hardware-gpu';
  readonly quality: 'quarter' | 'half' | 'full';
  readonly width: number;
  readonly height: number;
}

export interface BrowserAssetRegistration {
  readonly id: string;
  readonly kind: BrowserAsset['kind'];
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: BrowserMediaDescriptor;
  readonly locations: readonly { readonly kind: 'opfs-cache'; readonly ref: string }[];
}

export const RESUMABLE_ORIGINAL_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** The local client lives in local-media-client.ts; these names stay for existing imports. */
export {
  BrowserControlPlaneClient,
  BrowserControlPlaneRequestError,
} from './local-media-client.js';
