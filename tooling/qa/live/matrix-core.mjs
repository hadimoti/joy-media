/* global window, document, localStorage */
/**
 * Shared core of the T-A05 and T-A06 desktop matrix rows.
 *
 * A row is `{ id, area, title, severity, run(page, ctx) }`. `run` returns a message string, or
 * `{ message, evidence: [paths] }`, and throws on a failure. `executeRow` turns that into the
 * `result.json` object (`id`, `status`, `message`, `screenshot`, `ms`, `evidence`, and for a
 * fail or a block a `defect` text in the T-A16 format) and writes `<out>/<id>/defect.md`.
 *
 * NOT RUN LIVE: every selector comes from reading the source. Confirm each one on the first
 * live pass (see the report of T-A05 and T-A06).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { labRoots } from './lab-roots.mjs';

export const FIXTURE_ROOT = labRoots().fixtures;

const LOGGED_PREFIXES = ['desktop.media.', 'desktop.asset-library.'];
const MAX_LOGGED_REPLY_CHARS = 4000;

/** JSON with sorted keys, so two equal documents compare equal as strings. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** The document without the fields that change on every save, for undo and redo comparisons. */
export function normalizeDocument(document) {
  if (document === null || typeof document !== 'object') return stableStringify(document);
  const { updatedAt: _updatedAt, ...rest } = document;
  return stableStringify(rest);
}

/** The text of a defect entry in the T-A16 format. CC assigns the ID, owner and branch. */
export function formatDefectEntry({ foundBy, title, what, expected, severity, evidence = [] }) {
  const lines = [
    `### X-??? ${title}`,
    `- ID: X-??? (CC assigns the next free number in docs/qa/v1.1.1/DEFECTS.md)`,
    `- Found by: ${foundBy}`,
    `- What happens: ${what}`,
    `- Expected: ${expected}`,
    `- Severity: ${severity} (proposed by the test; CC ranks)`,
    `- Owner agent: (CC assigns)`,
    `- Branch: (CC assigns, v111/fix-X-nnn)`,
    `- Status: open`,
    `- Retest result: not rerun`,
    `- Evidence: ${evidence.length === 0 ? 'none' : evidence.join('; ')}`,
  ];
  return `${lines.join('\n')}\n`;
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return { text: 'undefined', truncated: false };
    if (text.length <= MAX_LOGGED_REPLY_CHARS) return { text, truncated: false };
    return { text: text.slice(0, MAX_LOGGED_REPLY_CHARS), truncated: true };
  } catch {
    return { text: String(value), truncated: false };
  }
}

/**
 * Append-only `bridge-replies.jsonl`. Only `desktop.media.*` and `desktop.asset-library.*`
 * replies are kept; every line carries the step label that caused it.
 */
export function createBridgeLog(filePath, { now = () => new Date().toISOString() } = {}) {
  const entries = [];
  let label = '';
  if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  return {
    entries,
    setLabel(next) {
      label = next;
    },
    record(channel, payload, outcome, origin = 'driver') {
      if (!LOGGED_PREFIXES.some((prefix) => channel.startsWith(prefix))) return undefined;
      const reply = safeJson(outcome.ok ? outcome.reply : outcome.error);
      const entry = {
        at: now(),
        step: label,
        origin,
        channel,
        payload: safeJson(payload).text,
        ok: outcome.ok,
        reply: reply.text,
        ...(reply.truncated ? { truncated: true } : {}),
      };
      entries.push(entry);
      if (filePath) appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      return entry;
    },
  };
}

/**
 * Calls a bridge channel from the page and logs the reply. The preload passes only a result's
 * `data` through, so a reply is the data itself; a refusal is a thrown error.
 */
