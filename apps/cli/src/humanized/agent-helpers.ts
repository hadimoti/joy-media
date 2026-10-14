/* global process, setTimeout, clearTimeout, Buffer */
/**
 * Fixtures for the `agent` command family's black-box tests.
 *
 * The centrepiece is a hermetic, scriptable OpenAI-compatible server that runs
 * inside the test process on 127.0.0.1 (ephemeral port). The CLI child talks to
 * it via `--url <mock.url>`; nothing ever reaches a real model provider and no
 * real API key is used. Every request is recorded (method, path, headers incl.
 * Authorization, raw body) so tests can assert exactly what the CLI sent.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  CLI_ROOT,
  createSandbox,
  ensureCliBuilt,
  stripAnsi,
  type RunOptions,
  type RunResult,
  type Sandbox,
} from './harness.js';

// ---------------------------------------------------------------------------
// Scripted replies
// ---------------------------------------------------------------------------

export interface MockToolCall {
  readonly name: string;
  /** Object → JSON-encoded; string → sent verbatim (use for malformed JSON args). */
  readonly args: unknown;
  readonly id?: string;
}

/** What the mock answers to one `POST /v1/chat/completions`. */
export type ChatReply =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool-calls'; readonly calls: readonly MockToolCall[] }
  | {
      readonly kind: 'http-error';
      readonly status: number;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  /** 200 with a body that is not valid OpenAI JSON (or not JSON at all). */
  | { readonly kind: 'malformed'; readonly body: string; readonly contentType?: string }
  /** Accept the request and never answer (until the server closes). */
  | { readonly kind: 'hang' }
  /** SSE: send `chunks` text deltas `intervalMs` apart, then finish normally. */
  | {
      readonly kind: 'slow-stream';
      readonly chunks: readonly string[];
      readonly intervalMs: number;
    }
  /** SSE: send `chunks` text deltas and then stall forever (no finish, no [DONE]). */
  | { readonly kind: 'stall-stream'; readonly chunks: readonly string[] }
  /** Answer with whatever `reply` resolves to, whenever the test resolves it. */
  | { readonly kind: 'deferred'; readonly reply: Promise<ChatReply> };

/** What the mock answers to `GET /v1/models`. */
export type ModelsReply =
  | { readonly kind: 'list'; readonly ids: readonly string[] }
  | { readonly kind: 'bare-array'; readonly ids: readonly string[] }
  | { readonly kind: 'http-error'; readonly status: number; readonly body?: unknown }
  | { readonly kind: 'html' }
  | { readonly kind: 'hang' }
  | { readonly kind: 'redirect'; readonly location: string }
  /**
   * Hold every `/models` response until `count` requests have arrived, then
   * answer them all at once (forces concurrent CLI processes into lock-step).
   */
  | { readonly kind: 'barrier'; readonly count: number; readonly ids: readonly string[] };

export const text = (value: string): ChatReply => ({ kind: 'text', text: value });
export const toolCalls = (...calls: MockToolCall[]): ChatReply => ({ kind: 'tool-calls', calls });
export const httpError = (status: number, body?: unknown): ChatReply => ({
  kind: 'http-error',
  status,
  ...(body === undefined ? {} : { body }),
});

/** A promise the test resolves by hand (event-driven sequencing, no sleeps). */
export function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A tool call that stages one timeline operation through the engine's real tool. */
export function proposeTimeline(...operations: readonly Record<string, unknown>[]): MockToolCall {
  return { name: 'propose_timeline_operations', args: { operations } };
}

/** The tool call the engine's capability probe asks for. */
export const probeToolCall: MockToolCall = { name: 'joy_probe', args: { value: 'JOY_PROBE' } };

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** Parsed JSON body, or `undefined` when the body is empty / not JSON. */
  readonly json: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

export class MockLlmServer {
  readonly requests: RecordedRequest[] = [];
  private server: Server | undefined;
  private port = 0;
  private readonly sockets = new Set<Socket>();
  private readonly chatQueue: ChatReply[] = [];
  private chatFallback: ChatReply = text('OK from mock.');
  private modelsReply: ModelsReply = { kind: 'list', ids: ['mock/model-a', 'mock/model-b'] };
  private readonly heldModels: ServerResponse[] = [];
  private readonly waiters: Array<() => void> = [];
  private callCounter = 0;

  /** Base URL to pass as `--url` (`http://127.0.0.1:<port>/v1`). */
  get url(): string {
    return `${this.origin}/v1`;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get chatRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.endsWith('/chat/completions'));
  }

  get modelRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.endsWith('/models'));
  }

  async start(): Promise<this> {
    const server = createServer((req, res) => void this.handle(req, res));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this;
  }

  /** Queue replies for the next chat-completion calls (FIFO). */
  script(...replies: ChatReply[]): this {
    this.chatQueue.push(...replies);
    return this;
  }

  /** Reply used once the scripted queue is empty. */
  fallback(reply: ChatReply): this {
    this.chatFallback = reply;
    return this;
  }

  models(reply: ModelsReply): this {
    this.modelsReply = reply;
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.chatQueue.length = 0;
    this.chatFallback = text('OK from mock.');
    this.modelsReply = { kind: 'list', ids: ['mock/model-a', 'mock/model-b'] };
    this.heldModels.length = 0;
  }

  /** Resolves once at least `count` requests (optionally matching `path`) were received. */
  waitForRequests(count: number, pathSuffix?: string): Promise<void> {
    const satisfied = (): boolean =>
      this.requests.filter((r) => pathSuffix === undefined || r.path.endsWith(pathSuffix)).length >=
      count;
    if (satisfied()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (satisfied()) resolve();
        else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private notify(): void {
    const pending = this.waiters.splice(0);
    for (const waiter of pending) waiter();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    let json: Record<string, unknown> | undefined;
    try {
      json = body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    } catch {
      json = undefined;
    }
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    this.requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body, json });

    try {
      if (req.method === 'GET' && path.endsWith('/models')) {
        this.answerModels(res);
      } else if (req.method === 'POST' && path.endsWith('/chat/completions')) {
        const reply = this.chatQueue.shift() ?? this.chatFallback;
        this.answerChat(res, reply, json);
      } else {
        sendJson(res, 404, { error: { message: `mock: no route for ${req.method} ${path}` } });
      }
    } finally {
      this.notify();
    }
  }

  private answerModels(res: ServerResponse): void {
    const reply = this.modelsReply;
    switch (reply.kind) {
      case 'list':
        sendJson(res, 200, { object: 'list', data: reply.ids.map((id) => ({ id })) });
        return;
      case 'bare-array':
        sendJson(
          res,
          200,
          reply.ids.map((id) => ({ id })),
        );
        return;
      case 'http-error':
        sendJson(res, reply.status, reply.body ?? { error: { message: 'mock error' } });
        return;
      case 'html':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><body>Login required</body></html>');
        return;
      case 'hang':
        return;
      case 'redirect':
        res.writeHead(302, { location: reply.location });
        res.end();
        return;
      case 'barrier': {
        this.heldModels.push(res);
        if (this.heldModels.length >= reply.count) {
          const payload = { object: 'list', data: reply.ids.map((id) => ({ id })) };
          for (const held of this.heldModels.splice(0)) sendJson(held, 200, payload);
        }
        return;
      }
    }
  }

  private answerChat(
    res: ServerResponse,
    reply: ChatReply,
    request: Record<string, unknown> | undefined,
  ): void {
    const model = typeof request?.model === 'string' ? request.model : 'mock-model';
    const streaming = request?.stream === true;
    this.callCounter += 1;
    const id = `chatcmpl-mock-${this.callCounter}`;

    switch (reply.kind) {
      case 'http-error':
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        res.end(
          JSON.stringify(
            reply.body ?? { error: { message: `mock HTTP ${reply.status}`, type: 'mock_error' } },
          ),
        );
        return;
      case 'malformed':
        res.writeHead(200, { 'content-type': reply.contentType ?? 'application/json' });
        res.end(reply.body);
        return;
      case 'hang':
        return;
      case 'deferred':
        void reply.reply.then((next) => this.answerChat(res, next, request));
        return;
      case 'slow-stream':
      case 'stall-stream': {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const send = (data: unknown): void => {
          res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
        };
        const pieces = [...reply.chunks];
        const interval = reply.kind === 'slow-stream' ? reply.intervalMs : 0;
        const step = (): void => {
          const piece = pieces.shift();
          if (piece !== undefined) {
            send(chunk(id, model, { role: 'assistant', content: piece }, null));
            setTimeout(step, interval);
            return;
          }
          if (reply.kind === 'stall-stream') return; // never finish
          send({ ...chunk(id, model, {}, 'stop'), usage: usage() });
          send('[DONE]');
          res.end();
        };
        step();
        return;
      }
      case 'text':
      case 'tool-calls': {
        const toolCallsPayload =
          reply.kind === 'tool-calls'
            ? reply.calls.map((call, index) => ({
                id: call.id ?? `call_${this.callCounter}_${index}`,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
                },
              }))
            : undefined;
        const content = reply.kind === 'text' ? reply.text : null;
        const finish = reply.kind === 'text' ? 'stop' : 'tool_calls';
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (data: unknown): void => {
            res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
          };
          if (content !== null) send(chunk(id, model, { role: 'assistant', content }, null));
          if (toolCallsPayload) {
            send(
              chunk(
                id,
                model,
                {
                  role: 'assistant',
                  tool_calls: toolCallsPayload.map((call, index) => ({ index, ...call })),
                },
                null,
              ),
            );
          }
          send({ ...chunk(id, model, {}, finish), usage: usage() });
          send('[DONE]');
          res.end();
          return;
        }
        sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created: 1_700_000_000,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content,
                ...(toolCallsPayload ? { tool_calls: toolCallsPayload } : {}),
              },
              finish_reason: finish,
            },
          ],
          usage: usage(),
        });
        return;
      }
    }
  }
}

