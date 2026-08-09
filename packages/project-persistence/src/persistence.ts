/** P01.2 local persistence/recovery contract; storage adapters can target IndexedDB or desktop. */

export type AutosaveState =
  | 'saved-locally'
  | 'syncing'
  | 'saved-locally-server-unavailable'
  | 'save-error-recovery-available';

export interface PersistenceAdapter<P, T> {
  readonly projectId: (project: P) => string;
  readonly schemaVersion: (project: P) => number;
  readonly validate: (project: P) => readonly { readonly code: string; readonly message: string }[];
  readonly apply: (project: P, transaction: T) => P;
}

interface StoredValue<T> {
  readonly payload: T;
  readonly checksum: string;
}

export interface StoredSnapshot<P> extends StoredValue<P> {
  readonly revision: number;
  readonly schemaVersion: number;
}

export interface StoredTransaction<T> extends StoredValue<T> {
  readonly revision: number;
}

export interface RecoveryResult<P> {
  readonly project: P;
  readonly revision: number;
  readonly recoveredWithWarnings: boolean;
  readonly warnings: readonly string[];
}

export class PersistenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

export interface ProjectStore<P, T> {
  /**
   * `retainSnapshots`, when given, caps how many snapshots survive the append.
   *
   * Retention is part of the write rather than a separate prune call because
   * the browser and desktop stores serialize the whole database per write; a
   * prune pass would double the cost of exactly the path it exists to bound.
   */
  writeSnapshot(projectId: string, snapshot: StoredSnapshot<P>, retainSnapshots?: number): void;
  writeTransaction(projectId: string, transaction: StoredTransaction<T>): void;
  snapshots(projectId: string): readonly StoredSnapshot<P>[];
  transactions(projectId: string): readonly StoredTransaction<T>[];
  /** Stable project ids that currently have at least one snapshot or transaction. */
  listProjectIds(): readonly string[];
  /** Remove every snapshot and transaction belonging to one project. */
  deleteProject(projectId: string): void;
}

/**
 * Appends `snapshot` and keeps only the newest `retain` entries.
 *
 * Sorting by revision keeps the newest regardless of write order, and the sort
 * is stable, so snapshots that share a revision — legacy logs written before
 * `latestRevision` counted snapshots — keep their insertion order and the last
 * one written wins. At least one snapshot always survives: a project with no
 * snapshot cannot be recovered at all.
 */
export function retainNewestSnapshots<P>(
  existing: readonly StoredSnapshot<P>[],
  snapshot: StoredSnapshot<P>,
  retain: number | undefined,
): readonly StoredSnapshot<P>[] {
  const appended = [...existing, snapshot];
  if (retain === undefined || appended.length <= retain) return appended;
  return [...appended].sort((a, b) => a.revision - b.revision).slice(-Math.max(1, retain));
}

/** Testable local store; a browser/desktop adapter implements the same snapshot/log semantics. */
export class InMemoryProjectStore<P, T> implements ProjectStore<P, T> {
  readonly #snapshots = new Map<string, StoredSnapshot<P>[]>();
  readonly #transactions = new Map<string, StoredTransaction<T>[]>();
  failNextWrite = false;

  writeSnapshot(projectId: string, snapshot: StoredSnapshot<P>, retainSnapshots?: number): void {
    this.maybeFail();
    const list = this.#snapshots.get(projectId) ?? [];
    this.#snapshots.set(projectId, [...retainNewestSnapshots(list, snapshot, retainSnapshots)]);
  }

  writeTransaction(projectId: string, transaction: StoredTransaction<T>): void {
    this.maybeFail();
    const list = this.#transactions.get(projectId) ?? [];
    this.#transactions.set(projectId, [...list, transaction]);
  }

  snapshots(projectId: string): readonly StoredSnapshot<P>[] {
    return this.#snapshots.get(projectId) ?? [];
  }

  transactions(projectId: string): readonly StoredTransaction<T>[] {
    return this.#transactions.get(projectId) ?? [];
  }

