/** P00.6 local-first asset identity/location proof. */

import { createHash } from 'node:crypto';

export type AssetKind = 'video' | 'image';
export type DerivativeKind = 'thumbnail' | 'proxy';

export interface AssetLocation {
  readonly kind: 'worker-file';
  readonly workerId: string;
  /** Opaque local-reference token; it is never a path or a URL. */
  readonly opaquePathId: string;
}

export interface AssetDerivative {
  readonly id: string;
  readonly kind: DerivativeKind;
  readonly sourceAssetId: string;
  readonly byteLength: number;
  readonly location: AssetLocation;
}

/** Serializable record safe for a project/control-plane boundary. */
export interface AssetRecord {
  readonly id: string;
  readonly kind: AssetKind;
  readonly displayName: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly locations: readonly AssetLocation[];
  readonly derivatives: readonly AssetDerivative[];
}

/** Input received only by a permission-scoped desktop/Worker bridge. */
export interface LocalFileSelection {
  readonly absolutePath: string;
  readonly displayName: string;
  readonly kind: AssetKind;
  readonly contentHash: string;
  readonly byteLength: number;
}

export interface LocalDerivativeRequest {
  readonly sourcePath: string;
  readonly kind: DerivativeKind;
  readonly maxEdgePx: number;
}

export interface LocalDerivativeOutput {
  readonly byteLength: number;
}

export type LocalDerivativeExecutor = (request: LocalDerivativeRequest) => LocalDerivativeOutput;

export class AssetBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AssetBridgeError';
    this.code = code;
  }
}

interface PrivateLocation {
  readonly assetId: string;
  readonly absolutePath: string;
}

/**
 * A permission-scoped local bridge. It alone resolves physical paths; callers
 * receive safe asset records and request derivatives by asset ID only.
 */
export class LocalAssetBridge {
  readonly #records = new Map<string, AssetRecord>();
  readonly #privateLocations = new Map<string, PrivateLocation>();
  #nextAsset = 1;
  #nextDerivative = 1;

  constructor(
    private readonly workerId: string,
    private readonly executeLocalDerivative: LocalDerivativeExecutor,
  ) {
    if (workerId.length === 0)
      throw new AssetBridgeError('ASSET_BRIDGE_WORKER_INVALID', 'workerId required');
  }

  /** Registers a selected local file immediately without uploading/copying its original bytes. */
  registerSelectedFile(selection: LocalFileSelection): AssetRecord {
    validateSelection(selection);
    const assetId = `asset-${this.#nextAsset++}`;
    const opaquePathId = opaqueId(this.workerId, assetId, selection.absolutePath);
    const location: AssetLocation = { kind: 'worker-file', workerId: this.workerId, opaquePathId };
    this.#privateLocations.set(opaquePathId, { assetId, absolutePath: selection.absolutePath });
    const record: AssetRecord = {
      id: assetId,
      kind: selection.kind,
      displayName: selection.displayName,
      contentHash: selection.contentHash,
      byteLength: selection.byteLength,
      locations: [location],
      derivatives: [],
    };
    this.#records.set(assetId, record);
    return record;
  }

  /** Generates a local thumbnail/proxy from the private location; returns only a derivative reference. */
  generateDerivative(assetId: string, kind: DerivativeKind, maxEdgePx: number): AssetDerivative {
    if (!Number.isSafeInteger(maxEdgePx) || maxEdgePx < 1) {
      throw new AssetBridgeError(
        'ASSET_DERIVATIVE_INVALID',
        'maxEdgePx must be a positive integer',
      );
    }
    const record = this.requireRecord(assetId);
    const sourceLocation = record.locations[0];
    if (sourceLocation === undefined)
      throw new AssetBridgeError('ASSET_LOCATION_MISSING', 'asset has no local location');
    const privateLocation = this.#privateLocations.get(sourceLocation.opaquePathId);
    if (privateLocation === undefined || privateLocation.assetId !== assetId) {
      throw new AssetBridgeError(
        'ASSET_LOCATION_UNRESOLVABLE',
        'opaque location is not locally resolvable',
      );
    }
    const output = this.executeLocalDerivative({
      sourcePath: privateLocation.absolutePath,
      kind,
      maxEdgePx,
    });
    if (!Number.isSafeInteger(output.byteLength) || output.byteLength < 1) {
      throw new AssetBridgeError(
        'ASSET_DERIVATIVE_INVALID',
        'local derivative output must have a positive byte length',
      );
    }
    const id = `derivative-${this.#nextDerivative++}`;
    const derivative: AssetDerivative = {
      id,
      kind,
      sourceAssetId: assetId,
      byteLength: output.byteLength,
      location: {
        kind: 'worker-file',
        workerId: this.workerId,
        opaquePathId: opaqueId(this.workerId, id, `${sourceLocation.opaquePathId}:${kind}`),
      },
    };
    const next = { ...record, derivatives: [...record.derivatives, derivative] };
    this.#records.set(assetId, next);
    return derivative;
  }

  /** Produces the only asset shape allowed to cross to the browser/VPS. */
  controlPlaneRecord(assetId: string): AssetRecord {
    return cloneRecord(this.requireRecord(assetId));
  }

  private requireRecord(assetId: string): AssetRecord {
    const record = this.#records.get(assetId);
    if (record === undefined)
      throw new AssetBridgeError('ASSET_UNKNOWN', `unknown asset "${assetId}"`);
    return record;
  }
}

function validateSelection(selection: LocalFileSelection): void {
  if (
    selection.absolutePath.length === 0 ||
    selection.displayName.length === 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(selection.contentHash) ||
    !Number.isSafeInteger(selection.byteLength) ||
    selection.byteLength < 1
  ) {
    throw new AssetBridgeError('ASSET_SELECTION_INVALID', 'selection metadata is invalid');
  }
}

function opaqueId(workerId: string, id: string, localValue: string): string {
  return createHash('sha256').update(`${workerId}\u0000${id}\u0000${localValue}`).digest('hex');
}

function cloneRecord(record: AssetRecord): AssetRecord {
  return {
    ...record,
    locations: record.locations.map((location) => ({ ...location })),
    derivatives: record.derivatives.map((derivative) => ({
      ...derivative,
      location: { ...derivative.location },
    })),
  };
}
