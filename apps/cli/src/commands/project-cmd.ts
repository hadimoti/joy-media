/* global console */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CliFlags } from '../cli.js';
import { FlagValidationError, NUMERIC_RANGES } from '../utils/flags.js';
import {
  c,
  logError,
  logStep,
  logSuccess,
  logWarn,
  printBanner,
  printTable,
} from '../utils/logger.js';
import {
  CommandFailure,
  createDefaultProject,
  emitJson,
  errorMessage,
  extractProject,
  getDefaultSqlitePath,
  latestRevision,
  listProjects,
  loadProject,
  readProjectJson,
  reportFailure,
  saveProject,
  usageFailure,
  withExclusiveLock,
  writeFileAtomic,
} from '../utils/project-loader.js';

export interface ProjectCommandFlags {
  width?: number | undefined;
  height?: number | undefined;
  fps?: number | undefined;
  output?: string | undefined;
  sqlitePath?: string | undefined;
}

const SUBCOMMANDS = ['list', 'create', 'show', 'export', 'import'] as const;

/**
 * `joy-media project <list|create|show|export|import>`.
 *
 * Contract: exit 0 on success, 1 when the command could not be carried out
 * (project not found, unreadable database ...), 2 when the command line is
 * wrong. With `--json` stdout holds exactly one JSON document (an error is
 * `{"type":"error","code","message"}`) and the banner is never printed;
 * human diagnostics always go to stderr.
 */
export async function handleProjectCommand(args: string[], flags: CliFlags): Promise<number> {
  const json = Boolean(flags.json);
  try {
    validateRange(flags.width, NUMERIC_RANGES.width, 'width');
    validateRange(flags.height, NUMERIC_RANGES.height, 'height');
    validateRange(flags.fps, NUMERIC_RANGES.fps, 'fps');

    const sub = args[0] ?? 'list';
    switch (sub) {
      case 'list':
        return runList(flags, json);
      case 'create':
        return runCreate(args, flags, json);
      case 'show':
        return runShow(args, flags, json);
      case 'export':
        return runExport(args, flags, json);
      case 'import':
        return runImport(args, flags, json);
      default:
        throw usageFailure(
          `Unknown project subcommand: ${sub}. Available: ${SUBCOMMANDS.join(', ')}.`,
        );
    }
  } catch (err) {
    return reportFailure(err, json, 'project');
  }
}

function runList(flags: CliFlags, json: boolean): number {
  const projects = listProjects(flags.sqlitePath, (id, why) =>
    logError(`Skipped project "${id}": its stored data is unreadable (${why}).`),
  );
  if (json) {
    emitJson(projects);
    return 0;
  }
  if (projects.length === 0) {
    logWarn(
      `No projects found in SQLite database (${flags.sqlitePath ?? getDefaultSqlitePath()}).`,
    );
    console.log(`Create one via: ${c('joy-media project create "My Project"', 'cyan')}`);
    return 0;
  }

  printBanner();
  console.log(`  ${c(`Local Projects (${projects.length}):`, 'bold')}\n`);

  const headers = ['ID', 'Title', 'Rev', 'Tracks', 'Clips', 'Duration', 'Updated'];
  const rows = projects.map((p) => [
    p.id,
    p.title,
    String(p.revision),
    String(p.trackCount),
    String(p.clipCount),
    `${p.durationSeconds}s`,
    p.updatedAt.slice(0, 16).replace('T', ' '),
  ]);

  printTable(headers, rows);
  return 0;
}

