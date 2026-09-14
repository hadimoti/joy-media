import type {
  PublishReleaseInput,
  ReleaseMetadataApi,
  ReleaseRecord,
} from './release-metadata-service.js';
import type { ReleaseManifestPayload, ReleaseSigner } from './release-signing.js';

/**
 * The only server-side path that can publish a desktop release. It signs the exact payload
 * that is stored in `release_metadata`; there is deliberately no public publish route and no
 * fallback key. A disabled signer therefore keeps publishing fail-closed.
 */
export interface ReleasePublishRequest {
  readonly id: string;
  readonly payload: ReleaseManifestPayload;
}

export interface ReleasePublisher {
  publish(request: ReleasePublishRequest): Promise<ReleaseRecord>;
}

export function createReleasePublisher(options: {
  readonly metadata: ReleaseMetadataApi;
  readonly signer: ReleaseSigner;
}): ReleasePublisher {
  return {
    async publish({ id, payload }) {
      const signed = options.signer.sign(payload);
      const input: PublishReleaseInput = {
        id,
        ...payload,
        signature: signed.signature,
      };
      return options.metadata.publish(input);
    },
  };
}