  listProjectIds(): readonly string[] {
    const ids = new Set<string>([...this.#snapshots.keys(), ...this.#transactions.keys()]);
    return [...ids].sort();
  }

  deleteProject(projectId: string): void {
    this.#snapshots.delete(projectId);
    this.#transactions.delete(projectId);
  }

  /** Simulates a crash that leaves a truncated last log entry. */
  corruptLastTransaction(projectId: string): void {
    const list = this.#transactions.get(projectId) ?? [];
    const last = list[list.length - 1];
    if (last === undefined) return;
    this.#transactions.set(projectId, [...list.slice(0, -1), { ...last, checksum: 'truncated' }]);
  }

  private maybeFail(): void {
    if (!this.failNextWrite) return;
    this.failNextWrite = false;
    throw new PersistenceError('PERSISTENCE_WRITE_FAILED', 'durable store rejected write');
  }
}

export class LocalProjectPersistence<P, T> {
  #autosaveState: AutosaveState = 'saved-locally';
  readonly #recoveryCopy = new Map<string, P>();

  constructor(
    private readonly store: ProjectStore<P, T>,
    private readonly adapter: PersistenceAdapter<P, T>,
    private readonly snapshotEvery = 20,
    /**
     * How many snapshots the log keeps. Bounded because a document replacement
     * writes a whole snapshot and panels replace per interaction — a colour
     * slider drag would otherwise grow local storage without limit. Five keeps
     * real fallback depth for `recover` when the newest snapshot is corrupt.
     */
    private readonly snapshotRetention = 5,
  ) {}

  get autosaveState(): AutosaveState {
    return this.#autosaveState;
  }

  /** UI sync adapters opt in to this transient state without delaying local saves. */
  beginSync(): void {
    this.#autosaveState = 'syncing';
  }

  completeSync(serverAvailable: boolean): void {
    if (this.#autosaveState !== 'syncing') {
      throw new PersistenceError('PERSISTENCE_SYNC_NOT_ACTIVE', 'cannot complete an inactive sync');
    }
    this.#autosaveState = serverAvailable ? 'saved-locally' : 'saved-locally-server-unavailable';
  }

  initialize(project: P): void {
    this.assertValid(project);
    const projectId = this.adapter.projectId(project);
    if (this.store.snapshots(projectId).length > 0) {
      throw new PersistenceError(
        'PERSISTENCE_ALREADY_INITIALIZED',
        `project "${projectId}" already exists`,
      );
    }
    this.store.writeSnapshot(
      projectId,
      snapshot(project, 0, this.adapter.schemaVersion(project)),
      this.snapshotRetention,
    );
    this.#recoveryCopy.set(projectId, project);
    this.#autosaveState = 'saved-locally';
  }

  /**
   * Durable write for a whole-document replacement.
   *
   * Some changes have no command form — an approved agent change set rewrites
   * parameters across the document rather than issuing object commands. Those
   * cannot go through `saveTransaction`, whose adapter rejects an empty command
   * list, and appending an empty transaction anyway would replay to the *old*
   * document and silently lose the change on reload.
   */
  saveSnapshot(project: P, serverAvailable: boolean): P {
    const projectId = this.adapter.projectId(project);
    this.assertValid(project);
    const revision = this.latestRevision(projectId) + 1;
    this.store.writeSnapshot(
      projectId,
      snapshot(project, revision, this.adapter.schemaVersion(project)),
      this.snapshotRetention,
    );
    this.#recoveryCopy.set(projectId, project);
    this.#autosaveState = serverAvailable ? 'saved-locally' : 'saved-locally-server-unavailable';
    return project;
  }

  /** Write-ahead recovery copy, validated log append, then periodic verified snapshot. */
  saveTransaction(project: P, transaction: T, serverAvailable: boolean): P {
    const projectId = this.adapter.projectId(project);
    this.#recoveryCopy.set(projectId, project);
    let next: P;
    try {
      next = this.adapter.apply(project, transaction);
      this.assertValid(next);
      const revision = this.latestRevision(projectId) + 1;
      this.store.writeTransaction(projectId, {
        payload: transaction,
        checksum: checksum(transaction),
        revision,
      });
      if (revision % this.snapshotEvery === 0) {
        this.store.writeSnapshot(
          projectId,
          snapshot(next, revision, this.adapter.schemaVersion(next)),
          this.snapshotRetention,
        );
      }
      this.#recoveryCopy.set(projectId, next);
      this.#autosaveState = serverAvailable ? 'saved-locally' : 'saved-locally-server-unavailable';
      return next;
    } catch (error) {
      this.#autosaveState = 'save-error-recovery-available';
      throw error;
    }
  }

  recover(projectId: string): RecoveryResult<P> {
    const warnings: string[] = [];
    const snapshots = [...this.store.snapshots(projectId)].sort((a, b) => b.revision - a.revision);
    if (snapshots.length === 0)
      throw new PersistenceError('PERSISTENCE_NOT_FOUND', `project "${projectId}" not found`);

    const verified = snapshots.find((candidate) => {
      if (checksum(candidate.payload) !== candidate.checksum) {
        warnings.push(`ignored snapshot revision ${candidate.revision}: checksum failed`);
        return false;
      }
      if (candidate.schemaVersion !== this.adapter.schemaVersion(candidate.payload)) {
        warnings.push(`ignored snapshot revision ${candidate.revision}: schema version mismatch`);
        return false;
      }
      try {
        this.assertValid(candidate.payload);
        return true;
      } catch (error) {
        warnings.push(
          `ignored snapshot revision ${candidate.revision}: ${(error as Error).message}`,
        );
        return false;
      }
    });
    if (verified === undefined) {
      throw new PersistenceError('PERSISTENCE_SNAPSHOT_CORRUPT', 'no valid snapshot is available');
    }

    let project = verified.payload;
    let revision = verified.revision;
    for (const entry of this.store
      .transactions(projectId)
      .filter((transaction) => transaction.revision > revision)) {
      if (checksum(entry.payload) !== entry.checksum) {
        warnings.push(`stopped before revision ${entry.revision}: transaction checksum failed`);
        break;
      }
      try {
        project = this.adapter.apply(project, entry.payload);
        this.assertValid(project);
        revision = entry.revision;
      } catch (error) {
        warnings.push(`stopped before revision ${entry.revision}: ${(error as Error).message}`);
        break;
      }
    }
    this.#recoveryCopy.set(projectId, project);
    return { project, revision, recoveredWithWarnings: warnings.length > 0, warnings };
  }

  recoveryCopy(projectId: string): P | undefined {
    return this.#recoveryCopy.get(projectId);
  }

  /**
   * Snapshots count here, not only transactions.
   *
   * `saveSnapshot` writes no transaction, so counting transactions alone gave
   * two consecutive replacements the same revision — and `recover` picks the
   * first of a tie, so the second replacement was lost on reload. A following
   * `saveTransaction` collided with the snapshot the same way and was skipped
   * during replay.
   */
  private latestRevision(projectId: string): number {
    return Math.max(
      0,
      ...this.store.transactions(projectId).map((entry) => entry.revision),
      ...this.store.snapshots(projectId).map((entry) => entry.revision),
    );
  }

  private assertValid(project: P): void {
    const diagnostics = this.adapter.validate(project);
    if (diagnostics.length > 0)
      throw new PersistenceError('PERSISTENCE_PROJECT_INVALID', diagnostics[0]!.message);
  }
}

/** Local ownership guard for two browser tabs/windows editing one project. */
export class ProjectLockManager {
  readonly #owners = new Map<string, string>();

  acquire(projectId: string, clientId: string): void {
    const owner = this.#owners.get(projectId);
    if (owner !== undefined && owner !== clientId) {
      throw new PersistenceError(
        'PERSISTENCE_PROJECT_LOCKED',
        `project "${projectId}" is open in another client`,
      );
    }
    this.#owners.set(projectId, clientId);
  }

  release(projectId: string, clientId: string): void {
    if (this.#owners.get(projectId) === clientId) this.#owners.delete(projectId);
  }
}

function snapshot<P>(project: P, revision: number, schemaVersion: number): StoredSnapshot<P> {
  return { payload: project, checksum: checksum(project), revision, schemaVersion };
}

/** Stable enough for versioned JSON contracts; cryptographic integrity arrives with storage encryption. */
function checksum(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
