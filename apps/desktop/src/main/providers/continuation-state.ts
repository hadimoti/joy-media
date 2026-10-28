import { createHash } from 'node:crypto';

/**
 * Provider state that a tool call must carry back on its next request: the `extra_content` a Chat Completions
 * provider attaches to a function call (Gemini 3 puts a thought signature there), and the Claude content of the turn
 * a tool use came in. The provider sends it with the reply. The broker keeps it here and sends it back only with the
 * same call, in the same conversation: an entry is found by profile, call id, the history the request that produced
 * the reply carried (see historyDigests) and the call itself (see callFingerprint). It is never part of a reply, so the
 * Worker and the editor never see it. It is kept in memory only.
 */

/** How long a call's state is kept. A tool loop finishes well inside this. */
const LIFETIME_MS = 60 * 60 * 1000;
/** The most calls kept at once. The oldest is dropped first. */
const MAX_ENTRIES = 512;
/** The most state kept at once, in serialized bytes. The oldest is dropped first. */
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;

/** Where a call's state is kept: the profile it was sent to, its id, the history before it, and the call itself. */
export interface CallScope {
  readonly profileId: string;
  readonly callId: string;
  /** The digest of the messages before the call (see historyDigests). */
  readonly history: string;
  /** The call as the provider wrote it (see callFingerprint). */
  readonly call: string;
}

interface Entry {
  readonly value: unknown;
  readonly storedAt: number;
  /** The bytes the value takes when it is sent back. */
  readonly bytes: number;
  /** The bytes the entry holds: its value and its key. Both count toward the budget. */
  readonly retained: number;
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

  /** Keeps the state of a call. A later reply with the same call in the same conversation replaces it. */
  remember(scope: CallScope, value: unknown): void {
    if (value === undefined) return;
    const key = keyOf(scope);
    this.#drop(key);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const retained = bytes + Buffer.byteLength(key);
    this.#entries.set(key, { value, storedAt: this.#now(), bytes, retained });
    this.#retainedBytes += retained;
    this.#expire();
    while (this.#entries.size > MAX_ENTRIES || this.#retainedBytes > MAX_RETAINED_BYTES) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#drop(oldest.value);
    }
  }

  /** The state kept for this call in this conversation, or undefined when none is kept. */
  recall(scope: CallScope): RetainedState | undefined {
    this.#expire();
    const entry = this.#entries.get(keyOf(scope));
    return entry === undefined ? undefined : { value: entry.value, bytes: entry.bytes };
  }

  #drop(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#retainedBytes -= entry.retained;
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

/**
 * The call as the provider wrote it, as a fixed-size digest of its tool name and its arguments text. A call with other
 * arguments is another call, so it never receives this state, even when a second run writes the same id. The digest
 * keeps every key the same size, however large the arguments are.
 */
export function callFingerprint(name: string, argumentsText: string): string {
  return createHash('sha256')
    .update(JSON.stringify([name, argumentsText]))
    .digest('hex');
}

function keyOf(scope: CallScope): string {
  return [scope.profileId, scope.callId, scope.history, scope.call].join('\u0000');
}
