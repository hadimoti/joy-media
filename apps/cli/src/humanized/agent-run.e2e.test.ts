/**
 * `joy-media agent run "<instruction>" [--apply]` against the real binary and
 * a hermetic mock LLM. What an AI caller relies on:
 *   - without --apply nothing is written, and the output says what WOULD change;
 *   - with --apply the change is committed exactly once, visible to a fresh process;
 *   - provider failures (401/429/500/garbage/hang) exit 1 with an actionable
 *     message and leave the project untouched;
 *   - invalid proposals never partially mutate the project.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addClip,
  clipsOf,
  createAgentSandbox,
  createProject,
  deferred,
  fakeKey,
  httpError,
  proposeTimeline,
  readProjects,
  setProjectUpdatedAt,
  startMockLlm,
  text,
  toolCalls,
  type AgentSandbox,
  type ChatReply,
  type MockLlmServer,
} from './agent-helpers.js';
import { describeRun, hasAnsi } from './harness.js';

const KEY = fakeKey('run');

const insertOp = (id: string, trackId = 'track-v1') => ({
  kind: 'insert',
  id,
  assetId: 'asset-intro',
  trackId,
  startUs: 0,
  durationUs: 3_000_000,
  dependsOn: [],
});

describe('agent run (real binary, mock LLM)', () => {
  let mock: MockLlmServer;
  let env: AgentSandbox;
  let projectId: string;

  const provider = (): string[] => ['--url', mock.url, '--api-key', KEY, '--model', 'mock/editor'];
  const project = () => readProjects(env.sb).find((p) => p.id === projectId)!;

  beforeAll(async () => {
    mock = await startMockLlm();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(async () => {
    mock.reset();
    env = createAgentSandbox('agent-run');
    projectId = await createProject(env.sb, 'Run Target');
  });
  afterEach(() => {
    expect(env.externalCalls(), 'the CLI must never leave loopback in tests').toEqual([]);
    env.cleanup();
  });

  it('dry run: shows the proposed change, sends a well-formed request, writes nothing', async () => {
    mock.script(toolCalls(proposeTimeline(insertOp('agent-intro'))), text('Staged an intro clip.'));

    const r = await env.run([
      'agent',
      'run',
      'add an intro clip',
      '--project',
      projectId,
      ...provider(),
    ]);

    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/insert clip agent-intro .*track-v1/);
    expect(r.out).toMatch(/Dry run: nothing was saved/);
    expect(project().revision).toBe(1);
    expect(clipsOf(project())).toEqual([]);

    const [first] = mock.chatRequests;
    expect(first?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(first?.json?.model).toBe('mock/editor');
    const tools = (first?.json?.tools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(tools).toContain('propose_timeline_operations');
    expect(JSON.stringify(first?.json?.messages)).toContain('add an intro clip');
  });

  it('--apply commits once; a fresh process sees the new revision and clip', async () => {
    mock.script(toolCalls(proposeTimeline(insertOp('agent-intro'))), text('Done.'));

    const r = await env.run([
      'agent',
      'run',
      'add an intro clip',
      '--project',
      projectId,
      '--apply',
      ...provider(),
    ]);

    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/Committed changes at project revision 2/);
    expect(project().revision).toBe(2);
    expect(clipsOf(project()).map((c) => c.id)).toEqual(['agent-intro']);

    const show = await env.run(['project', 'show', projectId]);
    expect(show.code, describeRun(show)).toBe(0);
    expect(show.out).toMatch(/Revision: 2/);
    expect(show.out).toContain('agent-intro');
  });

  it('--json: stdout is exactly one JSON document describing the dry run (no ANSI)', async () => {
    mock.script(toolCalls(proposeTimeline(insertOp('agent-intro'))), text('Staged.'));

    const r = await env.run([
      'agent',
      'run',
      'add an intro clip',
      '--project',
      projectId,
      '--json',
      ...provider(),
    ]);

    expect(r.code, describeRun(r)).toBe(0);
    expect(hasAnsi(r.stdout)).toBe(false);
    const doc = r.json<{
      ok: boolean;
      dryRun: boolean;
      applied: boolean;
      revision: number;
      project: { id: string };
      operations: { timeline: Array<{ kind: string; id: string }> };
    }>();
    expect(doc).toMatchObject({ ok: true, dryRun: true, applied: false, revision: 1 });
    expect(doc.project.id).toBe(projectId);
    expect(doc.operations.timeline).toMatchObject([{ kind: 'insert', id: 'agent-intro' }]);
  });

  it('--json --apply reports the committed revision', async () => {
    mock.script(toolCalls(proposeTimeline(insertOp('agent-intro'))), text('Done.'));
    const r = await env.run([
      'agent',
      'run',
      'add an intro clip',
      '--project',
      projectId,
      '--apply',
      '--json',
      ...provider(),
    ]);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.json()).toMatchObject({ ok: true, applied: true, revision: 2 });
  });

  const failures: Array<[string, ChatReply, RegExp]> = [
    ['HTTP 401', httpError(401), /rejected the API key \(HTTP 401\)/],
    ['HTTP 429', httpError(429), /rate-limiting requests \(HTTP 429\)/],
    ['HTTP 500', httpError(500), /server error \(HTTP 500\)/],
    [
      'a 200 with a malformed JSON body',
      { kind: 'malformed', body: '{"choices": [ this is not json' },
      /could not use/,
    ],
    [
      'an HTML error page',
      { kind: 'malformed', body: '<html>502 Bad Gateway</html>', contentType: 'text/html' },
      /could not use/,
    ],
  ];
  for (const [label, reply, message] of failures) {
    it(`${label}: exits 1 with an actionable message and leaves the project untouched`, async () => {
      mock.fallback(reply);
      const r = await env.run([
        'agent',
        'run',
        'trim everything',
        '--project',
        projectId,
        '--apply',
        ...provider(),
      ]);
      expect(r.code, describeRun(r)).toBe(1);
      expect(r.err).toMatch(message);
      expect(r.all).not.toMatch(/at .*\.js:\d+/); // no stack trace
      expect(r.all).not.toContain(KEY);
      expect(project().revision).toBe(1);
      // maxRetries is 0: one failing call, no retry storm against a rate limit.
      expect(mock.chatRequests).toHaveLength(1);
    });
  }

  it('--json failure: stdout is a JSON error with the HTTP status', async () => {
    mock.fallback(httpError(429));
    const r = await env.run(['agent', 'run', 'x', '--project', projectId, '--json', ...provider()]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.json()).toMatchObject({ ok: false, error: { httpStatus: 429 } });
  });

  it('a model that only chats (no tool calls) proposes nothing and changes nothing', async () => {
    mock.script(text('I would love to help, but here is a poem instead.'));
    const r = await env.run([
      'agent',
      'run',
      'make it pop',
      '--project',
      projectId,
      '--apply',
      ...provider(),
    ]);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/proposed no changes/);
    expect(r.out).toMatch(/No changes to commit; project stays at revision 1/);
    expect(project().revision).toBe(1);
  });

  it('tool-call arguments that fail schema validation never reach the project', async () => {
    mock.script(
      toolCalls(proposeTimeline({ kind: 'insert', id: 'bad', trackId: 'track-v1', startUs: -5 })),
      toolCalls({ name: 'propose_timeline_operations', args: '{"operations": [ {not json' }),
      toolCalls({ name: 'delete_everything', args: {} }),
      text('Gave up.'),
    );
    const r = await env.run([
      'agent',
      'run',
      'break things',
      '--project',
      projectId,
      '--apply',
      ...provider(),
    ]);
    expect(r.code, describeRun(r)).toBe(0);
    expect(project().revision).toBe(1);
    expect(clipsOf(project())).toEqual([]);
    // The engine fed the validation errors back to the model instead of crashing.
    expect(mock.chatRequests.length).toBe(4);
  });

  it('a proposal that touches a missing clip is refused as a whole (no partial mutation)', async () => {
    const existing = await addClip(env.sb, projectId);
    mock.script(
      toolCalls(
        proposeTimeline(insertOp('agent-new'), {
          kind: 'remove',
          id: 'op-2',
          clipId: 'clip-that-does-not-exist',
          dependsOn: [],
        }),
      ),
      text('Done.'),
    );
    const r = await env.run([
      'agent',
      'run',
      'swap clips',
      '--project',
      projectId,
      '--apply',
      ...provider(),
    ]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.all).toMatch(/clip-that-does-not-exist/);
    expect(r.all).toMatch(/nothing was changed/i);
    expect(project().revision).toBe(2); // project create + add-clip only
    expect(clipsOf(project()).map((c) => c.id)).toEqual([existing]);
  });

  it('document operations the CLI cannot apply are refused, not reported as applied', async () => {
    mock.script(
      toolCalls({
        name: 'propose_document_operations',
        args: {
          operations: [{ kind: 'set-text', id: 'op-1', objectId: 'title-1', text: 'Hello' }],
        },
      }),
      text('Done.'),
    );
    const r = await env.run([
      'agent',
      'run',
      'retitle',
      '--project',
      projectId,
      '--apply',
      ...provider(),
    ]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.all).toMatch(/not supported by the CLI/);
    expect(r.all).not.toMatch(/Successfully applied/);
    expect(project().revision).toBe(1);
  });

  it('a project changed by another process mid-run is not overwritten', async () => {
    const release = deferred<ChatReply>();
    mock.script({ kind: 'deferred', reply: release.promise }, text('Done.'));
    const live = env.spawn([
      'agent',
      'run',
      'add an intro',
      '--project',
      projectId,
      '--apply',
      ...provider(),
    ]);
    await mock.waitForRequests(1, '/chat/completions');
    const humanClip = await addClip(env.sb, projectId); // someone edits meanwhile (rev 2)
    release.resolve(toolCalls(proposeTimeline(insertOp('agent-intro'))));
    const r = await live.done;

    expect(r.code, describeRun(r)).toBe(1);
    expect(r.err).toMatch(/changed \(now at revision 2\).*nothing was written/s);
    expect(project().revision).toBe(2);
    expect(clipsOf(project()).map((c) => c.id)).toEqual([humanClip]);
  });

  it('Persian, emoji and a very long instruction reach the model byte-for-byte', async () => {
    const instruction = `کلیپ اول را کوتاه کن 🎬✂️ — ${'افزودن زیرنویس '.repeat(2_000)}پایان 🚀`;
    mock.script(text('باشه 👍'));
    const r = await env.run(['agent', 'run', instruction, '--project', projectId, ...provider()]);
    expect(r.code, describeRun(r)).toBe(0);
    const messages = mock.chatRequests[0]?.json?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const user = messages.find((m) => m.role === 'user');
    const content =
      typeof user?.content === 'string'
        ? user.content
        : (user?.content as Array<{ text: string }>).map((p) => p.text).join('');
    expect(content).toBe(instruction);
    expect(r.out).toContain('باشه 👍');
  });

  it('usage error: no instruction exits 2 without touching the database', async () => {
    const r = await env.run(['agent', 'run', '--project', projectId, ...provider()]);
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/Usage: joy-media agent run/);
    expect(mock.requests).toHaveLength(0);
  });

  it('a missing --project id is a clear failure (exit 1), not a crash', async () => {
    const r = await env.run(['agent', 'run', 'x', '--project', 'proj-nope', ...provider()]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.err).toMatch(/Failed to load project "proj-nope"/);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('agent run: which project, and where it is saved', () => {
  let mock: MockLlmServer;
  let env: AgentSandbox;
  const provider = (): string[] => ['--url', mock.url, '--api-key', KEY];

  beforeAll(async () => {
    mock = await startMockLlm();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(() => {
    mock.reset();
    env = createAgentSandbox('agent-run-target');
  });
  afterEach(() => {
    expect(env.externalCalls()).toEqual([]);
    env.cleanup();
  });

  it('without --project it deterministically picks the most recently updated project', async () => {
    const older = await createProject(env.sb, 'Older');
    const newer = await createProject(env.sb, 'Newer');
    setProjectUpdatedAt(env.sb, older, '2000-01-01T00:00:00.000Z');
    setProjectUpdatedAt(env.sb, newer, '2000-01-02T00:00:00.000Z');
    await addClip(env.sb, older); // now "Older" is the most recently updated
    const updated = readProjects(env.sb);
    const olderUpdatedAt = updated.find((project) => project.id === older)!.payload.updatedAt;
    const newerUpdatedAt = updated.find((project) => project.id === newer)!.payload.updatedAt;
    expect(Date.parse(olderUpdatedAt)).toBeGreaterThan(Date.parse(newerUpdatedAt));
    mock.script(toolCalls(proposeTimeline(insertOp('agent-x'))), text('ok'));

    const r = await env.run(['agent', 'run', 'add a clip', '--apply', ...provider()]);

    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/most recently updated project: Older/);
    const olderRow = readProjects(env.sb).find((p) => p.id === older)!;
    expect(clipsOf(olderRow).map((c) => c.id)).toContain('agent-x');
  });

  it('with no projects, --apply saves a real "Default Project" (no stray file in cwd)', async () => {
    mock.script(toolCalls(proposeTimeline(insertOp('agent-first'))), text('ok'));

    const r = await env.run(['agent', 'run', 'start my video', '--apply', ...provider()]);

    expect(r.code, describeRun(r)).toBe(0);
    expect(readdirSync(env.sb.cwd)).toEqual([]); // used to create ./in-memory (a SQLite file)
    const rows = readProjects(env.sb);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.title).toBe('Default Project');
    expect(rows[0]!.revision).toBe(1);
    expect(clipsOf(rows[0]!).map((c) => c.id)).toEqual(['agent-first']);
  });

  it('with no projects, a dry run persists nothing at all', async () => {
    mock.script(toolCalls(proposeTimeline(insertOp('agent-first'))), text('ok'));
    const r = await env.run(['agent', 'run', 'start my video', ...provider()]);
    expect(r.code, describeRun(r)).toBe(0);
    expect(readdirSync(env.sb.cwd)).toEqual([]);
    expect(readProjects(env.sb)).toEqual([]);
  });

  it('honours --sqlite-path like the other project commands', async () => {
    const db = join(env.sb.cwd, 'elsewhere.sqlite3');
    const create = await env.run(['project', 'create', 'Elsewhere', '--sqlite-path', db]);
    expect(create.code, describeRun(create)).toBe(0);
    mock.script(toolCalls(proposeTimeline(insertOp('agent-y'))), text('ok'));

    const r = await env.run(['agent', 'run', 'add', '--apply', '--sqlite-path', db, ...provider()]);

    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/Elsewhere/);
    expect(readProjects(env.sb)).toEqual([]); // default DB untouched
  });

  it('--project <file.json> --apply writes the change back to that file', async () => {
    const id = await createProject(env.sb, 'As File');
    const file = join(env.sb.cwd, 'as-file.json');
    const exp = await env.run(['project', 'export', id, '--output', file]);
    expect(exp.code, describeRun(exp)).toBe(0);
    mock.script(toolCalls(proposeTimeline(insertOp('agent-file'))), text('ok'));

    const r = await env.run(['agent', 'run', 'add', '--project', file, '--apply', ...provider()]);

    expect(r.code, describeRun(r)).toBe(0);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      revision: number;
      project: { compositions: { root: { tracks: Array<{ clips: Array<{ id: string }> }> } } };
    };
    expect(saved.revision).toBe(2);
    expect(saved.project.compositions.root.tracks[0]!.clips.map((c) => c.id)).toEqual([
      'agent-file',
    ]);
  });

  it('a corrupted project file is reported, not crashed on', async () => {
    const file = join(env.sb.cwd, 'broken.json');
    writeFileSync(file, '{ "project": ');
    const r = await env.run(['agent', 'run', 'x', '--project', file, ...provider()]);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.err).toMatch(/Failed to load project/);
    expect(existsSync(file)).toBe(true);
  });
});
