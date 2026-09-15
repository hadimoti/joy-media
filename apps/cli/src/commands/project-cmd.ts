/* global console */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  createDefaultProject,
  getDefaultSqlitePath,
  listProjects,
  loadProject,
  saveProject,
} from '../utils/project-loader.js';

export interface ProjectCommandFlags {
  width?: number | undefined;
  height?: number | undefined;
  fps?: number | undefined;
  output?: string | undefined;
  sqlitePath?: string | undefined;
}

export async function handleProjectCommand(
  args: string[],
  flags: ProjectCommandFlags,
): Promise<number> {
  const sub = args[0] ?? 'list';

  if (sub === 'list') {
    const projects = listProjects(flags.sqlitePath);
    if (projects.length === 0) {
      logWarn(`No projects found in SQLite database (${getDefaultSqlitePath()}).`);
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

  if (sub === 'create') {
    const title = args.slice(1).join(' ').trim() || 'Untitled Project';
    const project = createDefaultProject(title, {
      width: flags.width,
      height: flags.height,
      fps: flags.fps,
    });

    const target = {
      source: 'sqlite' as const,
      path: flags.sqlitePath ?? getDefaultSqlitePath(),
      revision: 0,
    };

    const rev = saveProject(project, target);
    logSuccess(
      `Created project: ${c(project.title, 'bold')} (${c(project.id, 'cyan')}) at revision ${rev}.`,
    );
    return 0;
  }

  if (sub === 'show') {
    const id = args[1];
    if (!id) {
      logError('Usage: joy-media project show <projectId|file.json>');
      return 1;
    }

    try {
      const res = loadProject(id, flags.sqlitePath);
      const root = res.project.compositions[res.project.rootCompositionId];

      printBanner();
      console.log(`  ${c('Project Details:', 'bold')}`);
      logStep('ID', res.project.id);
      logStep('Title', res.project.title);
      logStep('Revision', String(res.revision));
      logStep('Resolution', `${root?.width ?? 1080}×${root?.height ?? 1920}`);
      logStep('Duration', `${Math.round((root?.durationUs ?? 0) / 1_000_000)}s`);
      logStep('Assets', String(Object.keys(res.project.assets ?? {}).length));

      console.log(`\n  ${c('Tracks & Clips:', 'bold')}`);
      for (const track of root?.tracks ?? []) {
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
    } catch (err) {
      logError(`Cannot show project: ${String(err)}`);
      return 1;
    }
  }

  if (sub === 'export') {
    const id = args[1];
    if (!id) {
      logError('Usage: joy-media project export <projectId> [--output <file.json>]');
      return 1;
    }

    try {
      const res = loadProject(id, flags.sqlitePath);
      const outPath = flags.output ?? `${res.project.id}.json`;
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

      writeFileSync(outPath, JSON.stringify(exported, null, 2), 'utf8');
      logSuccess(`Exported project to ${c(outPath, 'bold')}.`);
      return 0;
    } catch (err) {
      logError(`Export failed: ${String(err)}`);
      return 1;
    }
  }

  if (sub === 'import') {
    const filePath = args[1];
    if (!filePath || !existsSync(filePath)) {
      logError('Usage: joy-media project import <file.json>');
      return 1;
    }

    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const candidate =
        parsed.source?.rootCompositionId !== undefined
          ? parsed.source
          : parsed.project?.rootCompositionId !== undefined
            ? parsed.project
            : parsed;
      const project = candidate;
      if (!project || !project.id || !project.rootCompositionId) {
        throw new Error('Invalid project JSON structure');
      }

      const rev = saveProject(project, {
        source: 'sqlite',
        path: flags.sqlitePath ?? getDefaultSqlitePath(),
        revision: parsed.revision ?? 0,
      });

      logSuccess(
        `Imported project ${c(project.title ?? project.id, 'bold')} (${project.id}) at revision ${rev}.`,
      );
      return 0;
    } catch (err) {
      logError(`Import failed: ${String(err)}`);
      return 1;
    }
  }

  logError(`Unknown project subcommand: ${sub}`);
  console.log(
    `Available: ${c('list', 'cyan')}, ${c('create', 'cyan')}, ${c('show', 'cyan')}, ${c('export', 'cyan')}, ${c('import', 'cyan')}`,
  );
  return 1;
}
