import type { MaskJobPayload } from '@joy-media/job-protocol';
import type { JsonValue } from '@joy-media/project-schema';
import type { AgentJobRequestTemplate } from './async-jobs.js';

export interface MaskAgentJobInput {
  readonly sourceKind: 'image' | 'video';
  readonly assetId: string;
  readonly sourceSha256: string;
  readonly settings: MaskJobPayload;
}

/**
 * Canonical Joy Code → control-plane request template for professional masks.
 * The existing async-plan executor supplies project/revision/idempotency data;
 * the Worker adapter forwards these arguments through the private lease API.
 */
export function createMaskAgentJobRequest(input: MaskAgentJobInput): AgentJobRequestTemplate {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.assetId))
    throw new Error('mask source asset ID must be opaque');
  if (!/^[a-f0-9]{64}$/.test(input.sourceSha256)) throw new Error('mask source hash is invalid');
  const prompt =
    input.settings.selection.prompt ??
    (input.settings.selection.mode === 'person' ? 'Select the primary person' : 'Select subject');
  return {
    jobType: input.sourceKind === 'image' ? 'mask.image' : 'mask.video',
    arguments: input.settings as unknown as JsonValue,
    inputAssetId: input.assetId,
    generation: {
      providerId: 'local-worker',
      modelId: input.settings.provider,
      modelVersion: 'joy.masking.v1',
      prompt,
      inputAssetHashes: [input.sourceSha256],
      parameters: input.settings as unknown as JsonValue,
    },
  };
}
