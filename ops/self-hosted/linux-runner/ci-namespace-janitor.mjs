#!/usr/bin/env node
/* global process, fetch, console, URL */
/**
 * CI namespace janitor — interruption recovery for real-service-acceptance.
 *
 * A run that is SIGKILL'd or cancelled never runs its `finally`, so its
 * PostgreSQL schema (`ci_accept_<runId>_<attempt>_<pass>` /
 * `ci_legacy_accept_<runId>_<attempt>_<pass>`) and its MinIO bucket
 * (`joy-media-<runId>-<attempt>-<pass>`) leak. This tool inventories every such
 * namespace and, only in `--sweep` mode, deletes the ones it can PROVE are
 * orphaned.
 *
 * Proof of orphan = the owning workflow run is terminal (completed with any
 * conclusion, or 404) AND its id is not the current `GITHUB_RUN_ID`. A run that
 * is `in_progress` / `queued`, or whose status cannot be read, is NEVER touched.
 *
 * Modes:
 *   (default)  inventory only — writes test-output/ci-janitor/inventory.json,
 *              deletes nothing.
 *   --sweep    additionally delete namespaces classified `orphan`. Requires
 *              JOY_MEDIA_CI_JANITOR_SWEEP=1 as a second, explicit guard.
 *
 * Env: JOY_MEDIA_CI_DATABASE_URL, JOY_MEDIA_CI_S3_ENDPOINT/ACCESS_KEY/SECRET_KEY,
 *      GITHUB_TOKEN + GITHUB_REPOSITORY (for run-status lookups),
 *      GITHUB_RUN_ID (current run — always excluded).
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { Pool } = nodeRequire('pg');

const SWEEP = process.argv.includes('--sweep') && process.env.JOY_MEDIA_CI_JANITOR_SWEEP === '1';
const currentRunId = String(process.env.GITHUB_RUN_ID ?? '');
const repo = process.env.GITHUB_REPOSITORY ?? '';
const token = process.env.GITHUB_TOKEN ?? '';
const databaseUrl = req('JOY_MEDIA_CI_DATABASE_URL');
const s3Endpoint = req('JOY_MEDIA_CI_S3_ENDPOINT');
const s3AccessKey = req('JOY_MEDIA_CI_S3_ACCESS_KEY');
const s3SecretKey = req('JOY_MEDIA_CI_S3_SECRET_KEY');

const NS_RE = /^(?:ci_accept|ci_legacy_accept)_(\d+)_(\d+)_([12])$/;
const BUCKET_RE = /^joy-media-(\d+)-(\d+)-([12])$/;

function req(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function mc(args) {
  const mcHost = new URL(s3Endpoint);
  mcHost.username = s3AccessKey;
  mcHost.password = s3SecretKey;
  return new Promise((resolve, reject) => {
    const child = spawn('mc', args, {
      env: { ...process.env, 'MC_HOST_joy-ci': mcHost.toString() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.once('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `mc ${args[0]} exited ${code}`)),
    );
  });
}

const runStatusCache = new Map();
async function runStatus(runId) {
  if (runStatusCache.has(runId)) return runStatusCache.get(runId);
  let result;
  if (runId === currentRunId) {
    result = { status: 'current', conclusion: null };
  } else if (!repo || !token) {
    result = { status: 'unknown', conclusion: null };
  } else {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      });
      if (response.status === 404) result = { status: 'not-found', conclusion: null };
      else if (!response.ok) result = { status: 'unknown', conclusion: `http ${response.status}` };
      else {
        const body = await response.json();
        result = { status: body.status, conclusion: body.conclusion };
      }
    } catch (error) {
      result = { status: 'unknown', conclusion: String(error) };
    }
  }
  runStatusCache.set(runId, result);
  return result;
}

function classify(run) {
  if (run.status === 'current') return 'current';
  if (run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting')
    return 'active';
  if (run.status === 'completed' || run.status === 'not-found') return 'orphan';
  return 'unknown';
}

const pool = new Pool({ connectionString: databaseUrl });
const items = [];
try {
  const schemas = await pool.query(
    "SELECT nspname FROM pg_namespace WHERE nspname ~ '^ci_(accept|legacy_accept)_' ORDER BY nspname",
  );
  for (const { nspname } of schemas.rows) {
    const m = NS_RE.exec(nspname);
    if (!m) {
      items.push({ kind: 'schema', name: nspname, classification: 'unrecognized' });
      continue;
    }
    const [, runId, attempt, pass] = m;
    const run = await runStatus(runId);
    items.push({
      kind: 'schema',
      name: nspname,
      runId,
      attempt,
      pass,
      run,
      classification: classify(run),
    });
  }

  let bucketLines = '';
  try {
    bucketLines = await mc(['ls', 'joy-ci/']);
  } catch (error) {
    items.push({ kind: 'bucket-list-error', message: String(error) });
  }
  for (const line of bucketLines.split('\n')) {
    const name = line.trim().split(/\s+/).pop()?.replace(/\/$/, '');
    if (!name) continue;
    const m = BUCKET_RE.exec(name);
    if (!m) continue;
    const [, runId, attempt, pass] = m;
    const run = await runStatus(runId);
    items.push({
      kind: 'bucket',
      name,
      runId,
      attempt,
      pass,
      run,
      classification: classify(run),
    });
  }

  const orphans = items.filter((i) => i.classification === 'orphan');
  const swept = [];
  const sweepErrors = [];
  if (SWEEP) {
    for (const orphan of orphans) {
      try {
        if (orphan.kind === 'schema') {
          await pool.query(`DROP SCHEMA IF EXISTS "${orphan.name}" CASCADE`);
        } else {
          await mc(['rb', '--force', '--quiet', `joy-ci/${orphan.name}`]);
        }
        swept.push(orphan.name);
      } catch (error) {
        sweepErrors.push(
          `${orphan.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    currentRunId,
    mode: SWEEP ? 'sweep' : 'inventory',
    counts: {
      total: items.length,
      current: items.filter((i) => i.classification === 'current').length,
      active: items.filter((i) => i.classification === 'active').length,
      orphan: orphans.length,
      unknown: items.filter((i) => i.classification === 'unknown').length,
    },
    swept,
    sweepErrors,
    items,
  };
  await mkdir('test-output/ci-janitor', { recursive: true });
  await writeFile('test-output/ci-janitor/inventory.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `ci-namespace-janitor (${report.mode}): ${report.counts.total} namespaces — ` +
      `${report.counts.active} active, ${report.counts.orphan} orphan, ` +
      `${report.counts.unknown} unknown; swept ${swept.length}`,
  );
  if (sweepErrors.length > 0) {
    console.error(`sweep errors:\n  ${sweepErrors.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end().catch(() => undefined);
}
