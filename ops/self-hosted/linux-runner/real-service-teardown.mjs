/* global process, setTimeout */

/**
 * Teardown mechanics for the isolated real-service acceptance harness, split out
 * so they can be exercised by a short integration test (node --test) without the
 * 30-minute effects soak or any real Postgres/MinIO dependency.
 *
 * Ownership model, established before any escalation happens here:
 *   - The web dev server is spawned by the harness with `{ detached: true }`, so
 *     its pid is a process-group leader and the whole group is provably
 *     run-owned. Escalating an unresponsive group to SIGKILL is therefore safe.
 *   - The temp root is created by the harness via `mkdtemp`; the only writers are
 *     the harness itself, the disposable in-process export worker (awaited to
 *     completion before removal), and the MinIO client's config directory. The
 *     MinIO client UNCONDITIONALLY recreates `MC_CONFIG_DIR` on every invocation
 *     (even a failing one), so no `mc` call may run against a path under the temp
 *     root after it has been removed — the caller must give post-removal
 *     verification its own throwaway config directory.
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POSIX liveness probe. `process.kill(pid, 0)` throws ESRCH when pid is gone. */
export function isAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else — not our
    // case (we spawned it), but treat "exists" as alive to stay conservative.
    return error?.code === 'EPERM';
  }
}

/**
 * Request shutdown of a run-owned detached child, await its exit within a
 * bounded grace window, then escalate the proven-owned group to SIGKILL and
 * verify the group is gone. Never throws; returns a structured record. This is
 * NOT a fixed sleep — every wait ends as soon as the process is observed gone.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ graceMs?: number, killMs?: number, pollMs?: number, now?: () => number }} [options]
 */
export async function terminateProcessTree(child, options = {}) {
  const graceMs = options.graceMs ?? 15_000;
  const killMs = options.killMs ?? 5_000;
  const pollMs = options.pollMs ?? 200;
  const now = options.now ?? Date.now;

  const pid = typeof child?.pid === 'number' ? child.pid : null;
  const record = {
    pid,
    signalRequested: false,
    escalatedToKill: false,
    waitedMs: 0,
    state: 'unknown',
  };
  if (pid === null) {
    record.state = 'no-pid';
    return record;
  }

  let exited = child.exitCode !== null || child.signalCode !== null || !isAlive(pid);
  const onExit = () => {
    exited = true;
  };
  child.once('exit', onExit);
  const alive = () => !exited && isAlive(pid);

  try {
    if (!alive()) {
      record.state = 'already-exited';
      return record;
    }
    const started = now();
    const signalGroup = (signal) => {
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      }
    };

    record.signalRequested = signalGroup('SIGTERM');
    const graceDeadline = started + graceMs;
    while (now() < graceDeadline) {
      if (!alive()) {
        record.state = 'terminated';
        record.waitedMs = now() - started;
        return record;
      }
      await delay(pollMs);
    }

    // Unresponsive after the grace window — escalate the run-owned group.
    record.escalatedToKill = true;
    signalGroup('SIGKILL');
    const killDeadline = now() + killMs;
    while (now() < killDeadline) {
      if (!alive()) {
        record.state = 'sigkilled';
        record.waitedMs = now() - started;
        return record;
      }
      await delay(pollMs);
    }
    record.state = alive() ? 'survived' : 'sigkilled';
    record.waitedMs = now() - started;
    return record;
  } finally {
    child.removeListener('exit', onExit);
  }
}

/**
 * Remove a directory the harness owns, retrying a bounded number of times. Each
 * attempt removes then re-stats; if the path is still present the remaining
 * entry names (names only — never contents) are recorded so a surviving writer
 * is visible in evidence rather than hidden by the retry. Callers MUST ensure
 * every producer (child process, export worker, `mc`) has stopped before calling
 * this — the retry is a guard against a lingering file handle, not a way to
 * out-race an active writer.
 *
 * @param {string} dir
 * @param {{ attempts?: number, delayMs?: number, fs?: typeof import('node:fs/promises') }} [options]
 */
export async function removeDirWithRetry(dir, options = {}) {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 200;
  const fs = options.fs ?? (await import('node:fs/promises'));

  const record = { dir, removed: false, attempts: 0, residualEntries: [] };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    record.attempts = attempt;
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // fall through to the stat check — a concurrent unlink can race rm
    }
    try {
      await fs.stat(dir);
      try {
        record.residualEntries = (await fs.readdir(dir)).slice(0, 50).sort();
      } catch {
        record.residualEntries = [];
      }
      if (attempt < attempts) await delay(delayMs);
    } catch {
      record.removed = true;
      record.residualEntries = [];
      return record;
    }
  }
  return record;
}