function chunk(
  id: string,
  model: string,
  delta: unknown,
  finish: string | null,
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function usage(): unknown {
  return { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const encoded = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

export async function startMockLlm(): Promise<MockLlmServer> {
  return new MockLlmServer().start();
}

// ---------------------------------------------------------------------------
// Network guard: the CLI child may only reach loopback (the mock)
// ---------------------------------------------------------------------------

/**
 * Preloaded into every agent CLI child (`NODE_OPTIONS=--import`). Any fetch
 * to a non-loopback host is refused before a socket is opened and its origin
 * is logged, so a test can assert "no network call was attempted" — and a
 * regression can never reach a real provider with a key from the test.
 */
const NET_GUARD_SOURCE = `
import { appendFileSync } from 'node:fs';
const realFetch = globalThis.fetch;
globalThis.fetch = async function joyTestGuardedFetch(input, init) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  const host = url.hostname.replace(/^\\[/, '').replace(/\\]$/, '');
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return realFetch(input, init);
  if (process.env.JOY_TEST_NET_LOG) appendFileSync(process.env.JOY_TEST_NET_LOG, url.origin + '\\n');
  const cause = Object.assign(new Error('blocked by test network guard'), { code: 'EJOYTESTBLOCKED' });
  throw new TypeError('fetch failed', { cause });
};
`;

export interface AgentSandbox {
  readonly sb: Sandbox;
  /** Run the CLI with the network guard (and any extra env). */
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  spawn(args: readonly string[], options?: Parameters<typeof spawnCli>[2]): LiveRun;
  /** Origins of every non-loopback fetch the CLI attempted (and was refused). */
  externalCalls(): string[];
  /** Env that installs the guard (merge into custom spawns). */
  readonly guardEnv: Record<string, string>;
  cleanup(): void;
}

export function createAgentSandbox(label: string): AgentSandbox {
  const sb = createSandbox(label);
  const guardDir = join(sb.home, '..', 'guard');
  mkdirSync(guardDir, { recursive: true });
  const guardPath = join(guardDir, 'net-guard.mjs');
  writeFileSync(guardPath, NET_GUARD_SOURCE, 'utf8');
  const netLog = join(guardDir, 'external-calls.log');
  const guardEnv = {
    NODE_OPTIONS: `--import=${pathToFileURL(guardPath).href}`,
    JOY_TEST_NET_LOG: netLog,
    JOY_MEDIA_SQLITE_PATH: projectDbPath(sb),
  };
  return {
    sb,
    guardEnv,
    run: (args, options = {}) => sb.run(args, { ...options, env: { ...guardEnv, ...options.env } }),
    spawn: (args, options = {}) =>
      spawnCli(sb, args, { ...options, env: { ...guardEnv, ...options.env } }),
    externalCalls: () =>
      existsSync(netLog)
        ? readFileSync(netLog, 'utf8')
            .split('\n')
            .filter((line) => line.length > 0)
        : [],
    cleanup: () => sb.cleanup(),
  };
}

function projectDbPath(sb: Sandbox): string {
  // A known-writable path keeps agent scenarios focused on the agent flows;
  // the project/timeline suites separately exercise platform default paths.
  return join(sb.home, 'agent-projects.sqlite3');
}

/** Write a config file into the sandbox's `~/.joy-media` (a "pre-existing" install). */
export function writeJoyConfig(sb: Sandbox, file: string, content: string | object): string {
  mkdirSync(sb.joyDir, { recursive: true });
  const path = join(sb.joyDir, file);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return path;
}

export function readJoyConfig<T = Record<string, unknown>>(sb: Sandbox, file: string): T {
  return JSON.parse(readFileSync(join(sb.joyDir, file), 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// Spawning with access to the child (for event-driven signals)
// ---------------------------------------------------------------------------

export interface LiveRun {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves when the process exits. */
  readonly done: Promise<RunResult>;
  /** stdout + stderr seen so far (ANSI-stripped). */
  output(): string;
}

/**
 * Like `sb.run`, but hands back the child so a test can signal it at a
 * precise, event-driven moment (e.g. once the mock has received a request).
 */
export function spawnCli(
  sb: Sandbox,
  args: readonly string[],
  options: {
    env?: Record<string, string | undefined>;
    input?: string;
    keepStdinOpen?: boolean;
  } = {},
): LiveRun {
  ensureCliBuilt();
  const child = spawn(process.execPath, [join(CLI_ROOT, 'bin', 'joy-media.mjs'), ...args], {
    cwd: sb.cwd,
    env: sb.env(options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => stdout.push(c));
  child.stderr.on('data', (c: Buffer) => stderr.push(c));
  if (options.input !== undefined) child.stdin.write(options.input);
  if (!options.keepStdinOpen) child.stdin.end();
  const startedAt = Date.now();
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const done = new Promise<RunResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      resolve({
        args,
        code,
        signal,
        timedOut: false,
        stdout: out,
        stderr: err,
        durationMs: Date.now() - startedAt,
        out: stripAnsi(out),
        err: stripAnsi(err),
        all: stripAnsi(`${out}\n${err}`),
        json<T>(): T {
          return JSON.parse(out) as T;
        },
        ndjson<T>(): T[] {
          return out
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as T);
        },
      });
    });
  });
  return {
    child,
    done,
    output: () =>
      stripAnsi(
        `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}`,
      ),
  };
}

// ---------------------------------------------------------------------------
// State inspection helpers
// ---------------------------------------------------------------------------

export interface ProjectRow {
  readonly id: string;
  readonly revision: number;
  readonly payload: {
    readonly title: string;
    readonly compositions: Record<
      string,
      {
        tracks: Array<{
          id: string;
          clips: Array<{ id: string; startUs: number; durationUs: number }>;
        }>;
      }
    >;
    readonly rootCompositionId: string;
  };
}

/** Latest snapshot of every project in the sandbox's default SQLite database. */
export function readProjects(sb: Sandbox): ProjectRow[] {
  const dbPath = projectDbPath(sb);
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT project_id, revision, payload FROM snapshots
         WHERE (project_id, revision) IN (SELECT project_id, MAX(revision) FROM snapshots GROUP BY project_id)`,
      )
      .all() as Array<{ project_id: string; revision: number; payload: string }>;
    return rows.map((row) => ({
      id: row.project_id,
      revision: row.revision,
      payload: JSON.parse(row.payload) as ProjectRow['payload'],
    }));
  } finally {
    db.close();
  }
}

export function clipsOf(row: ProjectRow): Array<{ trackId: string; id: string }> {
  const root = row.payload.compositions[row.payload.rootCompositionId];
  return (root?.tracks ?? []).flatMap((t) => t.clips.map((c) => ({ trackId: t.id, id: c.id })));
}

/** POSIX permission bits (e.g. 0o600) of a path. */
export function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Every file below `dir` (recursively) — used to hunt for leaked secrets. */
export function readTree(dir: string): Array<{ path: string; content: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ path: string; content: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readTree(full));
    else out.push({ path: full, content: readFileSync(full).toString('latin1') });
  }
  return out;
}

/** Create a project through the real binary and return its id. */
export async function createProject(sb: Sandbox, title: string): Promise<string> {
  const before = new Set(readProjects(sb).map((p) => p.id));
  const r = await sb.run(['project', 'create', title], {
    env: { JOY_MEDIA_SQLITE_PATH: projectDbPath(sb) },
  });
  if (r.code !== 0) throw new Error(`project create failed:\n${r.all}`);
  const created = readProjects(sb).find((p) => !before.has(p.id));
  if (!created) throw new Error(`project create did not persist a project:\n${r.all}`);
  return created.id;
}

/** Add a clip through the real binary; returns the new clip id. */
export async function addClip(
  sb: Sandbox,
  projectId: string,
  opts: { track?: string; start?: number; duration?: number } = {},
): Promise<string> {
  const before = readProjects(sb).find((p) => p.id === projectId);
  const known = new Set(before ? clipsOf(before).map((c) => c.id) : []);
  const r = await sb.run(
    [
      'timeline',
      'add-clip',
      '--project',
      projectId,
      '--track',
      opts.track ?? 'track-v1',
      // `--start 0` is rejected by the shared flag validation (not this suite's
      // area); omitting it means 0.
      ...(opts.start ? ['--start', String(opts.start)] : []),
      '--duration',
      String(opts.duration ?? 4),
    ],
    { env: { JOY_MEDIA_SQLITE_PATH: projectDbPath(sb) } },
  );
  if (r.code !== 0) throw new Error(`add-clip failed:\n${r.all}`);
  const after = readProjects(sb).find((p) => p.id === projectId);
  const clip = after ? clipsOf(after).find((c) => !known.has(c.id)) : undefined;
  if (!clip) throw new Error(`add-clip did not persist a clip:\n${r.all}`);
  return clip.id;
}

/** Fake, obviously-not-real secrets. */
export function fakeKey(label: string): string {
  return `sk-test-${label}-0123456789abcdefFAKE`;
}
