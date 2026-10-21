/**
 * `joy-media agent chat` driven through a pipe, the way an AI agent (or a
 * shell script) uses a REPL: write lines, close stdin, read the transcript.
 * It must process every line, never require a TTY, and exit on EOF.
 */
import { readdirSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clipsOf,
  createAgentSandbox,
  createProject,
  fakeKey,
  httpError,
  proposeTimeline,
  readProjects,
  startMockLlm,
  text,
  toolCalls,
  type AgentSandbox,
  type MockLlmServer,
} from './agent-helpers.js';
import { describeRun, hasAnsi } from './harness.js';

const KEY = fakeKey('chat');
const insert = (id: string) => ({
  kind: 'insert',
  id,
  assetId: 'asset-1',
  trackId: 'track-v1',
  startUs: 0,
  durationUs: 2_000_000,
  dependsOn: [],
});

describe('agent chat with piped stdin (real binary)', () => {
  let mock: MockLlmServer;
  let env: AgentSandbox;
  let projectId: string;
  const chat = (input: string, extra: string[] = []) =>
    env.run(
      ['agent', 'chat', '--project', projectId, '--url', mock.url, '--api-key', KEY, ...extra],
      { input },
    );
  const project = () => readProjects(env.sb).find((p) => p.id === projectId)!;

  beforeAll(async () => {
    mock = await startMockLlm();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(async () => {
    mock.reset();
    env = createAgentSandbox('agent-chat');
    projectId = await createProject(env.sb, 'Chat Target');
  });
  afterEach(() => {
    expect(env.externalCalls()).toEqual([]);
    env.cleanup();
  });

  it('processes every piped line, not just the first', async () => {
    const r = await chat('/help\n/project\n/timeline\n/exit\n');
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/Interactive Joy Agent Commands/); // /help
    expect(r.out).toMatch(/Title: Chat Target \| Rev: 1/); // /project
    expect(r.out).toMatch(/Timeline: 3 track\(s\), 0 clip\(s\)/); // /timeline
    expect(r.out).toMatch(/Goodbye!/); // /exit
    expect(hasAnsi(r.stdout)).toBe(false);
  });

  it('exits 0 on EOF without an explicit /exit (never hangs)', async () => {
    const r = await chat('/project\n/timeline');
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/Title: Chat Target/);
    expect(r.out).toMatch(/Timeline:/);
    expect(r.out).toMatch(/Goodbye!/);
  });

  it('exits 0 immediately on an empty stdin', async () => {
    const r = await chat('');
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/Goodbye!/);
    expect(mock.requests).toHaveLength(0);
  });

  it('applies exactly the proposal that was approved (no second model call)', async () => {
    mock.script(
      toolCalls(proposeTimeline(insert('approved-clip'))),
      text('Proposed one clip.'),
      // If the REPL re-ran the model after "y" it would get this instead:
      toolCalls(proposeTimeline(insert('surprise-clip'))),
      text('Surprise!'),
    );
    const r = await chat('add a clip please\ny\n/exit\n');

    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/insert clip approved-clip/);
    expect(r.out).toMatch(/Saved updated project revision 2/);
    expect(mock.chatRequests).toHaveLength(2);
    expect(project().revision).toBe(2);
    expect(clipsOf(project()).map((c) => c.id)).toEqual(['approved-clip']);
  });

  it('"n" (or EOF at the confirmation) discards the proposal', async () => {
    mock.fallback(text('ok'));
    mock.script(toolCalls(proposeTimeline(insert('c1'))), text('Proposed.'));
    const no = await chat('add a clip\nn\n');
    expect(no.code, describeRun(no)).toBe(0);
    expect(no.out).toMatch(/Changes discarded/);

    mock.script(toolCalls(proposeTimeline(insert('c2'))), text('Proposed.'));
    const eof = await chat('add a clip\n');
    expect(eof.code, describeRun(eof)).toBe(0);
    expect(eof.out).toMatch(/Changes discarded/);

    expect(project().revision).toBe(1);
  });

  it('a provider error is reported and the session carries on with the next line', async () => {
    mock.fallback(httpError(401));
    const r = await chat('do something\n/project\n');
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/rejected the API key \(HTTP 401\)/);
    expect(r.out).toMatch(/Title: Chat Target/);
    expect(r.all).not.toContain(KEY);
  });

  it('--json is refused with a usage error (exit 2): a REPL has no JSON form', async () => {
    const r = await chat('/exit\n', ['--json']);
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.stdout).toMatch(/^\{/);
    expect(r.json()).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });
});

describe('agent chat without a configured provider or project', () => {
  let env: AgentSandbox;
  beforeEach(() => {
    env = createAgentSandbox('agent-chat-bare');
  });
  afterEach(() => {
    expect(env.externalCalls()).toEqual([]);
    env.cleanup();
  });

  it('warns about the missing key up front, keeps slash commands working', async () => {
    const r = await env.run(['agent', 'chat'], {
      input: '/project\nsplit the first clip\n/exit\n',
    });
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/No API key configured for provider "openrouter"/);
    expect(r.out).toMatch(/Title: Default Project/);
  });

  it('/save on the scratch project writes the real database, not ./in-memory', async () => {
    const r = await env.run(['agent', 'chat'], { input: '/save\n' });
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/Project saved at revision 1/);
    expect(readdirSync(env.sb.cwd)).toEqual([]);
    expect(readProjects(env.sb).map((p) => p.payload.title)).toEqual(['Default Project']);
  });
});
