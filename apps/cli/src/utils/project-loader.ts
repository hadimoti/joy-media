import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProjectStore } from '@joy-media/project-persistence/desktop';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { getDefaultSqlitePath } from './config.js';

export { getDefaultSqlitePath };

export interface ProjectLoadResult {
  readonly project: JoyProjectV1;
  readonly revision: number;
  readonly source: 'sqlite' | 'file';
  readonly path: string;
}

export interface ProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly clipCount: number;
  readonly trackCount: number;
  readonly durationSeconds: number;
}

export function projectContentDurationUs(project: JoyProjectV1): number {
  const root = project.compositions[project.rootCompositionId];
  return (root?.tracks ?? []).reduce(
    (maximum, track) =>
      Math.max(maximum, ...track.clips.map((clip) => clip.startUs + clip.durationUs)),
    0,
  );
}

export function createDefaultProject(
  title: string,
  options?:
    | {
        id?: string | undefined;
        width?: number | undefined;
        height?: number | undefined;
        fps?: number | undefined;
      }
    | undefined,
): JoyProjectV1 {
  const id = options?.id ?? `proj-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const width = options?.width ?? 1080;
  const height = options?.height ?? 1920;
  const fps = options?.fps ?? 30;

  return {
    schemaVersion: 1,
    id,
    title,
    createdAt: now,
    updatedAt: now,
    rootCompositionId: 'root',
    settings: {
      defaultLocale: 'en',
    },
    compositions: {
      root: {
        id: 'root',
        name: 'Main Composition',
        width,
        height,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: fps, den: 1 },
        durationUs: 10_000_000,
        background: '#000000',
        tracks: [
          {
            id: 'track-v1',
            kind: 'video',
            family: 'visual',
            name: 'Video 1',
            order: 0,
            enabled: true,
            locked: false,
            clips: [],
          },
          {
            id: 'track-v2',
            kind: 'video',
            family: 'visual',
            name: 'Video 2',
            order: 1,
            enabled: true,
            locked: false,
            clips: [],
          },
          {
            id: 'track-a1',
            kind: 'video',
            family: 'audio',
            name: 'Audio 1',
            order: 2,
            enabled: true,
            locked: false,
            clips: [],
          },
        ],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
  };
}

export function loadProject(identifier: string, sqlitePath?: string): ProjectLoadResult {
  // Check if identifier is a path to a JSON file
  if (identifier.endsWith('.json') || existsSync(identifier)) {
    const raw = readFileSync(identifier, 'utf8');
    const parsed = JSON.parse(raw);
    const candidate =
      parsed.source?.rootCompositionId !== undefined
        ? parsed.source
        : parsed.project?.rootCompositionId !== undefined
          ? parsed.project
          : parsed;
    const project = candidate as JoyProjectV1;
    return {
      project,
      revision: parsed.revision ?? 1,
      source: 'file',
      path: identifier,
    };
  }

  const dbPath = sqlitePath ?? getDefaultSqlitePath();
  if (!existsSync(dbPath)) {
    throw new Error(`SQLite database not found at ${dbPath}`);
  }

  const store = new SqliteProjectStore<JoyProjectV1, unknown>(dbPath);
  try {
    const snapshots = store.snapshots(identifier);
    if (snapshots.length === 0) {
      throw new Error(`Project "${identifier}" not found in SQLite database at ${dbPath}`);
    }

    const latest = snapshots[snapshots.length - 1]!;
    return {
      project: latest.payload,
      revision: latest.revision,
      source: 'sqlite',
      path: dbPath,
    };
  } finally {
    store.close();
  }
}

export function saveProject(
  project: JoyProjectV1,
  target: { source: 'sqlite' | 'file'; path: string; revision: number },
): number {
  const nextRevision = target.revision + 1;
  const updatedProject = {
    ...project,
    updatedAt: new Date().toISOString(),
  };

  if (target.source === 'file') {
    const output = {
      format: 'joy-media-project',
      schemaVersion: 1,
      revision: nextRevision,
      exportedAt: new Date().toISOString(),
      id: updatedProject.id,
      title: updatedProject.title,
      project: updatedProject,
    };
    writeFileSync(target.path, JSON.stringify(output, null, 2), 'utf8');
    return nextRevision;
  }

  const store = new SqliteProjectStore<JoyProjectV1, unknown>(target.path);
  try {
    store.writeSnapshot(
      project.id,
      {
        revision: nextRevision,
        schemaVersion: 1,
        payload: updatedProject,
        checksum: `sha256-${Date.now().toString(16)}`,
      },
      10,
    );
    return nextRevision;
  } finally {
    store.close();
  }
}

export function listProjects(sqlitePath?: string): ProjectSummary[] {
  const dbPath = sqlitePath ?? getDefaultSqlitePath();
  if (!existsSync(dbPath)) {
    return [];
  }

  const db = new DatabaseSync(dbPath);
  try {
    // Ensure tables exist
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'")
      .get();
    if (!tableCheck) return [];

    const rows = db
      .prepare(
        `SELECT project_id, revision, payload, schema_version 
         FROM snapshots 
         WHERE (project_id, revision) IN (
           SELECT project_id, MAX(revision) FROM snapshots GROUP BY project_id
         )`,
      )
      .all() as Array<{
      project_id: string;
      revision: number;
      payload: string;
      schema_version: number;
    }>;

    const result: ProjectSummary[] = [];

    for (const row of rows) {
      try {
        const project = JSON.parse(row.payload) as JoyProjectV1;
        const root = project.compositions?.[project.rootCompositionId];
        let clipCount = 0;
        let trackCount = 0;
        let durationUs = 0;

        if (root) {
          trackCount = root.tracks?.length ?? 0;
          for (const track of root.tracks ?? []) {
            clipCount += track.clips?.length ?? 0;
          }
          durationUs = projectContentDurationUs(project);
        }

        result.push({
          id: row.project_id,
          title: project.title ?? row.project_id,
          revision: row.revision,
          updatedAt: project.updatedAt ?? new Date().toISOString(),
          clipCount,
          trackCount,
          durationSeconds: Math.round(durationUs / 1_000_000),
        });
      } catch {
        // Ignore corrupted row
      }
    }

    return result;
  } finally {
    db.close();
  }
}
