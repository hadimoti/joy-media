import { describe, expect, it } from 'vitest';
import { waitForWorkerPairing, type WorkerPairingClient } from './pairing-loop.js';

function pairingStore(pending?: { readonly code: string; readonly expiresAt: number }) {
  let active = pending;
  let session: string | undefined;
  return {
    loadWorkerSession: () => session,
    loadPendingPairing: () => active,
    savePendingPairing: (code: string, expiresAt: number) => {
      active = { code, expiresAt };
    },
    clearPendingPairing: () => {
      active = undefined;
    },
    establishSession: () => {
      session = 'paired-session';
    },
    pending: () => active,
  };
}

describe('waitForWorkerPairing', () => {
  it('replaces an already-expired persisted offer before the first claim', async () => {
    const store = pairingStore({ code: 'expired-code', expiresAt: 99 });
    const claimed: string[] = [];
    const published: string[] = [];
    const client: WorkerPairingClient = {
      publishPairingOffer: async (code) => {
        published.push(code);
        return 200;
      },
      claimPairing: async (code) => {
        claimed.push(code);
        store.establishSession();
        return true;
      },
    };

    await waitForWorkerPairing(client, store, {
      createPairingCode: () => 'fresh-code',
      now: () => 100,
      sleep: async () => undefined,
    });

    expect(published).toEqual(['fresh-code']);
    expect(claimed).toEqual(['fresh-code']);
    expect(store.pending()).toBeUndefined();
  });

  it('announces an unexpired persisted offer once after a restart', async () => {
    const store = pairingStore({ code: 'persisted-code', expiresAt: 200 });
    const logs: string[] = [];
    const notifications: { readonly code: string; readonly expiresAt: number }[] = [];
    let publishAttempts = 0;
    const client: WorkerPairingClient = {
      publishPairingOffer: async () => {
        publishAttempts += 1;
        return 250;
      },
      claimPairing: async () => {
        store.establishSession();
        return true;
      },
    };

    await waitForWorkerPairing(client, store, {
      createPairingCode: () => 'unused-code',
      now: () => 100,
      sleep: async () => undefined,
      log: (message) => logs.push(message),
      notify: (offer) => notifications.push(offer),
    });

    expect(logs).toEqual([
      'Worker pairing approval required; open the JOY Media notification to continue.',
    ]);
    expect(notifications).toEqual([{ code: 'persisted-code', expiresAt: 200 }]);
    expect(publishAttempts).toBe(0);
  });

  it('never writes the pairing secret to diagnostics when the notification channel fails', async () => {
    const store = pairingStore({ code: 'secret-code', expiresAt: 200 });
    const logs: string[] = [];
    const client: WorkerPairingClient = {
      publishPairingOffer: async () => 250,
      claimPairing: async () => {
        store.establishSession();
        return true;
      },
    };

    await waitForWorkerPairing(client, store, {
      createPairingCode: () => 'unused-code',
      now: () => 100,
      sleep: async () => undefined,
      log: (message) => logs.push(message),
      notify: () => {
        throw new Error('desktop host unavailable');
      },
    });

    expect(logs.join('\n')).not.toContain('secret-code');
    expect(logs).toContain('Worker pairing notification could not be displayed; retrying safely.');
  });

  it('claims the refreshed code after an active offer expires while polling', async () => {
    const store = pairingStore({ code: 'first-code', expiresAt: 100 });
    const claimed: string[] = [];
    const published: string[] = [];
    let currentTime = 50;
    const client: WorkerPairingClient = {
      publishPairingOffer: async (code) => {
        published.push(code);
        return 250;
      },
      claimPairing: async (code) => {
        claimed.push(code);
        if (code === 'second-code') {
          store.establishSession();
          return true;
        }
        currentTime = 150;
        return false;
      },
    };

    await waitForWorkerPairing(client, store, {
      createPairingCode: () => 'second-code',
      now: () => currentTime,
      sleep: async () => undefined,
    });

    expect(published).toEqual(['second-code']);
    expect(claimed).toEqual(['first-code', 'second-code']);
    expect(store.pending()).toBeUndefined();
  });

  it('keeps the headless Worker alive across transient network failures', async () => {
    const store = pairingStore();
    let publishAttempts = 0;
    let claimAttempts = 0;
    let sleeps = 0;
    const client: WorkerPairingClient = {
      publishPairingOffer: async () => {
        publishAttempts += 1;
        if (publishAttempts === 1) throw new Error('network unavailable');
        return 250;
      },
      claimPairing: async () => {
        claimAttempts += 1;
        if (claimAttempts === 1) throw new Error('connection reset');
        store.establishSession();
        return true;
      },
    };

    await waitForWorkerPairing(client, store, {
      createPairingCode: () => 'retry-code',
      now: () => 100,
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(publishAttempts).toBe(2);
    expect(claimAttempts).toBe(2);
    expect(sleeps).toBe(2);
    expect(store.pending()).toBeUndefined();
  });
});
