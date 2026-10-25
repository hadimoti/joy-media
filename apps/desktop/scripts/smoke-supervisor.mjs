// Runs one `--smoke` launch of the app, then removes the isolated profile it used.
//
// The app cannot wait for its own exit, and the processes it started can still hold files in the profile for a short
// time after it has gone. So the final cleanup runs here, in a process the app does not control:
//   1. the app is started with the profile name this supervisor chose (JOY_MEDIA_SMOKE_NONCE) and with the supervised
//      flag, so the app leaves the profile in place when it exits;
//   2. when the app exits, the processes it started (its children and their children) are found, and the supervisor
//      waits for them to end;
//   3. any that are still running are stopped by process id, and only after checking that the id still names the same
//      process. Nothing is stopped by name;
//   4. the profile is deleted with bounded retries, and only when it has the expected name, sits directly under the
//      temp folder and carries a marker with the same nonce.
// A profile that cannot be deleted within the budget fails the run with exit code 2, as an undeleted profile always has.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// These names must match apps/desktop/src/main/smoke-isolation.ts. smoke-supervisor.test.mjs checks that they do.
export const SMOKE_PROFILE_PREFIX = 'joy-media-smoke-';
export const SMOKE_MARKER_FILE = 'smoke-profile.json';
export const SMOKE_NONCE_ENVIRONMENT = 'JOY_MEDIA_SMOKE_NONCE';
export const SMOKE_SUPERVISED_ENVIRONMENT = 'JOY_MEDIA_SMOKE_SUPERVISED';

const NONCE_PATTERN = /^[0-9a-f]{32}$/u;
export const CHILD_EXIT_GRACE_MS = 10_000;
export const KILL_GRACE_MS = 5_000;
export const CLEANUP_BUDGET_MS = 30_000;
export const CLEANUP_INTERVAL_MS = 250;
const POLL_MS = 250;
const OUTPUT_GRACE_MS = 2_000;

// A process record: { pid, parentPid, startedAt, name, commandLine }. `startedAt` tells a reused process id apart from
// the process that held it before.

/** Parses the JSON that `Get-CimInstance Win32_Process | ConvertTo-Json` prints. */
export function parseWindowsProcessTable(json) {
  const text = json.trim() === '' ? '[]' : json;
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    parentPid: Number(row.ParentProcessId),
    startedAt: String(row.CreationDate),
    name: String(row.Name ?? ''),
    commandLine: String(row.CommandLine ?? ''),
  }));
}

const POSIX_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/u;

/** Parses the output of `ps -axo pid=,ppid=,lstart=,args=`. */
export function parsePosixProcessTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = POSIX_ROW.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      startedAt: match[3].replace(/\s+/gu, ' '),
      name: match[4].split(' ')[0],
      commandLine: match[4],
    });
  }
  return rows;
}

/** Reads the process table with the platform's own tool: CIM on Windows, ps elsewhere. */
export function readProcessTable(platform = process.platform) {
  if (platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0)
      throw new Error(`the process table could not be read: ${result.stderr}`);
    return parseWindowsProcessTable(result.stdout);
  }
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart=,args='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`the process table could not be read: ${result.stderr}`);
  return parsePosixProcessTable(result.stdout);
}

/** The processes `rootPid` started: its children, their children and so on, as the table shows them now. */
export function ownedProcesses(table, rootPid) {
  const owned = [];
  const seen = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.shift();
    for (const row of table) {
      if (row.parentPid !== parent || seen.has(row.pid)) continue;
      seen.add(row.pid);
      owned.push(row);
      pending.push(row.pid);
    }
  }
  return owned;
}

/** True when the table still lists this exact process: the same id and the same start stamp. */
export function isStillRunning(table, record) {
  return table.some((row) => row.pid === record.pid && row.startedAt === record.startedAt);
}

/**
 * Refuses to delete anything that is not this run's profile: the expected name, directly under the temp folder, and a
 * marker that carries the same nonce. The rules match removeSmokeProfile in smoke-isolation.ts.
 */
export function checkOwnedProfile({ root, tempRoot, nonce, markerText }) {
  if (!NONCE_PATTERN.test(nonce)) {
    return { ok: false, reason: 'the nonce is not 32 lowercase hex characters' };
  }
  const expectedName = `${SMOKE_PROFILE_PREFIX}${nonce}`;
  if (
    basename(root) !== expectedName ||
    relative(resolve(tempRoot), resolve(dirname(root))) !== ''
  ) {
    return { ok: false, reason: "the folder is not this run's profile" };
  }
  if (markerText === null) return { ok: false, reason: 'the profile marker is missing' };
  let marker;
  try {
    marker = JSON.parse(markerText);
  } catch {
    return { ok: false, reason: 'the profile marker is not valid JSON' };
  }
  if (marker?.nonce !== nonce)
    return { ok: false, reason: 'the profile marker belongs to another run' };
  return { ok: true };
}

/**
 * Deletes `root` with bounded retries. A transient lock, such as a file still closing or a scan in progress, makes the
 * deletion fail for a short time, so each failure waits and tries again until the budget runs out.
 */
