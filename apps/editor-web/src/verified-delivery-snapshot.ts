import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { AssetBindingV2, RenderBundleV2 } from '@joy-media/render-planner';

export interface VerifiedDeliveryAssetMetadata {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly opaqueRef?: string;
}

export interface VerifiedDeliverySnapshotInput {
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly projectRef: string;
  readonly revision?: number;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly assets: Readonly<Record<string, VerifiedDeliveryAssetMetadata>>;
}

/** Mints one immutable normalized snapshot for one verified-delivery operation. */
export function createVerifiedDeliverySnapshot(
  input: VerifiedDeliverySnapshotInput,
): Promise<RenderBundleV2> {
  return import('../../../packages/render-planner/src/v2.js').then(
    ({ createCompositionPlanV2, createRenderBundleV2 }) => {
      const plan = createCompositionPlanV2(input);
      const needed = new Set<string>();
      for (const layer of plan.layers) if ('assetId' in layer) needed.add(layer.assetId);
      for (const layer of plan.audio) needed.add(layer.assetId);
      const bindings: Record<string, AssetBindingV2> = {};
      for (const assetId of needed) {
        const asset = input.assets[assetId];
        if (asset === undefined)
          throw new Error(`Verified delivery needs integrity metadata for ${assetId}.`);
        bindings[assetId] = {
          assetId,
          opaqueRef: asset.opaqueRef ?? `asset:${assetId}`,
          integrity: { sha256: asset.sha256, bytes: asset.bytes, mime: asset.mimeType },
          sha256: asset.sha256,
          bytes: asset.bytes,
          mimeType: asset.mimeType,
        };
      }
      return createRenderBundleV2({
        plan,
        assets: bindings,
        projectRef: input.projectRef,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
      });
    },
  );
}

/** Small operation-scoped cache: repeated queue/retry reads the same snapshot bytes. */
export class VerifiedDeliverySnapshotCache {
  readonly #snapshots = new Map<string, RenderBundleV2>();

  get(key: string): RenderBundleV2 | undefined {
    return this.#snapshots.get(key);
  }

  set(key: string, snapshot: RenderBundleV2): void {
    this.#snapshots.set(key, snapshot);
  }

  getOrCreate(key: string, factory: () => RenderBundleV2): RenderBundleV2 {
    const existing = this.#snapshots.get(key);
    if (existing !== undefined) return existing;
    const snapshot = factory();
    this.#snapshots.set(key, snapshot);
    return snapshot;
  }

  clear(key: string): void {
    this.#snapshots.delete(key);
  }
}