export function createBridge(page, log) {
  return {
    log,
    async invoke(channel, payload = {}) {
      let outcome;
      try {
        const reply = await page.evaluate(
          // Calls the original bridge, never the tap wrapper, so a step's own call is logged once (as "driver").
          ([name, body]) =>
            (window.__joyBridgeOriginalInvoke ?? window.joyDesktop.invoke.bind(window.joyDesktop))(
              name,
              body,
            ),
          [channel, payload],
        );
        outcome = { ok: true, reply };
      } catch (error) {
        outcome = { ok: false, error: String(error?.message ?? error).split('\n')[0] };
      }
      log.record(channel, payload, outcome);
      if (!outcome.ok) throw new Error(`bridge ${channel} failed: ${outcome.error}`);
      return outcome.reply;
    },
    /**
     * Tries to wrap `window.joyDesktop.invoke` in the page so calls made by the UI itself are
     * recorded too. The contextBridge object may be frozen; then this returns false and the log
     * holds only the calls the steps make (and the readbacks after each step).
     */
    async installTap() {
      const installed = await page.evaluate(() => {
        const bridge = window.joyDesktop;
        if (!bridge || typeof bridge.invoke !== 'function') return false;
        if (window.__joyBridgeTap) return true;
        try {
          const tap = [];
          const original = bridge.invoke.bind(bridge);
          Object.defineProperty(bridge, 'invoke', {
            configurable: true,
            value: async (channel, payload) => {
              try {
                const reply = await original(channel, payload);
                tap.push({ channel, payload, ok: true, reply });
                return reply;
              } catch (error) {
                tap.push({ channel, payload, ok: false, error: String(error?.message ?? error) });
                throw error;
              }
            },
          });
          window.__joyBridgeTap = tap;
          window.__joyBridgeOriginalInvoke = original;
          return true;
        } catch {
          return false;
        }
      });
      return installed === true;
    },
    /** Moves the calls the UI made since the last drain into the log. Returns how many. */
    async drainTap() {
      const calls = await page.evaluate(() => {
        const tap = window.__joyBridgeTap;
        return Array.isArray(tap) ? tap.splice(0, tap.length) : [];
      });
      let count = 0;
      for (const call of Array.isArray(calls) ? calls : []) {
        log.record(
          call.channel,
          call.payload,
          call.ok ? { ok: true, reply: call.reply } : { ok: false, error: call.error },
          'ui',
        );
        count += 1;
      }
      return count;
    },
  };
}

/** The editor and bridge ids of the open project, read from the editor's own local storage. */
export async function readProjectIds(page) {
  return page.evaluate(() => {
    const read = (key) => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? 'null');
      } catch {
        return null;
      }
    };
    const active = read('joy-media.active-project.v1')?.projectId ?? null;
    const entry = read('joy-media.project-catalog.v1')?.projects?.[active] ?? null;
    const bindings = Object.values(
      read('joy-media.control-plane-project-bindings.v1')?.bindingsByOwner ?? {},
    ).flatMap((owner) => Object.values(owner));
    const match = bindings.find(
      (binding) =>
        binding.editorProjectId === active ||
        binding.editorProjectId === entry?.timelineProjectId ||
        binding.editorProjectId === entry?.visualProjectId,
    );
    return {
      active,
      title: entry?.title ?? null,
      controlPlaneProjectId: match?.controlPlaneProjectId ?? null,
      bindingCount: bindings.length,
    };
  });
}

/** The stored document of the open project through `desktop.media.project.document.get`. */
/**
 * The editor's live timeline project (tracks and clips), read from the page's own session. Found live on the
 * laptop (16 Nov 2026): `desktop.media.project.document.get` returns only the visual document (`document`,
 * `lookInstances`); the timeline clips live in the editor session (the revision id counts them as `timeline=N`),
 * so a row that counts clips must read them here. Returns null when no session is found.
 */
