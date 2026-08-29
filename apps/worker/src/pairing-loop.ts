import type { PersistentWorkerStore } from './runtime.js';

export interface WorkerPairingClient {
  publishPairingOffer(pairingCode: string): Promise<number>;
  claimPairing(pairingCode: string): Promise<boolean>;
}

export interface WorkerPairingLoopOptions {
  readonly createPairingCode: () => string;
  readonly now?: () => number;
  readonly sleep?: () => Promise<void>;
  readonly log?: (message: string) => void;
}

/**
 * Publishes and claims a Worker pairing offer without ever polling a stale code.
 *
 * The pending offer is durable so a restart can resume it. Once it expires,
 * both the persisted offer and this loop's active code move forward together.
 */
export async function waitForWorkerPairing(
  client: WorkerPairingClient,
  store: Pick<
    PersistentWorkerStore,
    'loadWorkerSession' | 'loadPendingPairing' | 'savePendingPairing' | 'clearPendingPairing'
  >,
  options: WorkerPairingLoopOptions,
): Promise<void> {
  if (store.loadWorkerSession() !== undefined) return;

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 5_000)));
  const log = options.log ?? (() => undefined);

  let pending = store.loadPendingPairing();
  let announcedCode: string | undefined;
  const announce = (offer: { readonly code: string }): void => {
    if (announcedCode === offer.code) return;
    announcedCode = offer.code;
    log(`Approve this Worker in JOY Media with pairing code: ${offer.code}`);
  };
  if (pending !== undefined && pending.expiresAt > now()) announce(pending);
  while (store.loadWorkerSession() === undefined) {
    if (pending === undefined || pending.expiresAt <= now()) {
      try {
        pending = await publishFreshOffer(client, store, options.createPairingCode);
        announce(pending);
      } catch (error) {
        log(
          `Unable to publish Worker pairing offer; retrying: ${
            error instanceof Error ? error.message.slice(0, 160) : 'unknown error'
          }`,
        );
        await sleep();
        continue;
      }
    }

    try {
      if (await client.claimPairing(pending.code)) {
        store.clearPendingPairing();
        return;
      }
    } catch (error) {
      log(
        `Unable to check Worker pairing approval; retrying: ${
          error instanceof Error ? error.message.slice(0, 160) : 'unknown error'
        }`,
      );
    }

    if (now() >= pending.expiresAt) {
      pending = undefined;
    }
    log('Waiting for approval; polling again in 5 seconds.');
    await sleep();
  }
}

async function publishFreshOffer(
  client: WorkerPairingClient,
  store: Pick<PersistentWorkerStore, 'savePendingPairing'>,
  createPairingCode: () => string,
): Promise<{ readonly code: string; readonly expiresAt: number }> {
  const code = createPairingCode();
  const expiresAt = await client.publishPairingOffer(code);
  store.savePendingPairing(code, expiresAt);
  return { code, expiresAt };
}
