import { createHash } from 'node:crypto';

/**
 * Provider state that a tool call must carry back on its next request: the `extra_content` a Chat Completions
 * provider attaches to a function call (Gemini 3 puts a thought signature there), and the Claude content of the turn
 * a tool use came in. The provider sends it with the reply. The broker keeps it here and sends it back only with the
 * same call, in the same conversation: an entry is found by profile, call id and the history the request that
 * produced the reply carried (see historyDigests). It is never part of a reply, so the Worker and the editor never
 * see it. It is kept in memory only.
 */

/** How long a call's state is kept. A tool loop finishes well inside this. */
const LIFETIME_MS = 60 * 60 * 1000;
/** The most calls kept at once. The oldest is dropped first. */
const MAX_ENTRIES = 512;
/** The most state kept at once, in serialized bytes. The oldest is dropped first. */
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;

interface Entry {
  readonly value: unknown;
  readonly storedAt: number;
  readonly bytes: number;
}

/** The state a call was given, with its size in bytes as it is sent back. */
export interface RetainedState {
  readonly value: unknown;
  readonly bytes: number;
}

export class ContinuationState {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  #retainedBytes = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Keeps the state a call was given, for the conversation whose history before the call has the digest `history`.
   * A later reply with the same call in that conversation replaces it.
   */
  remember(profileId: string, callId: string, history: string, value: unknown): void {
    if (value === undefined) return;
    const key = keyOf(profileId, callId, history);
    this.#drop(key);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    this.#entries.set(key, { value, storedAt: this.#now(), bytes });
    this.#retainedBytes += bytes;
    this.#expire();
    while (this.#entries.size > MAX_ENTRIES || this.#retainedBytes > MAX_RETAINED_BYTES) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#drop(oldest.value);
    }
  }

  /** The state kept for this call in this conversation, or undefined when none is kept. */
  recall(profileId: string, callId: string, history: string): RetainedState | undefined {
    this.#expire();
    const entry = this.#entries.get(keyOf(profileId, callId, history));
    return entry === undefined ? undefined : { value: entry.value, bytes: entry.bytes };
  }

  #drop(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#retainedBytes -= entry.bytes;
    this.#entries.delete(key);
  }

  /** Entries are kept in the order they were stored, so the expired ones are at the front. */
  #expire(): void {
    const cutoff = this.#now() - LIFETIME_MS;
    for (const [key, entry] of this.#entries) {
      if (entry.storedAt >= cutoff) break;
      this.#drop(key);
    }
  }
}

/**
 * The digest of each prefix of a conversation: entry `n` is the digest of its first `n` messages. A reply's state is
 * kept under the digest of the messages its request carried, and sent back only where a later request has those same
 * messages before the call. Two conversations never share state, and a probe never shares it with a chat.
 */
export function historyDigests(messages: readonly unknown[]): readonly string[] {
  const running = createHash('sha256');
  const digests = [running.copy().digest('hex')];
  for (const message of messages) {
    // A newline ends each message: JSON never writes one raw, so the boundary is unambiguous.
    running.update(`${JSON.stringify(message)}\n`);
    digests.push(running.copy().digest('hex'));
  }
  return digests;
}

function keyOf(profileId: string, callId: string, history: string): string {
  return `${profileId}\u0000${callId}\u0000${history}`;
}
