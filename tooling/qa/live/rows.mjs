/**
 * T-A07 / T-A08 matrix rows: the row shape, the runner, the `result.json` writer and the defect text.
 *
 * A row is `{ id, area, severity?, run(page, ctx) }`. `run` returns a short message (or `{ message, parts }`
 * when one row checks many things, such as every shortcut of the dialog) and throws to fail. A throw whose
 * message starts with `BLOCKED` or `NOT REACHABLE` records `status: "blocked"`, never a pass and never a defect.
 *
 * `result.json` carries both field sets the plan uses: `status`, `message`, `screenshot`, `ms` (T-A02 card)
 * and `detail`, `durationMs` (matrix section 1). A failed row also gets `defect.txt` in the T-A16 format:
 * a table line for `docs/qa/v1.1.1/DEFECTS.md` and the long form below it. CC assigns the `X-nnn` number.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BLOCKED_PATTERN = /^(BLOCKED|NOT REACHABLE)/u;

export function blockedRow(id, why) {
  return new Error(`BLOCKED ${id}: ${why}`);
}

export function notReachable(id, why) {
  return new Error(`NOT REACHABLE ${id}: ${why}`);
}

export function firstLine(error, max = 400) {
  return String(error?.message ?? error)
    .split('\n')[0]
    .slice(0, max);
}

export function statusOfMessage(message) {
  return BLOCKED_PATTERN.test(message) ? 'blocked' : 'failed';
}

const clean = (text) => String(text).replace(/\s+/gu, ' ').replace(/\|/gu, '/').trim();

/** The defect entry text of the T-A16 format. The first line is one table row, the rest is the long form. */
export function formatDefect({ id, area, what, expected, severity = 'major', owner = 'CX' }) {
  if (!['blocker', 'major', 'minor'].includes(severity)) {
    throw new Error(`severity must be blocker, major or minor, not ${severity}`);
  }
  return [
    `| X-??? | ${id} | ${clean(what)} | ${clean(expected)} | ${severity} | ${owner} | v111/fix-X-??? | open | not retested |`,
    '',
    `Defect entry (T-A16 format); CC assigns the X number.`,
    `Found by: ${id} (${clean(area)})`,
    `What happens: ${clean(what)}`,
    `Expected: ${clean(expected)}`,
    `Severity: ${severity}`,
    `Owner agent: ${owner}`,
    `Branch: v111/fix-X-???`,
    `Status: open`,
    `Retest result: not retested`,
    '',
  ].join('\n');
}

/** Runs one row. Never throws: a throw becomes `failed` or `blocked`. Returns `{ result, defect }`. */
export async function runRow(row, ctx) {
  const startedAt = Date.now();
  let status = 'passed';
  let message = row.area;
  let parts;
  try {
    const answer = await row.run(ctx.page, ctx);
    if (typeof answer === 'string') message = answer;
    else if (answer !== undefined && answer !== null) {
      message = answer.message ?? message;
      parts = answer.parts;
    }
  } catch (error) {
    message = firstLine(error);
    status = statusOfMessage(message);
    if (Array.isArray(error?.parts)) parts = error.parts;
  }
  let screenshot = null;
  try {
    screenshot = (await ctx.shot?.(join(ctx.outDir, row.id, 'screenshot.png'))) ?? null;
  } catch {
    screenshot = null;
  }
  const ms = Date.now() - startedAt;
  const result = {
    id: row.id,
    status,
    message,
    detail: message,
    screenshot,
    ms,
    durationMs: ms,
    ...(parts === undefined ? {} : { parts }),
  };
  const defect =
    status === 'failed'
      ? formatDefect({
          id: row.id,
          area: row.area,
          what: message,
          expected: row.expected ?? row.area,
          severity: row.severity ?? 'major',
        })
      : undefined;
  return { result, defect };
}

/** Writes `<outDir>/<id>/result.json` and, for a failed row, `<outDir>/<id>/defect.txt`. */
export function writeRowEvidence(outDir, { result, defect }) {
  const dir = join(outDir, result.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (defect !== undefined) writeFileSync(join(dir, 'defect.txt'), defect, 'utf8');
}

/**
 * Runs one check per item (a shortcut, a menu entry, a preset) and keeps every outcome in `parts`.
 * Returns `{ message, parts }` when no item failed. Throws when one failed (the error carries `parts`), and throws
 * a `NOT REACHABLE` error when nothing passed and some items were not reachable, so a row never passes on nothing.
 * `fn(item)` returns a message or throws; a thrown `BLOCKED`/`NOT REACHABLE` message makes that part `blocked`.
 */
export async function runParts(id, label, items, fn) {
  const parts = [];
  for (const item of items) {
    const name = item?.name ?? String(item);
    try {
      parts.push({ name, status: 'passed', message: String((await fn(item)) ?? '') });
    } catch (error) {
      const message = firstLine(error);
      parts.push({ name, status: statusOfMessage(message), message });
    }
  }
  const passed = parts.filter((part) => part.status === 'passed').length;
  const failed = parts.filter((part) => part.status === 'failed');
  const blocked = parts.filter((part) => part.status === 'blocked');
  if (failed.length > 0) {
    const error = new Error(
      `${failed.length} of ${parts.length} ${label} failed: ${failed
        .map((part) => `${part.name} (${part.message})`)
        .join('; ')}`,
    );
    error.parts = parts;
    throw error;
  }
  if (passed === 0 && blocked.length > 0) {
    const error = new Error(
      `NOT REACHABLE ${id}: none of ${parts.length} ${label} could be checked: ${blocked
        .map((part) => `${part.name} (${part.message})`)
        .join('; ')}`,
    );
    error.parts = parts;
    throw error;
  }
  return {
    message: `${passed} of ${parts.length} ${label} passed${
      blocked.length > 0 ? `, ${blocked.length} not reachable` : ''
    }`,
    parts,
  };
}

/** Runs rows in order. A row that needs the app to be unchanged by an earlier one is listed after it. */
export async function runRows(rows, ctx) {
  const outcomes = [];
  for (const row of rows) {
    const outcome = await runRow(row, ctx);
    writeRowEvidence(ctx.outDir, outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

/** `D-0*` style prefixes expand to every row id that starts with the prefix. */
export function selectRows(allRows, ids) {
  const picked = [];
  for (const id of ids) {
    const matches = id.endsWith('*')
      ? allRows.filter((row) => row.id.startsWith(id.slice(0, -1)))
      : allRows.filter((row) => row.id === id);
    for (const row of matches) if (!picked.includes(row)) picked.push(row);
  }
  return picked;
}
