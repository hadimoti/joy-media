import { OAuthFlowError } from './errors.js';

/**
 * One sign-in attempt per provider at a time (T-J03). A new attempt first cancels the running one and waits
 * for it to finish, so the old listener is closed and its port is free before the new attempt listens. Only
 * the last requested replacement runs; Cancel also reaches a replacement waiting for the old attempt to finish.
 *
 * The registry lives in the main process. It keeps only what the settings screen needs: when the wait began,
 * when it ends, and the sign-in page, so the page can be opened again.
 */

export interface SignInAttemptContext {
  /** Aborted when this attempt is cancelled or replaced. */
  readonly signal: AbortSignal;
  /** Remembers the sign-in page this attempt opened, so "Open the sign-in page again" can open it. */
  setAuthorizationUrl(url: string): void;
  /** Marks the profile save as committed; later cancellation requests cannot report a saved sign-in as cancelled. */
  markCommitted(): void;
}

/** What the settings screen shows for the running attempt. */
export interface RunningSignIn {
  readonly provider: string;
  /** When the wait for the browser began, in ms since the epoch. */
  readonly startedAt: number;
  /** When the wait for the browser ends, in ms since the epoch. */
  readonly waitEndsAt: number;
  /** True once the attempt has a sign-in page to reopen. */
  readonly pageOpen: boolean;
}

export interface SignInAttempts {
  /** Runs one attempt for `provider`, cancelling older work and rejecting any replacement superseded while waiting. */
  start<T>(provider: string, run: (context: SignInAttemptContext) => Promise<T>): Promise<T>;
  /** Cancels the running or pending attempt for `provider`. False when none can be cancelled. */
  cancel(provider: string): boolean;
  /** Opens the sign-in page of the running attempt again. False when there is no page to open. */
  reopen(provider: string): Promise<boolean>;
  /** The running attempt for `provider`, if any. */
  running(provider: string): RunningSignIn | undefined;
}

export interface SignInAttemptOptions {
  readonly now: () => number;
  /** How long the browser has to come back. Matches the callback timeout of the sign-in itself. */
  readonly waitMs: number;
  readonly openExternal: (url: string) => void | Promise<void>;
}

interface Entry {
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly settled: Promise<void>;
  authUrl: string | undefined;
  committed: boolean;
}

export function createSignInAttempts(options: SignInAttemptOptions): SignInAttempts {
  const entries = new Map<string, Entry>();

  return {
    async start<T>(
      provider: string,
      run: (context: SignInAttemptContext) => Promise<T>,
    ): Promise<T> {
      const previous = entries.get(provider);
      const controller = new AbortController();
      let resolveSettled: () => void = () => undefined;
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      const entry: Entry = {
        controller,
        startedAt: options.now(),
        authUrl: undefined,
        settled,
        committed: false,
      };
      // Publish the pending request before waiting, so Cancel and a later start target the newest request.
      entries.set(provider, entry);
      if (previous !== undefined && !previous.committed) {
        previous.controller.abort();
        // Waits until the old run has returned, which is after its listener has closed.
      }
      try {
        if (previous !== undefined) await previous.settled;
        throwIfInactive(entries, provider, entry);
        const result = await run({
          signal: controller.signal,
          setAuthorizationUrl: (url) => {
            if (entries.get(provider) === entry && !controller.signal.aborted) {
              entry.authUrl = url;
            }
          },
          markCommitted: () => {
            entry.committed = true;
          },
        });
        if (!entry.committed) throwIfInactive(entries, provider, entry);
        return result;
      } finally {
        resolveSettled();
        // Only the entry this run created is removed; a newer attempt may already have replaced it.
        if (entries.get(provider) === entry) entries.delete(provider);
      }
    },

    cancel(provider: string): boolean {
      const entry = entries.get(provider);
      if (entry === undefined || entry.committed) return false;
      entry.controller.abort();
      return true;
    },

    async reopen(provider: string): Promise<boolean> {
      const entry = entries.get(provider);
      if (
        entry === undefined ||
        entry.committed ||
        entry.controller.signal.aborted ||
        entry.authUrl === undefined
      )
        return false;
      await options.openExternal(entry.authUrl);
      return true;
    },

    running(provider: string): RunningSignIn | undefined {
      const entry = entries.get(provider);
      if (entry === undefined) return undefined;
      return {
        provider,
        startedAt: entry.startedAt,
        waitEndsAt: entry.startedAt + options.waitMs,
        pageOpen: entry.authUrl !== undefined,
      };
    },
  };
}

function throwIfInactive(entries: Map<string, Entry>, provider: string, entry: Entry): void {
  // Map identity is the request token: a newer pending start supersedes this one.
  if (entries.get(provider) !== entry) {
    throw new OAuthFlowError('CANCELLED', 'The sign-in was superseded by a newer attempt.');
  }
  if (entry.controller.signal.aborted) {
    throw new OAuthFlowError('CANCELLED', 'The sign-in was cancelled.');
  }
}
