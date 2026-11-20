import type { JoyAgentEngineClient } from './engine-client.js';
import type { PrivateObservationAuthority } from './observation-transfer-port-protocol.js';
import { MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES } from './observation-transfer-port-protocol.js';
import type { ObservationEvidencePayload } from './multimodal-transport.js';
import type { QcFrameTransport, QcFrameTransportInput } from './qc-host-adapter.js';

const QC_PRIVATE_LEASE_MS = 60_000;

export interface QcPrivateFrameTransportOptions {
  readonly engineClient: Pick<
    JoyAgentEngineClient,
    'registerObservationReviewLease' | 'sendApprovedImageObservation'
  >;
  readonly currentAuthority: () => PrivateObservationAuthority | undefined;
  readonly now?: () => number;
}

/** Sends only the already-approved QC JPEGs over the private Worker port. */
export function createQcPrivateFrameTransport(
  options: QcPrivateFrameTransportOptions,
): QcFrameTransport {
  const now = options.now ?? Date.now;

  return Object.freeze({
    async analyze(input: QcFrameTransportInput) {
      const authority = options.currentAuthority();
      if (authority === undefined || input.signal.aborted || input.frames.length === 0)
        return { ok: false } as const;

      const evidenceIds =
        input.contactSheet === undefined
          ? input.frames.map((frame) => frame.frameId)
          : [`qc-contact-${input.reportId}`];
      const blobs =
        input.contactSheet === undefined
          ? input.frames.map((frame) => frame.jpeg)
          : [input.contactSheet];
      const maxBytes = blobs.reduce((total, blob) => total + blob.size, 0);
      if (
        maxBytes < 1 ||
        maxBytes > MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES ||
        evidenceIds.length > 16
      )
        return { ok: false } as const;

      const startUs = Math.min(...input.frames.map((frame) => frame.timestampUs));
      const endUs = Math.max(...input.frames.map((frame) => frame.timestampUs)) + 1;
      if (!Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs) || endUs <= startUs)
        return { ok: false } as const;
      const range = { domain: 'composition' as const, startUs, endUs };
      const expiresAtMs = now() + QC_PRIVATE_LEASE_MS;
      let lease;
      try {
        lease = await options.engineClient.registerObservationReviewLease({
          authority,
          manifestId: input.reportId,
          range,
          evidenceIds,
          expiresAtMs,
        });
      } catch {
        return { ok: false } as const;
      }
      if (lease === undefined || input.signal.aborted) return { ok: false } as const;

      const evidenceById = new Map<string, Blob>(
        evidenceIds.map((id, index) => [id, blobs[index]!]),
      );
      const evidenceResolver = {
        async resolve(request: {
          readonly authority: PrivateObservationAuthority;
          readonly evidenceIds: readonly string[];
          readonly signal: AbortSignal;
        }): Promise<readonly ObservationEvidencePayload[] | undefined> {
          if (
            request.signal.aborted ||
            !sameAuthority(request.authority, authority) ||
            !sameIds(request.evidenceIds, evidenceIds)
          )
            return undefined;
          try {
            const payload: ObservationEvidencePayload[] = [];
            for (const id of evidenceIds) {
              const blob = evidenceById.get(id);
              if (blob === undefined || blob.type !== 'image/jpeg') return undefined;
              payload.push({
                evidenceId: id,
                modality: 'image',
                mimeType: 'image/jpeg',
                data: new Uint8Array(await blob.arrayBuffer()),
              });
            }
            return payload;
          } catch {
            return undefined;
          }
        },
      };

      const prompt =
        input.tool === 'media_frames_view'
          ? `Review the supplied finished timeline frame images for this concern: ${input.reason ?? 'general visual quality'}. Return concise observations only.`
          : 'Review the supplied contact sheet of finished timeline frames for visible quality issues. Return concise observations only.';
      try {
        const result = await options.engineClient.sendApprovedImageObservation({
          leaseId: lease.leaseId,
          authority,
          range,
          evidenceIds,
          maxBytes,
          expiresAtMs: lease.expiresAtMs,
          prompt,
          evidenceResolver,
          signal: input.signal,
        });
        if (
          !result.ok ||
          input.signal.aborted ||
          !sameAuthority(options.currentAuthority(), authority)
        )
          return { ok: false } as const;
        return { ok: true, analysis: result.analysis.text } as const;
      } catch {
        return { ok: false } as const;
      }
    },
  });
}

function sameAuthority(
  left: PrivateObservationAuthority | undefined,
  right: PrivateObservationAuthority,
): boolean {
  return (
    left !== undefined &&
    left.projectId === right.projectId &&
    left.revision === right.revision &&
    left.run.runId === right.run.runId &&
    left.run.epoch === right.run.epoch &&
    left.modelId === right.modelId &&
    left.promptPolicyDigest === right.promptPolicyDigest
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
