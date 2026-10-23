/**
 * The stored session token that an editor's owner was probed with. A stored token that differs from it
 * belongs to another session, which none of the editor's long operations or reads may use. Another tab
 * can store a token without this editor hearing about it, so the stored value is read at each use.
 */
export interface ProbedSessionToken {
  /** Records the token that a probe of the owner read. Call it with the token the probe started with. */
  record(token: string | undefined): void;
  /** The stored token while it is the recorded one. Otherwise undefined, so a check built on it fails. */
  current(): string | undefined;
}

export function createProbedSessionToken(readStored: () => string | undefined): ProbedSessionToken {
  let probed: string | undefined;
  return {
    record(token) {
      probed = token;
    },
    current() {
      const stored = readStored();
      return stored !== undefined && stored === probed ? stored : undefined;
    },
  };
}
