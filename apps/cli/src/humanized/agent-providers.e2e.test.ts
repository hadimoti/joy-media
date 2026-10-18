/**
 * Provider lifecycle (`agent provider add|list|use|remove`, `agent model`,
 * `agent config`) through the real binary. The provider file holds every API
 * key the user owns, so the bar is: never lose it, never corrupt it, never
 * hang on a slow endpoint, and keep exit codes honest.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgentSandbox,
  fakeKey,
  readJoyConfig,
  startMockLlm,
  writeJoyConfig,
  type AgentSandbox,
  type MockLlmServer,
} from './agent-helpers.js';
import { describeRun, hasAnsi } from './harness.js';

const KEY = fakeKey('providers');

interface StoredProvider {
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  cachedModels?: string[];
}
type ProviderFile = Record<string, StoredProvider>;

describe('agent provider add: model discovery against the endpoint', () => {
  let mock: MockLlmServer;
  let env: AgentSandbox;
  const add = (name: string, ...extra: string[]) =>
    env.run(['agent', 'provider', 'add', name, '--url', mock.url, '--api-key', KEY, ...extra]);
  const stored = (name: string): StoredProvider =>
    readJoyConfig<ProviderFile>(env.sb, 'ai-providers.json')[name]!;

  beforeAll(async () => {
    mock = await startMockLlm();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(() => {
    mock.reset();
    env = createAgentSandbox('agent-discovery');
  });
  afterEach(() => {
    expect(env.externalCalls()).toEqual([]);
    env.cleanup();
  });

  it('caches the OpenAI-style {data:[{id}]} list and defaults to its first model', async () => {
    mock.models({ kind: 'list', ids: ['mock/alpha', 'mock/beta'] });
    const r = await add('local');
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/Discovered 2 models/);
    expect(stored('local')).toMatchObject({
      baseUrl: mock.url,
      defaultModel: 'mock/alpha',
      cachedModels: ['mock/alpha', 'mock/beta'],
    });
    expect(mock.modelRequests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  }, 60_000);

  it('accepts a bare JSON array too', async () => {
    mock.models({ kind: 'bare-array', ids: ['m1'] });
    const r = await add('bare');
    expect(r.code, describeRun(r)).toBe(0);
    expect(stored('bare').cachedModels).toEqual(['m1']);
  });

  it('--model wins over the discovered default', async () => {
    const r = await add('pinned', '--model', 'mock/beta');
    expect(r.code, describeRun(r)).toBe(0);
    expect(stored('pinned').defaultModel).toBe('mock/beta');
  });

  for (const [label, reply, warning] of [
    ['HTTP 401', { kind: 'http-error', status: 401 }, /rejected the API key \(HTTP 401\)/],
    ['an HTML login page', { kind: 'html' }, /not JSON/],
    ['HTTP 500', { kind: 'http-error', status: 500 }, /HTTP 500/],
  ] as const) {
    it(`${label} from /models: warns, still saves the provider, exits 0`, async () => {
      mock.models(reply);
      const r = await add('flaky');
      expect(r.code, describeRun(r)).toBe(0);
      expect(r.out).toMatch(warning);
      expect(stored('flaky').apiKey).toBe(KEY);
      expect(stored('flaky').cachedModels).toBeUndefined();
    });
  }

  it('a /models endpoint that never answers does not hang the CLI', async () => {
    mock.models({ kind: 'hang' });
    const r = await add('slow');
    expect(r.timedOut, describeRun(r)).toBe(false);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/no answer within 10s/);
    expect(stored('slow').baseUrl).toBe(mock.url);
  }, 60_000);

  it('a huge model list is bounded before it bloats the key file', async () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `vendor/model-${i}`);
    mock.models({ kind: 'list', ids });
    const r = await add('huge');
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/Discovered 20000 models/);
    expect(stored('huge').cachedModels).toHaveLength(5_000);
  });

  it('does not follow a redirect with the API key to another origin', async () => {
    const elsewhere = await startMockLlm();
    try {
      mock.models({ kind: 'redirect', location: `${elsewhere.url}/models` });
      const r = await add('redirecting');
      expect(r.code, describeRun(r)).toBe(0);
      expect(r.out).toMatch(/redirected/);
      expect(elsewhere.requests).toHaveLength(0);
    } finally {
      await elsewhere.close();
    }
  });
});

describe('agent provider lifecycle', () => {
  let mock: MockLlmServer;
  let env: AgentSandbox;
  const add = (name: string, ...extra: string[]) =>
    env.run(['agent', 'provider', 'add', name, '--url', mock.url, '--api-key', KEY, ...extra]);
  const providerFile = (): ProviderFile => readJoyConfig<ProviderFile>(env.sb, 'ai-providers.json');

  beforeAll(async () => {
    mock = await startMockLlm();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(() => {
    mock.reset();
    env = createAgentSandbox('agent-lifecycle');
  });
  afterEach(() => {
    expect(env.externalCalls()).toEqual([]);
    env.cleanup();
  });

  it('add -> list -> use -> remove the active provider: what is active afterwards is stated', async () => {
    expect((await add('studio')).code).toBe(0);

    const list = await env.run(['agent', 'provider', 'list']);
    expect(list.code, describeRun(list)).toBe(0);
    expect(list.out).toMatch(/studio \(custom\)/);
    expect(hasAnsi(list.stdout)).toBe(false);

    const use = await env.run(['agent', 'provider', 'use', 'studio']);
    expect(use.code, describeRun(use)).toBe(0);
    expect(readJoyConfig(env.sb, 'cli-config.json')).toMatchObject({
      activeProvider: 'studio',
      defaultModel: 'mock/model-a',
    });

    const rm = await env.run(['agent', 'provider', 'remove', 'studio']);
    expect(rm.code, describeRun(rm)).toBe(0);
    expect(rm.out).toMatch(/was the active provider/);
    // The removed provider's model must not linger as the global default.
    expect(readJoyConfig(env.sb, 'cli-config.json')).toEqual({});

    const cfg = await env.run(['agent', 'config', '--json']);
    expect(cfg.code, describeRun(cfg)).toBe(0);
    expect(cfg.json()).toMatchObject({
      activeProvider: null,
      effective: { provider: 'openrouter', model: 'openrouter/auto', apiKey: null },
    });
  });

  it('--json works for list / add / use / remove and stdout is only JSON', async () => {
    const added = await add('j1', '--json');
    expect(added.code, describeRun(added)).toBe(0);
    expect(added.json()).toMatchObject({ ok: true, provider: { name: 'j1', baseUrl: mock.url } });

    const use = await env.run(['agent', 'provider', 'use', 'j1', '--json']);
    expect(use.json()).toMatchObject({ ok: true, activeProvider: 'j1' });

    const list = await env.run(['agent', 'provider', 'list', '--json']);
    expect(list.code, describeRun(list)).toBe(0);
    const doc = list.json<{ activeProvider: string; providers: Array<Record<string, unknown>> }>();
    expect(doc.activeProvider).toBe('j1');
    expect(doc.providers).toEqual([
      expect.objectContaining({ name: 'j1', active: true, cachedModelCount: 2 }),
    ]);

    const rm = await env.run(['agent', 'provider', 'rm', 'j1', '--json']);
    expect(rm.json()).toMatchObject({ ok: true, removed: 'j1', wasActive: true });
  });

  it('re-adding an existing name says it replaced it (one entry, new values)', async () => {
    await add('dup', '--model', 'first');
    const again = await add('dup', '--model', 'second');
    expect(again.code, describeRun(again)).toBe(0);
    expect(again.out).toMatch(/already existed and was replaced/);
    expect(Object.keys(providerFile())).toEqual(['dup']);
    expect(providerFile().dup?.defaultModel).toBe('second');
  });

  it('switching providers does not carry the previous provider model along', async () => {
    await add('a', '--model', 'model-of-a');
    writeJoyConfig(env.sb, 'ai-providers.json', {
      ...providerFile(),
      b: { name: 'b', provider: 'custom', baseUrl: mock.url, apiKey: KEY },
    });
    await env.run(['agent', 'provider', 'use', 'a']);
    await env.run(['agent', 'provider', 'use', 'b']);
    const cfg = await env.run(['agent', 'config', '--json']);
    expect(cfg.json()).toMatchObject({ activeProvider: 'b', defaultModel: null });
  });

  it('rejects names that are not identifiers (exit 2) and handles Object.prototype names', async () => {
    for (const bad of ['__proto__', '../escape', 'two words']) {
      const r = await add(bad);
      expect(r.code, `${bad}: ${describeRun(r)}`).toBe(2);
      expect(r.err).toMatch(/Invalid provider name/);
    }
    // Inherited Object.prototype members are not providers.
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      const use = await env.run(['agent', 'provider', 'use', name]);
      expect(use.code, `use ${name}: ${describeRun(use)}`).toBe(1);
      const rm = await env.run(['agent', 'provider', 'remove', name]);
      expect(rm.code, `remove ${name}: ${describeRun(rm)}`).toBe(1);
    }
    // ...but a provider may legitimately be called "constructor".
    expect((await add('constructor')).code).toBe(0);
    expect(Object.keys(providerFile())).toEqual(['constructor']);
    expect((await env.run(['agent', 'provider', 'use', 'constructor'])).code).toBe(0);
  });

  it('unknown provider for use / remove exits 1 and changes nothing', async () => {
    await add('keep');
    const before = readFileSync(join(env.sb.joyDir, 'ai-providers.json'), 'utf8');
    for (const action of ['use', 'remove']) {
      const r = await env.run(['agent', 'provider', action, 'ghost']);
      expect(r.code, describeRun(r)).toBe(1);
      expect(r.err).toMatch(/ghost/);
    }
    expect(readFileSync(join(env.sb.joyDir, 'ai-providers.json'), 'utf8')).toBe(before);
  });

  it('usage errors exit 2: missing name, missing --url, malformed --url, unknown action -> 1', async () => {
    const noName = await env.run(['agent', 'provider', 'add']);
    expect(noName.code, describeRun(noName)).toBe(2);
    const noUrl = await env.run(['agent', 'provider', 'add', 'x']);
    expect(noUrl.code, describeRun(noUrl)).toBe(2);
    expect(noUrl.err).toMatch(/--url/);
    for (const url of ['not a url', 'ftp://example.com/v1', `${mock.url}/chat/completions`]) {
      const r = await env.run(['agent', 'provider', 'add', 'x', '--url', url]);
      expect(r.code, `${url}: ${describeRun(r)}`).toBe(2);
    }
    const unknown = await env.run(['agent', 'provider', 'frobnicate']);
    expect(unknown.code, describeRun(unknown)).toBe(1);
    expect(mock.requests).toHaveLength(0);
  });

  it('agent model set / get and agent config --json report the effective settings', async () => {
    await add('main');
    await env.run(['agent', 'provider', 'use', 'main']);
    const set = await env.run(['agent', 'model', 'set', 'mock/custom-model']);
    expect(set.code, describeRun(set)).toBe(0);

    const get = await env.run(['agent', 'model', '--json']);
    expect(get.json()).toEqual({
      defaultModel: 'mock/custom-model',
      effectiveModel: 'mock/custom-model',
    });

    const cfg = await env.run(['agent', 'config', '--json']);
    expect(cfg.code, describeRun(cfg)).toBe(0);
    expect(cfg.json()).toMatchObject({
      activeProvider: 'main',
      effective: {
        provider: 'main',
        baseUrl: mock.url,
        model: 'mock/custom-model',
        apiKeySource: 'provider:main',
        local: true,
      },
    });
    const noModel = await env.run(['agent', 'model', 'set']);
    expect(noModel.code, describeRun(noModel)).toBe(2);
  });
});

describe('config files are never silently destroyed', () => {
  let mock: MockLlmServer;
  let env: AgentSandbox;

  beforeAll(async () => {
    mock = await startMockLlm();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(() => {
    mock.reset();
    env = createAgentSandbox('agent-corrupt');
  });
  afterEach(() => {
    expect(env.externalCalls()).toEqual([]);
    env.cleanup();
  });

  for (const [label, content] of [
    ['truncated JSON', `{"work": {"apiKey": "${KEY}", "baseUrl": "https://api.example.com/v1"`],
    ['a JSON array', '["not", "a", "map"]'],
  ] as const) {
    it(`ai-providers.json with ${label}: add/list/remove refuse (exit 1), file kept byte-for-byte`, async () => {
      const path = writeJoyConfig(env.sb, 'ai-providers.json', content);
      for (const args of [
        ['agent', 'provider', 'add', 'new', '--url', mock.url, '--api-key', fakeKey('new')],
        ['agent', 'provider', 'list'],
        ['agent', 'provider', 'remove', 'work'],
        ['agent', 'run', 'hello', '--url', mock.url],
      ]) {
        const r = await env.run(args);
        expect(r.code, describeRun(r)).toBe(1);
        expect(r.err).toMatch(/ai-providers\.json is not (valid JSON|a JSON object)/);
        expect(r.all).not.toContain(KEY); // JSON.parse errors quote the source text
        expect(readFileSync(path, 'utf8')).toBe(content);
      }
      expect(mock.chatRequests).toHaveLength(0);
    });
  }

  it('corrupt cli-config.json: agent writes refuse, project commands keep working', async () => {
    const path = writeJoyConfig(env.sb, 'cli-config.json', '{"activeProvider": ');
    const use = await env.run(['agent', 'model', 'set', 'x/y']);
    expect(use.code, describeRun(use)).toBe(1);
    expect(use.err).toMatch(/cli-config\.json is not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{"activeProvider": ');
    const projects = await env.run(['project', 'list']);
    expect(projects.code, describeRun(projects)).toBe(0);
  });

  it('concurrent `provider add` from many processes loses no provider', async () => {
    const count = 8;
    // Every process blocks in discovery until all of them are there, then all
    // proceed to write at the same moment: the classic lost-update window.
    mock.models({ kind: 'barrier', count, ids: ['m'] });
    const runs = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        env.run([
          'agent',
          'provider',
          'add',
          `p${i}`,
          '--url',
          mock.url,
          '--api-key',
          fakeKey(`p${i}`),
        ]),
      ),
    );
    for (const r of runs) expect(r.code, describeRun(r)).toBe(0);
    const names = Object.keys(readJoyConfig<ProviderFile>(env.sb, 'ai-providers.json')).sort();
    expect(names).toEqual(Array.from({ length: count }, (_, i) => `p${i}`).sort());
    expect(statSync(join(env.sb.joyDir, 'ai-providers.json')).size).toBeGreaterThan(0);
  });
});
