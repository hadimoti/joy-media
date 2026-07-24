/** Browser-local JSON store for snapshot/log persistence; no DOM globals required. */

import type { ProjectStore, StoredSnapshot, StoredTransaction } from './persistence.js';

export interface BrowserKeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface BrowserDatabase<P, T> {
  readonly projects: Record<
    string,
    {
      readonly snapshots: readonly StoredSnapshot<P>[];
      readonly transactions: readonly StoredTransaction<T>[];
    }
  >;
}

/** One localStorage key per project domain; writes replace one complete JSON value. */
export class BrowserProjectStore<P, T> implements ProjectStore<P, T> {
  constructor(
    private readonly storage: BrowserKeyValueStore,
    private readonly storageKey: string,
  ) {}

  writeSnapshot(projectId: string, snapshot: StoredSnapshot<P>): void {
    const database = this.read();
    const project = database.projects[projectId] ?? { snapshots: [], transactions: [] };
    this.write({
      projects: {
        ...database.projects,
        [projectId]: { ...project, snapshots: [...project.snapshots, snapshot] },
      },
    });
  }

  writeTransaction(projectId: string, transaction: StoredTransaction<T>): void {
    const database = this.read();
    const project = database.projects[projectId] ?? { snapshots: [], transactions: [] };
    this.write({
      projects: {
        ...database.projects,
        [projectId]: { ...project, transactions: [...project.transactions, transaction] },
      },
    });
  }

  snapshots(projectId: string): readonly StoredSnapshot<P>[] {
    return this.read().projects[projectId]?.snapshots ?? [];
  }

  transactions(projectId: string): readonly StoredTransaction<T>[] {
    return this.read().projects[projectId]?.transactions ?? [];
  }

  listProjectIds(): readonly string[] {
    return Object.keys(this.read().projects).sort();
  }

  private read(): BrowserDatabase<P, T> {
    const serialized = this.storage.getItem(this.storageKey);
    if (serialized === null) return { projects: {} };
    try {
      const parsed = JSON.parse(serialized) as BrowserDatabase<P, T>;
      return parsed.projects === undefined ? { projects: {} } : parsed;
    } catch {
      return { projects: {} };
    }
  }

  private write(database: BrowserDatabase<P, T>): void {
    this.storage.setItem(this.storageKey, JSON.stringify(database));
  }
}
