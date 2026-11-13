import type { DatabaseSync } from 'node:sqlite';

export type GenerationJobKind = 'image' | 'video';
export type GenerationJobRoute = 'current' | 'legacy';
export type GenerationJobState =
  | 'queued'
  | 'running'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'abandoned-locally'
  | 'timed-out';

/** Persisted generation metadata. Credentials and temporary download links never belong here. */
export interface GenerationJobRecord {
  readonly id: string;
  readonly kind: GenerationJobKind;
  readonly provider: string;
  readonly profileId: string;
  readonly model: string;
  readonly prompt: string;
  readonly state: GenerationJobState;
  readonly costNote: string;
  readonly providerTaskId?: string | undefined;
  readonly route?: GenerationJobRoute | undefined;
  readonly filePath?: string | undefined;
  readonly sha256?: string | undefined;
  readonly error?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GenerationJobStore {
  save(job: GenerationJobRecord): void;
  get(id: string): GenerationJobRecord | undefined;
  list(): readonly GenerationJobRecord[];
}

interface GenerationJobRow {
  readonly id: string;
  readonly kind: string;
  readonly provider: string;
  readonly profile_id: string;
  readonly model: string;
  readonly prompt: string;
  readonly state: string;
  readonly cost_note: string;
  readonly provider_task_id: string | null;
  readonly route: string | null;
  readonly file_path: string | null;
  readonly sha256: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export class SqliteGenerationJobStore implements GenerationJobStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS generation_jobs (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
         provider TEXT NOT NULL,
         profile_id TEXT NOT NULL,
         model TEXT NOT NULL,
         prompt TEXT NOT NULL,
         state TEXT NOT NULL CHECK (state IN (
           'queued', 'running', 'downloading', 'completed', 'failed', 'cancelled',
           'abandoned-locally', 'timed-out'
         )),
         cost_note TEXT NOT NULL,
         provider_task_id TEXT,
         route TEXT CHECK (route IS NULL OR route IN ('current', 'legacy')),
         file_path TEXT,
         sha256 TEXT,
         error TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
  }

  save(job: GenerationJobRecord): void {
    this.db
      .prepare(
        `INSERT INTO generation_jobs (
           id, kind, provider, profile_id, model, prompt, state, cost_note,
           provider_task_id, route, file_path, sha256, error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           provider = excluded.provider,
           profile_id = excluded.profile_id,
           model = excluded.model,
           prompt = excluded.prompt,
           state = excluded.state,
           cost_note = excluded.cost_note,
           provider_task_id = excluded.provider_task_id,
           route = excluded.route,
           file_path = excluded.file_path,
           sha256 = excluded.sha256,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .run(
        job.id,
        job.kind,
        job.provider,
        job.profileId,
        job.model,
        job.prompt,
        job.state,
        job.costNote,
        job.providerTaskId ?? null,
        job.route ?? null,
        job.filePath ?? null,
        job.sha256 ?? null,
        job.error ?? null,
        job.createdAt,
        job.updatedAt,
      );
  }

  get(id: string): GenerationJobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as
      GenerationJobRow | undefined;
    return row === undefined ? undefined : generationJobFromRow(row);
  }

  list(): readonly GenerationJobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM generation_jobs ORDER BY created_at DESC, id DESC')
      .all() as unknown as readonly GenerationJobRow[];
    return rows.map(generationJobFromRow);
  }
}

function generationJobFromRow(row: GenerationJobRow): GenerationJobRecord {
  return {
    id: row.id,
    kind: row.kind as GenerationJobKind,
    provider: row.provider,
    profileId: row.profile_id,
    model: row.model,
    prompt: row.prompt,
    state: row.state as GenerationJobState,
    costNote: row.cost_note,
    ...(row.provider_task_id === null ? {} : { providerTaskId: row.provider_task_id }),
    ...(row.route === null ? {} : { route: row.route as GenerationJobRoute }),
    ...(row.file_path === null ? {} : { filePath: row.file_path }),
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
