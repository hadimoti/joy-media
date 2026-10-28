import type { DatabaseSync } from 'node:sqlite';

/**
 * The project document the editor saves through `desktop.media.project.document.*` (PLAN-v4 §6i).
 * One row per project. A write names the revision it was built on, and the store refuses it when
 * that is not the stored revision, the same rule the editor's remote document sync follows.
 *
 * The document is opaque JSON here. The editor owns its shape (`JoyProjectV1`).
 */

export interface StoredProjectDocument {
  readonly projectId: string;
  readonly revisionId: string;
  readonly document: unknown;
  readonly lookInstances?: unknown;
}

export interface ProjectDocumentWrite {
  readonly projectId: string;
  /** The empty string for a project's first save. */
  readonly baseRevisionId: string;
  readonly revisionId: string;
  readonly document: unknown;
  /** Omitted leaves the stored Look Instances document as it is. */
  readonly lookInstances?: unknown;
}

export type ProjectDocumentWriteResult =
  | { readonly kind: 'saved'; readonly revisionId: string }
  | { readonly kind: 'conflict'; readonly revisionId: string }
  | { readonly kind: 'missing' };

interface ProjectDocumentRow {
  readonly revision_id: string;
  readonly document_json: string;
  readonly look_instances_json: string | null;
}

export function ensureProjectDocumentSchema(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS project_documents (
       project_id TEXT PRIMARY KEY,
       revision_id TEXT NOT NULL,
       document_json TEXT NOT NULL,
       look_instances_json TEXT,
       updated_at TEXT NOT NULL
     )`,
  );
}

export class SqliteProjectDocumentStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string,
  ) {}

  /** The stored document, or `undefined` when there is none for this project or revision. */
  get(projectId: string, revisionId?: string): StoredProjectDocument | undefined {
    const row = this.db
      .prepare(
        'SELECT revision_id, document_json, look_instances_json FROM project_documents WHERE project_id = ?',
      )
      .get(projectId) as ProjectDocumentRow | undefined;
    if (row === undefined) return undefined;
    // Only the latest revision is kept, so an older one cannot be read back.
    if (revisionId !== undefined && revisionId !== row.revision_id) return undefined;
    return {
      projectId,
      revisionId: row.revision_id,
      document: JSON.parse(row.document_json) as unknown,
      ...(row.look_instances_json === null
        ? {}
        : { lookInstances: JSON.parse(row.look_instances_json) as unknown }),
    };
  }

  put(write: ProjectDocumentWrite): ProjectDocumentWriteResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db
        .prepare('SELECT revision_id FROM project_documents WHERE project_id = ?')
        .get(write.projectId) as { readonly revision_id: string } | undefined;
      const result = this.apply(write, current);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private apply(
    write: ProjectDocumentWrite,
    current: { readonly revision_id: string } | undefined,
  ): ProjectDocumentWriteResult {
    // A retry of a write that already landed: the stored revision is the one requested.
    if (current !== undefined && current.revision_id === write.revisionId) {
      return { kind: 'saved', revisionId: write.revisionId };
    }
    if (current === undefined && write.baseRevisionId !== '') return { kind: 'missing' };
    if (current !== undefined && current.revision_id !== write.baseRevisionId) {
      return { kind: 'conflict', revisionId: current.revision_id };
    }
    const documentJson = JSON.stringify(write.document);
    const lookInstancesJson =
      write.lookInstances === undefined ? null : JSON.stringify(write.lookInstances);
    if (current === undefined) {
      this.db
        .prepare(
          `INSERT INTO project_documents
             (project_id, revision_id, document_json, look_instances_json, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(write.projectId, write.revisionId, documentJson, lookInstancesJson, this.now());
    } else {
      this.db
        .prepare(
          `UPDATE project_documents
              SET revision_id = ?,
                  document_json = ?,
                  look_instances_json = COALESCE(?, look_instances_json),
                  updated_at = ?
            WHERE project_id = ?`,
        )
        .run(write.revisionId, documentJson, lookInstancesJson, this.now(), write.projectId);
    }
    return { kind: 'saved', revisionId: write.revisionId };
  }
}