function runCreate(args: string[], flags: CliFlags, json: boolean): number {
  // The name may be given positionally (`project create "My Project"`, as
  // `project list` suggests) or as `--name`/`-n`; both spellings work.
  const positional = args.length > 1 ? args.slice(1).join(' ').trim() : undefined;
  const named = flags.name?.trim();
  if (positional === '' || named === '') {
    throw usageFailure('The project name is empty. Give a name, e.g. project create "My Project".');
  }
  if (positional !== undefined && named !== undefined && positional !== named) {
    throw usageFailure(
      `Two different project names were given ("${positional}" and --name "${named}"). Use only one.`,
    );
  }
  const title = named ?? positional ?? 'Untitled Project';

  const project = createDefaultProject(title, {
    width: flags.width,
    height: flags.height,
    fps: flags.fps,
  });

  const dbPath = flags.sqlitePath ?? getDefaultSqlitePath();
  const rev = saveProject(project, { source: 'sqlite', path: dbPath, revision: 0 });

  if (json) {
    const root = project.compositions[project.rootCompositionId];
    emitJson({
      id: project.id,
      title: project.title,
      revision: rev,
      width: root?.width,
      height: root?.height,
      fps: root?.frameRate.num,
      sqlitePath: resolve(dbPath),
    });
    return 0;
  }
  logSuccess(
    `Created project: ${c(project.title, 'bold')} (${c(project.id, 'cyan')}) at revision ${rev}.`,
  );
  return 0;
}

/** `<projectId|file.json>` as a positional or, since `-p/--project` is global, as that flag. */
function projectArgument(args: string[], flags: CliFlags, usage: string): string {
  const positional = args[1];
  if (args.length > 2) {
    throw usageFailure(
      `Unexpected extra argument "${args[2]}" (quote names that contain spaces). ${usage}`,
    );
  }
  if (positional !== undefined && flags.project !== undefined && positional !== flags.project) {
    throw usageFailure(
      `Two different projects were given ("${positional}" and --project "${flags.project}"). ${usage}`,
    );
  }
  const id = positional ?? flags.project;
  if (!id) throw usageFailure(usage);
  return id;
}

function runShow(args: string[], flags: CliFlags, json: boolean): number {
  const id = projectArgument(args, flags, 'Usage: joy-media project show <projectId|file.json>');
  const res = loadProject(id, flags.sqlitePath);
  const root = res.project.compositions[res.project.rootCompositionId];
  const tracks = root?.tracks ?? [];

  if (json) {
    emitJson({
      id: res.project.id,
      title: res.project.title,
      revision: res.revision,
      source: res.source,
      path: res.path,
      width: root?.width ?? null,
      height: root?.height ?? null,
      frameRate: root ? root.frameRate.num / root.frameRate.den : null,
      durationUs: root?.durationUs ?? 0,
      assetCount: Object.keys(res.project.assets ?? {}).length,
      tracks: tracks.map((track) => ({
        id: track.id,
        name: track.name ?? track.id,
        family: track.family ?? 'visual',
        order: track.order,
        clips: track.clips.map((clip) => ({
          id: clip.id,
          assetId: 'assetId' in clip ? clip.assetId : null,
          startUs: clip.startUs,
          durationUs: clip.durationUs,
          endUs: clip.startUs + clip.durationUs,
          sourceInUs: 'sourceInUs' in clip ? clip.sourceInUs : null,
        })),
      })),
    });
    return 0;
  }

  printBanner();
  console.log(`  ${c('Project Details:', 'bold')}`);
  logStep('ID', res.project.id);
  logStep('Title', res.project.title);
  logStep('Revision', String(res.revision));
  logStep('Resolution', `${root?.width ?? 1080}×${root?.height ?? 1920}`);
  logStep('Duration', `${Math.round((root?.durationUs ?? 0) / 1_000_000)}s`);
  logStep('Assets', String(Object.keys(res.project.assets ?? {}).length));

  console.log(`\n  ${c('Tracks & Clips:', 'bold')}`);
  for (const track of tracks) {
    console.log(
      `    ${c(track.name ?? track.id, 'cyan')} [${track.family ?? 'visual'}] (order ${track.order}, ${track.clips.length} clip(s)):`,
    );
    for (const clip of track.clips) {
      const startSec = (clip.startUs / 1_000_000).toFixed(2);
      const durSec = (clip.durationUs / 1_000_000).toFixed(2);
      console.log(
        `      • ${c(clip.id, 'dim')} [${startSec}s -> ${(clip.startUs / 1_000_000 + clip.durationUs / 1_000_000).toFixed(2)}s (${durSec}s)]`,
      );
    }
  }
  return 0;
}

