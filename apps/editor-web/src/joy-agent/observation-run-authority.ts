import type { HostRpcRun } from './host-rpc.js';
import type { JoyAgentObservationCurrentAuthority } from './observation-tool-adapter.js';

/** Immutable facts captured while one structured JOY run is being prepared. */
export interface JoyAgentObservationAuthorityExpectation {
  readonly projectId: string;
  readonly revision: string;
  readonly modelId: string;
  readonly promptPolicyDigest: string;
}

/** Live facts supplied by the mounted editor host at an observation boundary. */
export interface JoyAgentObservationAuthorityCandidate extends JoyAgentObservationAuthorityExpectation {
  /** Present only while the exact host RPC run is still live. */
  readonly run: HostRpcRun | undefined;
  readonly terminal: boolean;
}

/**
 * Turns live host facts into a scoped observation authority only when every
 * run, project, revision, model, and policy fence still matches. The adapter
 * performs its own syntax validation; this helper is solely the stale-state
 * gate used by AgentPanel before a host RPC can read local media.
 */
export function resolveJoyAgentObservationAuthority(
  expected: JoyAgentObservationAuthorityExpectation,
  candidate: JoyAgentObservationAuthorityCandidate,
): JoyAgentObservationCurrentAuthority | undefined {
  if (
    candidate.terminal ||
    candidate.run === undefined ||
    candidate.projectId !== expected.projectId ||
    candidate.revision !== expected.revision ||
    candidate.modelId !== expected.modelId ||
    candidate.promptPolicyDigest !== expected.promptPolicyDigest
  )
    return undefined;
  return Object.freeze({
    projectId: expected.projectId,
    revision: expected.revision,
    run: Object.freeze({ runId: candidate.run.runId, epoch: candidate.run.epoch }),
    modelId: expected.modelId,
    promptPolicyDigest: expected.promptPolicyDigest,
  });
}
