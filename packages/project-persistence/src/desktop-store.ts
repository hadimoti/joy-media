/** Atomic desktop JSON-file adapter for snapshot/log persistence. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { retainNewestSnapshots } from './persistence.js';
import type { ProjectStore, StoredSnapshot, StoredTransaction } from './persistence.js';

interface FileDatabase<P, T> {
  readonly projects: Record<
    string,
    {
      readonly snapshots: readonly StoredSnapshot<P>[];
      readonly transactions: readonly StoredTransaction<T>[];
    }
  >;
}

/** Desktop-first adapter; each write is a temporary sibling followed by atomic rename. */
export class JsonFileProjectStore<P, T> implements ProjectStore<P, T> {
  constructor(private readonly filePath: string) {}

  writeSnapshot(projectId: string, snapshot: StoredSnapshot<P>, retainSnapshots?: number): void {
    const database = this.read();
    const project = database.projects[projectId] ?? { snapshots: [], transactions: [] };
    this.write({
      projects: {
        ...database.projects,
        [projectId]: {
          ...project,
          snapshots: retainNewestSnapshots(project.snapshots, snapshot, retainSnapshots),
        },
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

  private read(): FileDatabase<P, T> {
    if (!existsSync(this.filePath)) return { projects: {} };
    return JSON.parse(readFileSync(this.filePath, 'utf8')) as FileDatabase<P, T>;
  }

  private write(database: FileDatabase<P, T>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(database), 'utf8');
    renameSync(temporaryPath, this.filePath);
  }
}
