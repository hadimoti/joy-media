import type { HostRpcRun } from './host-rpc.js';
import type { JoyAgentRunController } from './run-controller.js';
import { isTerminalJoyAgentRunState } from './run-events.js';

/**
 * A non-transferable lease for the host methods installed by one Composer
 * mount. The project run controller remains alive when Dockview remounts a
 * panel, but an old React closure cannot keep using its host RPC methods once
 * its lease is revoked.
 *
 * The lease contains neither a writer nor a project object. It is only an
 * exact run/epoch fence checked by the trusted main-thread callbacks.
 */
export interface JoyAgentComposerHostLease {
  readonly run: HostRpcRun;
}

interface LeaseState {
  readonly controller: JoyAgentRunController;
  revoked: boolean;
}

const leaseStates = new WeakMap<JoyAgentComposerHostLease, LeaseState>();

export function createJoyAgentComposerHostLease(
  controller: JoyAgentRunController,
  run: HostRpcRun,
): JoyAgentComposerHostLease {
  const lease: JoyAgentComposerHostLease = Object.freeze({
    run: Object.freeze({ runId: run.runId, epoch: run.epoch }),
  });
  leaseStates.set(lease, { controller, revoked: false });
  return lease;
}

/** Returns true only while the exact controller-owned run is nonterminal. */
export function isJoyAgentComposerHostLeaseCurrent(lease: JoyAgentComposerHostLease): boolean {
  const state = leaseStates.get(lease);
  if (state === undefined || state.revoked) return false;
  const current = state.controller.getSnapshot().run;
  return (
    current !== undefined &&
    current.scope.runId === lease.run.runId &&
    current.scope.epoch === lease.run.epoch &&
    !isTerminalJoyAgentRunState(current.state)
  );
}

/**
 * Detaching a Composer invalidates only its host-method authority. It does not
 * mutate the App-owned run lifecycle: connection clear, project switch, or an
 * explicit user stop remains responsible for terminalizing the run.
 */
export function revokeJoyAgentComposerHostLease(lease: JoyAgentComposerHostLease): void {
  const state = leaseStates.get(lease);
  if (state !== undefined) state.revoked = true;
}

/**
 * Terminal teardown must be exact. A stale Composer closure cannot interrupt a
 * newer run that happens to share the same App-owned controller.
 */
export function interruptJoyAgentComposerHostLease(
  lease: JoyAgentComposerHostLease,
  at: string,
  display: string,
): boolean {
  const state = leaseStates.get(lease);
  if (state === undefined || !isJoyAgentComposerHostLeaseCurrent(lease)) return false;
  revokeJoyAgentComposerHostLease(lease);
  return state.controller.interrupt(at, display).accepted;
}