function runExport(args: string[], flags: CliFlags, json: boolean): number {
  const id = projectArgument(
    args,
    flags,
    'Usage: joy-media project export <projectId> [--output <file.json>]',
  );
  const res = loadProject(id, flags.sqlitePath);
  // `--out` is the render flag; agents mix the two up, so accept it here too.
  const outPath = flags.output ?? flags.out ?? `${res.project.id}.json`;
  if (process.platform === 'win32' && isWindowsReservedDevicePath(outPath)) {
    throw usageFailure(`The export path contains a reserved Windows device name: ${outPath}`);
  }
  const exported = {
    format: 'joy-media-project',
    schemaVersion: 1,
    app: 'JOY Media CLI',
    exportedAt: new Date().toISOString(),
    id: res.project.id,
    title: res.project.title,
    revision: res.revision,
    source: res.project,
  };

  try {
    writeFileAtomic(outPath, JSON.stringify(exported, null, 2));
  } catch (err) {
    throw new CommandFailure('IO_ERROR', `Export failed: cannot write ${outPath}: ${reason(err)}`);
  }

  if (json) {
    emitJson({
      id: res.project.id,
      title: res.project.title,
      revision: res.revision,
      path: outPath,
    });
    return 0;
  }
  logSuccess(`Exported project to ${c(outPath, 'bold')}.`);
  return 0;
}

function isWindowsReservedDevicePath(path: string): boolean {
  const deviceName = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
  return path.split(/[\\/]/).some((component) => {
    const normalized = component.replace(/[ .]+$/g, '');
    const stem = (normalized.split(/[.:]/, 1)[0] ?? '').replace(/[ .]+$/g, '');
    return deviceName.test(stem);
  });
}

function runImport(args: string[], flags: CliFlags, json: boolean): number {
  const usage = 'Usage: joy-media project import <file.json>';
  const filePath = args[1];
  if (!filePath) throw usageFailure(usage);
  if (args.length > 2) {
    throw usageFailure(`Unexpected extra argument "${args[2]}". ${usage}`);
  }
  if (!existsSync(filePath)) {
    throw new CommandFailure('PROJECT_NOT_FOUND', `File not found: ${filePath}`);
  }

  const parsed = readProjectJson(filePath);
  const project = extractProject(parsed, filePath);
  const fileRevision =
    typeof parsed === 'object' &&
    parsed !== null &&
    Number.isInteger((parsed as { revision?: unknown }).revision) &&
    (parsed as { revision: number }).revision >= 0
      ? (parsed as { revision: number }).revision
      : 0;

  // The imported copy becomes the newest revision. Numbering it from the file's
  // own revision alone could collide with (or sort below) what the database
  // already holds, so the import would fail or be silently shadowed.
  const dbPath = flags.sqlitePath ?? getDefaultSqlitePath();
  const { rev, replaced } = withExclusiveLock(dbPath, () => {
    const head = latestRevision(project.id, dbPath);
    return {
      rev: saveProject(project, {
        source: 'sqlite',
        path: dbPath,
        revision: Math.max(head, fileRevision),
      }),
      replaced: head > 0,
    };
  });

  if (json) {
    emitJson({ id: project.id, title: project.title ?? project.id, revision: rev, replaced });
    return 0;
  }
  logSuccess(
    `Imported project ${c(project.title ?? project.id, 'bold')} (${project.id}) at revision ${rev}` +
      (replaced ? ' (replaced the existing project; earlier revisions are kept).' : '.'),
  );
  return 0;
}

function reason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'the folder does not exist';
  if (code === 'EISDIR') return 'that path is a folder';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  return errorMessage(err);
}

function validateRange(
  value: number | undefined,
  range: { min: number; max: number },
  flag: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value)) {
    throw new FlagValidationError(flag, 'value is not a finite number', value);
  }
  if (value < range.min) {
    throw new FlagValidationError(flag, `value must be >= ${range.min}`, value);
  }
  if (value > range.max) {
    throw new FlagValidationError(flag, `value must be <= ${range.max}`, value);
  }
}
