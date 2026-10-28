/**
 * Provider state that a tool call must carry back on its next request: the `extra_content` a Chat Completions
 * provider attaches to a function call (Gemini 3 puts a thought signature there), and the Claude thinking blocks
 * that come before a tool use. The provider sends it with the reply. The broker keeps it here, per profile and
 * call id, and sends it back with the same call. It is never part of a reply, so the Worker and the editor never
 * see it. It is kept in memory only.
 */

/** How long a call's state is kept. A tool loop finishes well inside this. */
const LIFETIME_MS = 60 * 60 * 1000;
/** The most calls kept at once. The oldest is dropped first. */
const MAX_ENTRIES = 512;

export class ContinuationState {
  readonly #entries = new Map<string, { readonly value: unknown; readonly storedAt: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Keeps the state a call was given. A later call with the same id replaces it. */
  remember(profileId: string, callId: string, value: unknown): void {
    const key = keyOf(profileId, callId);
    this.#entries.delete(key);
    this.#entries.set(key, { value, storedAt: this.#now() });
    this.#expire();
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /** The state kept for a call of this profile, or undefined when none is kept. */
  recall(profileId: string, callId: string): unknown {
    this.#expire();
    return this.#entries.get(keyOf(profileId, callId))?.value;
  }

  /** Entries are kept in the order they were stored, so the expired ones are at the front. */
  #expire(): void {
    const cutoff = this.#now() - LIFETIME_MS;
    for (const [key, entry] of this.#entries) {
      if (entry.storedAt >= cutoff) break;
      this.#entries.delete(key);
    }
  }
}

function keyOf(profileId: string, callId: string): string {
  return `${profileId}\u0000${callId}`;
}
