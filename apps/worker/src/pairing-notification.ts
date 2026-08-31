import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WorkerPairingNotification {
  readonly kind: 'worker-pairing-required';
  readonly code: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

/**
 * Delivers a pairing code through a native-side notification hand-off file.
 *
 * The file is intentionally separate from the diagnostic log: it is an
 * ephemeral, owner-facing hand-off that a desktop host can display and then
 * remove. No ordinary Worker log receives the pairing secret.
 */
export function createPairingNotificationWriter(
  path: string,
  now: () => number = Date.now,
): (offer: { readonly code: string; readonly expiresAt: number }) => void {
  return (offer) => {
    const notification: WorkerPairingNotification = {
      kind: 'worker-pairing-required',
      code: offer.code,
      expiresAt: offer.expiresAt,
      createdAt: now(),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(notification)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows ACLs are inherited from the private state directory; chmod is
      // best-effort there while the restrictive creation mode remains useful
      // on Unix fallback hosts.
    }
  };
}

export function clearPairingNotification(path: string): void {
  rmSync(path, { force: true });
}
