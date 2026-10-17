/**
 * API keys: at rest (file modes), in transit (argv vs stdin) and in output
 * (never printed in full, on any path — success, failure, --json, debug).
 * All keys are fake; the only endpoint is the in-process mock.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgentSandbox,
  createProject,
  fakeKey,
  httpError,
  modeOf,
  probeToolCall,
  readJoyConfig,
  readTree,
  startMockLlm,
  text,
  toolCalls,
  writeJoyConfig,
  type AgentSandbox,
  type MockLlmServer,
} from './agent-helpers.js';
import { describeRun, type RunResult } from './harness.js';

const KEY = fakeKey('secret');
const BROAD_WINDOWS_SIDS = ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545'];

function windowsAclSids(path: string): string[] {
  const pathBase64 = Buffer.from(path, 'utf8').toString('base64');
  const script = [
    `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))`,
    '$acl = if ([IO.Directory]::Exists($path)) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }',
    '$entries = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })',
    'ConvertTo-Json -InputObject $entries -Compress',
  ].join('\n');
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  ).trim();
  const parsed = JSON.parse(output) as string | string[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function grantBroadRead(path: string, directory: boolean): void {
  execFileSync(
    'icacls.exe',
    [path, '/grant', directory ? '*S-1-5-32-545:(OI)(CI)R' : '*S-1-5-32-545:R'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  );
}

function expectPrivateWindowsAcl(path: string): void {
  const sids = windowsAclSids(path);
  for (const sid of BROAD_WINDOWS_SIDS) expect(sids, `${path} ACL`).not.toContain(sid);
  expect(sids, `${path} ACL`).toContain('S-1-5-18');
  expect(sids, `${path} ACL`).toContain('S-1-5-32-544');
  expect(sids, `${path} ACL`).toContain(
    execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    }).match(/S-1-[0-9-]+/)?.[0],
  );
}

describe('API keys at rest', () => {
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
    env = createAgentSandbox('agent-secrets-rest');
  });
  afterEach(() => {
    expect(env.externalCalls()).toEqual([]);
    env.cleanup();
  });

  it.skipIf(process.platform === 'win32')(
    'ai-providers.json is 0600 and ~/.joy-media is 0700 on a fresh install',
    async () => {
      const r = await env.run([
        'agent',
        'provider',
        'add',
        'p',
        '--url',
        mock.url,
        '--api-key',
        KEY,
      ]);
      expect(r.code, describeRun(r)).toBe(0);
      expect(modeOf(join(env.sb.joyDir, 'ai-providers.json')).toString(8)).toBe('600');
      expect(modeOf(env.sb.joyDir).toString(8)).toBe('700');
      const use = await env.run(['agent', 'provider', 'use', 'p']);
      expect(use.code).toBe(0);
      expect(modeOf(join(env.sb.joyDir, 'cli-config.json')).toString(8)).toBe('600');
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'Windows provider files inherit a private ACL for the current user, SYSTEM and Administrators',
    async () => {
      const r = await env.run([
        'agent',
        'provider',
        'add',
        'p',
        '--url',
        mock.url,
        '--api-key',
        KEY,
      ]);
      expect(r.code, describeRun(r)).toBe(0);
      expectPrivateWindowsAcl(env.sb.joyDir);
      expectPrivateWindowsAcl(join(env.sb.joyDir, 'ai-providers.json'));
      const use = await env.run(['agent', 'provider', 'use', 'p']);
      expect(use.code, describeRun(use)).toBe(0);
      expectPrivateWindowsAcl(join(env.sb.joyDir, 'cli-config.json'));
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'tightens broad Windows ACLs on an older key file and its directory',
    async () => {
      mkdirSync(env.sb.joyDir, { recursive: true });
      const path = writeJoyConfig(env.sb, 'ai-providers.json', {
        old: { name: 'old', provider: 'custom', baseUrl: mock.url, apiKey: KEY },
      });
      grantBroadRead(env.sb.joyDir, true);
      grantBroadRead(path, false);
      expect(windowsAclSids(env.sb.joyDir)).toContain('S-1-5-32-545');
      expect(windowsAclSids(path)).toContain('S-1-5-32-545');

      const r = await env.run(['agent', 'provider', 'list']);
      expect(r.code, describeRun(r)).toBe(0);
      expectPrivateWindowsAcl(env.sb.joyDir);
      expectPrivateWindowsAcl(path);
      expect(readJoyConfig(env.sb, 'ai-providers.json')).toMatchObject({ old: { apiKey: KEY } });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a world-readable key file left by an older version is tightened',
    async () => {
      mkdirSync(env.sb.joyDir, { recursive: true });
      chmodSync(env.sb.joyDir, 0o755);
      const path = writeJoyConfig(env.sb, 'ai-providers.json', {
        old: { name: 'old', provider: 'custom', baseUrl: mock.url, apiKey: KEY },
      });
      chmodSync(path, 0o644);

      const r = await env.run(['agent', 'provider', 'list']);
      expect(r.code, describeRun(r)).toBe(0);
      expect(modeOf(path).toString(8)).toBe('600');
      expect(modeOf(env.sb.joyDir).toString(8)).toBe('700');
      expect(readJoyConfig(env.sb, 'ai-providers.json')).toMatchObject({ old: { apiKey: KEY } });
    },
  );

  it('a key that only came from the environment is never written to disk', async () => {
    const envKey = fakeKey('from-env');
    const add = await env.run(['agent', 'provider', 'add', 'nokey', '--url', mock.url], {
      env: { OPENROUTER_API_KEY: envKey, KILO_API_KEY: envKey },
    });
    expect(add.code, describeRun(add)).toBe(0);
    await env.run(['agent', 'provider', 'use', 'nokey']);
    const projectId = await createProject(env.sb, 'Env');
    mock.script(text('ok'));
    const run = await env.run(
      ['agent', 'run', 'x', '--project', projectId, '--provider', 'openrouter', '--url', mock.url],
      { env: { OPENROUTER_API_KEY: envKey } },
    );
    expect(run.code, describeRun(run)).toBe(0);
    expect(mock.chatRequests[0]?.headers.authorization).toBe(`Bearer ${envKey}`);
    for (const file of readTree(env.sb.home)) {
      expect(file.content, file.path).not.toContain(envKey);
    }
  }, 30_000);
});

describe('API keys never appear in output', () => {
  let mock: MockLlmServer;
  let env: AgentSandbox;
  let projectId: string;
  const outputs: RunResult[] = [];
  const run = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = await env.run(args, { env: extraEnv });
    outputs.push(r);
    return r;
  };

  beforeAll(async () => {
    mock = await startMockLlm();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(async () => {
    mock.reset();
    outputs.length = 0;
    env = createAgentSandbox('agent-secrets-out');
    projectId = await createProject(env.sb, 'Secrets');
  });
  afterEach(() => {
    for (const r of outputs) {
      expect(r.stdout, describeRun(r)).not.toContain(KEY);
      expect(r.stderr, describeRun(r)).not.toContain(KEY);
      // Not even a long fragment of it.
      expect(r.all, describeRun(r)).not.toContain(KEY.slice(0, 16));
    }
    expect(env.externalCalls()).toEqual([]);
    env.cleanup();
  });

  it('on every success path (human, --json, JOY_CLI_DEBUG)', async () => {
    const debug = { JOY_CLI_DEBUG: '1' };
    expect(
      (await run(['agent', 'provider', 'add', 'p', '--url', mock.url, '--api-key', KEY])).code,
    ).toBe(0);
    expect((await run(['agent', 'provider', 'use', 'p'])).code).toBe(0);
    for (const args of [
      ['agent', 'provider', 'list'],
      ['agent', 'provider', 'list', '--json'],
      ['agent', 'config'],
      ['agent', 'config', '--json'],
      ['agent', 'model'],
      ['agent', 'models'],
    ]) {
      const r = await run(args, debug);
      expect(r.code, describeRun(r)).toBe(0);
    }
    const list = outputs.find((r) => r.args.includes('list') && r.args.includes('--json'))!;
    expect(list.json()).toMatchObject({ providers: [{ apiKey: `****${KEY.slice(-4)}` }] });

    mock.script(toolCalls(probeToolCall));
    expect((await run(['agent', 'probe'], debug)).code).toBe(0);
    mock.script(text('done'));
    expect((await run(['agent', 'run', 'x', '--project', projectId], debug)).code).toBe(0);
    mock.script(text('done'));
    const chat = await env.run(['agent', 'chat', '--project', projectId], {
      env: debug,
      input: 'hello\n/exit\n',
    });
    outputs.push(chat);
    expect(chat.code, describeRun(chat)).toBe(0);
  });

  it('on every failure path (401, 500, malformed, debug mode)', async () => {
    const debug = { JOY_CLI_DEBUG: '1' };
    const provider = ['--url', mock.url, '--api-key', KEY];
    for (const reply of [
      httpError(401, { error: { message: `bad key ${KEY}` } }),
      httpError(500),
    ]) {
      mock.fallback(reply);
      const r = await run(['agent', 'run', 'x', '--project', projectId, ...provider], debug);
      expect(r.code, describeRun(r)).toBe(1);
      const probe = await run(['agent', 'probe', ...provider], debug);
      expect(probe.code, describeRun(probe)).toBe(1);
    }
    mock.fallback({ kind: 'malformed', body: `{"echo": "${KEY}"` });
    const malformed = await run(['agent', 'run', 'x', '--project', projectId, ...provider], debug);
    expect(malformed.code).toBe(1);
    mock.models({ kind: 'http-error', status: 401, body: { error: `invalid key ${KEY}` } });
    const discovery = await run(['agent', 'provider', 'add', 'q', ...provider], debug);
    expect(discovery.code).toBe(0);
  });

  it('a short key is fully masked in `provider list` (no first-4/last-4 reveal)', async () => {
    const short = 'sk-short';
    await run(['agent', 'provider', 'add', 's', '--url', mock.url, '--api-key', short]);
    const list = await run(['agent', 'provider', 'list']);
    expect(list.out).toMatch(/API Key: \*\*\*\*\n/);
    expect(list.all).not.toContain(short);
    // The old mask printed `${key.slice(0, 4)}...${key.slice(-4)}`, i.e. the whole key.
    expect(list.all).not.toContain('sk-s...hort');
  });

  it('a URL carrying credentials or a query secret is refused without echoing it', async () => {
    for (const url of [
      `http://user:${KEY}@127.0.0.1:9/v1`,
      `${mock.url}?api_key=${KEY}`,
      `https://example.com/v1#${KEY}`,
    ]) {
      const r = await run(['agent', 'provider', 'add', 'leaky', '--url', url]);
      expect(r.code, describeRun(r)).toBe(2);
    }
    const r = await run([
      'agent',
      'run',
      'x',
      '--project',
      projectId,
      '--url',
      `${mock.url}?k=${KEY}`,
    ]);
    expect(r.code, describeRun(r)).toBe(2);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('--api-key - reads the key from stdin (keeps it out of argv / ps)', () => {
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
    env = createAgentSandbox('agent-secrets-stdin');
  });
  afterEach(() => {
    expect(env.externalCalls()).toEqual([]);
    env.cleanup();
  });

  it('provider add and agent run accept the key on stdin', async () => {
    const add = await env.run(
      ['agent', 'provider', 'add', 'p', '--url', mock.url, '--api-key', '-'],
      {
        input: `${KEY}\n`,
      },
    );
    expect(add.code, describeRun(add)).toBe(0);
    expect(
      readJoyConfig<Record<string, { apiKey: string }>>(env.sb, 'ai-providers.json').p?.apiKey,
    ).toBe(KEY);
    expect(mock.modelRequests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);

    const projectId = await createProject(env.sb, 'Stdin');
    const other = fakeKey('other');
    mock.script(text('ok'));
    const r = await env.run(
      ['agent', 'run', 'x', '--project', projectId, '--url', mock.url, '--api-key', '-'],
      { input: other },
    );
    expect(r.code, describeRun(r)).toBe(0);
    expect(mock.chatRequests[0]?.headers.authorization).toBe(`Bearer ${other}`);
    expect(r.all).not.toContain(other);
  });

  it('an empty stdin is a usage error (exit 2), and chat refuses it', async () => {
    const r = await env.run(
      ['agent', 'provider', 'add', 'p', '--url', mock.url, '--api-key', '-'],
      {
        input: '\n',
      },
    );
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/stdin did not contain a key/);
    const chat = await env.run(['agent', 'chat', '--api-key', '-'], { input: 'k\n' });
    expect(chat.code, describeRun(chat)).toBe(2);
  });
});
