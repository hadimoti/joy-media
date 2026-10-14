/**
 * A provider that never answers must not wedge an AI caller: the run has to
 * be interruptible (SIGINT -> exit 130) and bounded (timeout -> exit 1), and
 * neither may leave a half-written project behind.
 */
import process from 'node:process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgentSandbox,
  createProject,
  fakeKey,
  readProjects,
  startMockLlm,
  type AgentSandbox,
  type MockLlmServer,
} from './agent-helpers.js';
import { describeRun } from './harness.js';

const KEY = fakeKey('resilience');

describe('agent run against a provider that stalls (real binary)', () => {
  let mock: MockLlmServer;
  let env: AgentSandbox;
  let projectId: string;
  const args = (): string[] => [
    'agent',
    'run',
    'add an intro',
    '--project',
    projectId,
    '--apply',
    '--url',
    mock.url,
    '--api-key',
    KEY,
  ];

  beforeAll(async () => {
    mock = await startMockLlm();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(async () => {
    mock.reset();
    env = createAgentSandbox('agent-stall');
    projectId = await createProject(env.sb, 'Stall Target');
  });
  afterEach(() => {
    expect(env.externalCalls()).toEqual([]);
    env.cleanup();
  });

  it.skipIf(process.platform === 'win32')(
    'SIGINT while waiting on a hung connection exits 130 and changes nothing',
    async () => {
      mock.fallback({ kind: 'hang' });
      const live = env.spawn(args());
      await mock.waitForRequests(1, '/chat/completions'); // the run is now blocked on the provider
      live.child.kill('SIGINT');
      const r = await live.done;

      expect(r.signal, describeRun(r)).toBeNull(); // handled, not killed
      expect(r.code, describeRun(r)).toBe(130);
      expect(r.err).toMatch(/Received SIGINT/);
      expect(readProjects(env.sb)[0]!.revision).toBe(1);
    },
  );

  it.skipIf(process.platform === 'win32')('SIGTERM is handled the same way', async () => {
    mock.fallback({ kind: 'stall-stream', chunks: ['Thinking'] });
    const live = env.spawn(args());
    await mock.waitForRequests(1, '/chat/completions');
    live.child.kill('SIGTERM');
    const r = await live.done;
    expect(r.code, describeRun(r)).toBe(130);
    expect(readProjects(env.sb)[0]!.revision).toBe(1);
  });

  for (const [label, reply] of [
    ['a hung connection', { kind: 'hang' }],
    ['a response stream that stalls half-way', { kind: 'stall-stream', chunks: ['Work', 'ing'] }],
  ] as const) {
    it(`${label} times out (JOY_AGENT_TIMEOUT_MS) with exit 1 and no mutation`, async () => {
      mock.fallback(reply);
      const r = await env.run(args(), { env: { JOY_AGENT_TIMEOUT_MS: '2000' } });
      expect(r.timedOut, describeRun(r)).toBe(false);
      expect(r.code, describeRun(r)).toBe(1);
      expect(r.err).toMatch(/within 2s; gave up/);
      expect(readProjects(env.sb)[0]!.revision).toBe(1);
    });
  }

  it('--json timeout reports a JOY_AGENT_TIMEOUT error document', async () => {
    mock.fallback({ kind: 'hang' });
    const r = await env.run([...args(), '--json'], { env: { JOY_AGENT_TIMEOUT_MS: '1500' } });
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.json()).toMatchObject({ ok: false, error: { code: 'JOY_AGENT_TIMEOUT' } });
  });
});