export async function readLiveTimeline(page) {
  const json = await page.evaluate(() => {
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((name) => name.startsWith('__reactContainer'));
    if (!key) return null;
    const seen = new Set();
    const stack = [root[key]];
    while (stack.length > 0) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      for (const props of [fiber.memoizedProps, fiber.memoizedState]) {
        if (!props || typeof props !== 'object') continue;
        const session = props.session ?? props.context?.session;
        if (session?.timelineProject?.compositions) {
          try {
            return JSON.stringify(session.timelineProject);
          } catch {
            return null;
          }
        }
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return null;
  });
  return json === null || json === undefined ? null : JSON.parse(json);
}

export async function readDocument(page, bridge) {
  const live = await readLiveTimeline(page).catch(() => null);
  const ids = await readProjectIds(page);
  if (!ids?.controlPlaneProjectId) {
    if (live !== null) {
      return { projectId: ids?.active ?? 'live', revisionId: 'live', document: live };
    }
    throw new Error(
      `BLOCKED: no bridge project id for the open project (active ${ids?.active ?? 'none'}, ${ids?.bindingCount ?? 0} bindings); the project may not have been saved yet`,
    );
  }
  const reply = await bridge.invoke('desktop.media.project.document.get', {
    projectId: ids.controlPlaneProjectId,
  });
  const view = reply?.data ?? reply;
  if (!view?.document) throw new Error('desktop.media.project.document.get returned no document');
  return {
    projectId: ids.controlPlaneProjectId,
    revisionId: view.revisionId,
    // The timeline (clips) is the live one; the stored visual document stays available beside it.
    document: live ?? view.document,
    storedDocument: view.document,
  };
}

/** The root composition of a stored document. */
export function rootComposition(document) {
  return document?.compositions?.[document?.rootCompositionId];
}

/** Every clip of the root composition with its track id, in track order. */
export function clipsOf(document) {
  const composition = rootComposition(document);
  const out = [];
  for (const track of composition?.tracks ?? []) {
    for (const clip of track.clips ?? []) out.push({ trackId: track.id, clip });
  }
  return out;
}

export async function pollUntil(read, accept, { timeoutMs = 8000, intervalMs = 250, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (accept(last)) return { ok: true, value: last };
    if (Date.now() >= deadline) return { ok: false, value: last };
    await wait(intervalMs);
  }
}

function snapshotPath(ctx, rowId, name) {
  return join(ctx.outDir, rowId, `${name}.json`);
}

export function writeSnapshot(ctx, rowId, name, document) {
  const path = snapshotPath(ctx, rowId, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * The do, undo, redo cycle of T-A06. `row.act(page, ctx)` does the edit through the UI;
 * `row.check(before, after)` returns an error text or undefined; the document is read through
 * the bridge before, after, after undo and after redo, and each snapshot is written.
 */
export async function runCommandCycle(row, page, ctx) {
  const evidence = [];
  const read = async () => (await readDocument(page, ctx.bridge)).document;
  const key = (document) => normalizeDocument(document);
  const waitFor = async (accept) => pollUntil(read, accept, ctx.poll);
  const before = await read();
  evidence.push(writeSnapshot(ctx, row.id, 'before', before));

  ctx.bridge.log.setLabel(`${row.id} do`);
  await row.act(page, ctx);
  const changed = await waitFor((document) => key(document) !== key(before));
  if (!changed.ok) {
    throw new Error(`${row.command}: the document did not change on the bridge after the edit`);
  }
  const after = changed.value;
  evidence.push(writeSnapshot(ctx, row.id, 'after', after));
  const problem = row.check?.(before, after);
  if (problem) throw new Error(`${row.command}: ${problem}`);

  ctx.bridge.log.setLabel(`${row.id} undo`);
  await ctx.undo(page);
  const undone = await waitFor((document) => key(document) === key(before));
  evidence.push(writeSnapshot(ctx, row.id, 'after-undo', undone.value));
  if (!undone.ok) throw new Error(`${row.command}: undo did not bring the document back`);

  ctx.bridge.log.setLabel(`${row.id} redo`);
  await ctx.redo(page);
  const redone = await waitFor((document) => key(document) === key(after));
  evidence.push(writeSnapshot(ctx, row.id, 'after-redo', redone.value));
  if (!redone.ok) throw new Error(`${row.command}: redo did not bring the edit back`);

  return {
    message: `${row.command}: done, checked, undone and redone through the bridge`,
    evidence,
  };
}

/**
 * Runs one row and builds its result. Never throws. A message that starts with BLOCKED is a
 * blocked row (the setup is missing), anything else that throws is a fail.
 */
export async function executeRow(row, page, ctx) {
  const startedAt = Date.now();
  ctx.bridge?.log.setLabel(row.id);
  // A menu or popup left open by the row before would block every click of this one: close it first.
  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  let status = 'passed';
  let message = '';
  let evidence = [];
  try {
    const outcome = await row.run(page, ctx);
    if (typeof outcome === 'string') message = outcome;
    else {
      message = outcome?.message ?? '';
      evidence = outcome?.evidence ?? [];
    }
  } catch (error) {
    message = String(error?.message ?? error)
      .split('\n')[0]
      .slice(0, 400);
    if (/^NOT-REACHABLE/u.test(message)) status = 'not-reachable';
    else status = /^BLOCKED/u.test(message) ? 'blocked' : 'failed';
  }
  await ctx.bridge?.drainTap?.().catch(() => 0);
  const result = {
    id: row.id,
    status,
    message,
    screenshot: null,
    ms: Date.now() - startedAt,
    evidence,
  };
  if (ctx.shot) result.screenshot = await ctx.shot(row.id, 'end').catch(() => null);
  // A blocked row is a missing setup, not a product defect: it gets no defect text.
  if (status === 'failed') {
    result.defect = formatDefectEntry({
      foundBy: row.id,
      title: `${row.title}: fails`,
      what: message,
      expected: row.expected ?? row.title,
      severity: row.severity ?? 'major',
      evidence: [...evidence, ...(result.screenshot ? [result.screenshot] : [])],
    });
    if (ctx.outDir) {
      const path = join(ctx.outDir, row.id, 'defect.md');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, result.defect, 'utf8');
    }
  }
  return result;
}

/** A row's results for a `--tests` list that contains an id this table owns. */
export function rowsById(rows) {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}