export async function removeWithRetries({
  root,
  remove,
  exists,
  sleep,
  now,
  budgetMs = CLEANUP_BUDGET_MS,
  intervalMs = CLEANUP_INTERVAL_MS,
}) {
  const started = now();
  let attempts = 0;
  let lastError = '';
  for (;;) {
    attempts += 1;
    try {
      remove(root);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (!exists(root)) return { removed: true, attempts, elapsedMs: now() - started };
    if (now() - started >= budgetMs) {
      return {
        removed: false,
        attempts,
        elapsedMs: now() - started,
        reason: lastError || 'the folder is still present',
      };
    }
    await sleep(intervalMs);
  }
}

/**
 * Starts the app and collects what it prints. The app's exit comes first; output still in flight is awaited only
 * briefly, because a child process that inherited the pipes can keep them open after the app has gone.
 */
export function runAppProcess({ executable, args, cwd, env }) {
  return new Promise((done, failed) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', failed);
    child.once('exit', (code) => {
      let open = 2;
      const finish = () => done({ pid: child.pid, exitCode: code ?? 1, stdout, stderr });
      const timer = setTimeout(finish, OUTPUT_GRACE_MS);
      const streamEnded = () => {
        open -= 1;
        if (open === 0) {
          clearTimeout(timer);
          finish();
        }
      };
      for (const stream of [child.stdout, child.stderr]) {
        if (stream.readableEnded) streamEnded();
        else stream.once('end', streamEnded);
      }
    });
  });
}

const defaultIo = {
  runApp: runAppProcess,
  readTable: () => readProcessTable(),
  kill: (pid) => process.kill(pid, 'SIGKILL'),
  remove: (root) => rmSync(root, { recursive: true }),
  exists: (path) => existsSync(path),
  readText: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => Date.now(),
};

/** Waits until none of `records` is listed any more, or until the grace period ends. Returns those still listed. */
async function waitForRecords(records, io, graceMs) {
  let remaining = records;
  const deadline = io.now() + graceMs;
  while (remaining.length > 0 && io.now() < deadline) {
    await io.sleep(POLL_MS);
    const table = io.readTable();
    remaining = remaining.filter((record) => isStillRunning(table, record));
  }
  return remaining;
}

const describeProcess = (record) => ({ pid: record.pid, name: record.name });

/**
 * Runs the app once in smoke mode and cleans up after it. Returns the app's output, the exit code the run should
 * report, and a summary. `io` replaces the system calls in tests.
 */
export async function superviseSmoke({
  executable,
  args = [],
  cwd = dirname(executable),
  env = process.env,
  tempRoot = tmpdir(),
  nonce = randomBytes(16).toString('hex'),
  io = defaultIo,
}) {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('the smoke nonce must be 32 lowercase hex characters');
  }
  const root = join(tempRoot, `${SMOKE_PROFILE_PREFIX}${nonce}`);
  const app = await io.runApp({
    executable,
    args,
    cwd,
    env: { ...env, [SMOKE_NONCE_ENVIRONMENT]: nonce, [SMOKE_SUPERVISED_ENVIRONMENT]: '1' },
  });

  // Wait for the processes the app started, then stop only the ones that are still running.
  const owned = ownedProcesses(io.readTable(), app.pid);
  const stillRunning =
    owned.length === 0 ? [] : await waitForRecords(owned, io, CHILD_EXIT_GRACE_MS);
  const stopped = [];
  const survivors = [];
  for (const record of stillRunning) {
    if (!isStillRunning(io.readTable(), record)) continue;
    try {
      io.kill(record.pid);
      stopped.push(record);
    } catch (error) {
      survivors.push({ ...describeProcess(record), reason: error.message });
    }
  }
  if (stopped.length > 0) {
    const afterStop = await waitForRecords(stopped, io, KILL_GRACE_MS);
    for (const record of afterStop) {
      survivors.push({ ...describeProcess(record), reason: 'still listed after it was stopped' });
    }
  }

  let profile;
  if (!io.exists(root)) {
    profile = { removed: true, attempts: 0, elapsedMs: 0, note: 'no profile folder was left' };
  } else {
    const ownership = checkOwnedProfile({
      root,
      tempRoot,
      nonce,
      markerText: io.readText(join(root, SMOKE_MARKER_FILE)),
    });
    profile = ownership.ok
      ? await removeWithRetries({
          root,
          remove: io.remove,
          exists: io.exists,
          sleep: io.sleep,
          now: io.now,
        })
      : { removed: false, attempts: 0, elapsedMs: 0, reason: ownership.reason };
  }

  const exitCode = app.exitCode === 0 && !profile.removed ? 2 : app.exitCode;
  const summary = {
    app: { pid: app.pid, exitCode: app.exitCode },
    ownedProcesses: owned.map(describeProcess),
    stoppedProcesses: stopped.map(describeProcess),
    survivingProcesses: survivors,
    profile,
    exitCode,
  };
  return { exitCode, stdout: app.stdout, stderr: app.stderr, summary };
}

/** `--exe <app> [--cwd <folder>] -- <app arguments>`. */
export function parseSupervisorArguments(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0) {
    throw new Error('usage: smoke-supervisor.mjs --exe <app> [--cwd <folder>] -- <app arguments>');
  }
  const options = argv.slice(0, separator);
  const parsed = {};
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index];
    const value = options[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`expected --name value pairs, got: ${key}`);
    }
    parsed[key.slice(2)] = value;
  }
  if (!parsed.exe) throw new Error('missing --exe');
  const executable = resolve(parsed.exe);
  return {
    executable,
    cwd: resolve(parsed.cwd ?? dirname(executable)),
    args: argv.slice(separator + 1),
  };
}

export async function main(argv) {
  const options = parseSupervisorArguments(argv);
  const result = await superviseSmoke(options);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.stdout.write(`[smoke-supervisor] ${JSON.stringify(result.summary)}\n`);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    },
  );
}
