import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

async function startServer(t, script, { logIsDirectory = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'joy-stub-model-'));
  const scriptPath = join(directory, 'responses.json');
  const logPath = join(
    directory,
    logIsDirectory ? 'request-log-is-a-directory' : 'requests.ndjson',
  );
  await writeFile(scriptPath, JSON.stringify(script));
  if (logIsDirectory) await mkdir(logPath);

  const child = spawn(
    process.execPath,
    [serverPath, '--port', '0', '--script', scriptPath, '--log', logPath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let settled = false;
  let finishStartup;
  const startup = new Promise((resolveStartup) => {
    finishStartup = resolveStartup;
  });
  const timeout = setTimeout(() => finish({ type: 'timeout', stderr }), 5000);

  function finish(result) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    finishStartup(result);
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const newline = stdout.indexOf('\n');
    if (newline < 0) return;
    try {
      finish({ type: 'ready', ...JSON.parse(stdout.slice(0, newline)) });
    } catch (error) {
      finish({ type: 'invalid-ready-line', error: String(error), stdout, stderr });
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.once('error', (error) => finish({ type: 'spawn-error', error: error.message, stderr }));
  child.once('exit', (code, signal) => {
    finish({ type: 'exited', code, signal, stdout, stderr });
  });

  t.after(async () => {
    // Fallback only: on Windows child.kill() is a hard kill that skips the shutdown path.
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolveExit) => child.once('exit', resolveExit));
    }
    await rm(directory, { recursive: true, force: true });
  });

  const result = await startup;
  assert.equal(result.type, 'ready', JSON.stringify(result));
  return { ...result, child, logPath, stderrText: () => stderr };
}

function waitForExit(child) {
  return new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ timedOut: true }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('condition was not met in time');
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function toolResponse() {
  return {
    model: 'joy-stub-model',
    responses: [
      {
        content: 'I will inspect the project first.',
        tool_calls: [
          {
            id: 'call_read_project',
            type: 'function',
            function: {
              name: 'read_project_summary',
              arguments: '{}',
            },
          },
        ],
      },
      { content: 'The local stub is ready.', tool_calls: [] },
    ],
  };
}

test('advertises the scripted model on the loopback models endpoint', async (t) => {
  const server = await startServer(t, toolResponse());
  assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:/);

  const response = await globalThis.fetch(`${server.baseUrl}/models`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(
    (await response.json()).data.map((model) => model.id),
    ['joy-stub-model'],
  );
});

test('listens on 127.0.0.1 only and refuses connections on the machine addresses', async (t) => {
  const server = await startServer(t, toolResponse());
  const url = new URL(server.baseUrl);
  assert.equal(url.hostname, '127.0.0.1');

  const lanAddresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
  if (lanAddresses.length === 0) {
    t.skip('no non-loopback IPv4 address on this machine');
    return;
  }
  for (const address of lanAddresses) {
    await assert.rejects(
      globalThis.fetch(`http://${address}:${url.port}/v1/models`, {
        signal: globalThis.AbortSignal.timeout(3000),
      }),
      (error) => error.cause?.code === 'ECONNREFUSED',
      `expected ${address}:${url.port} to be refused`,
    );
  }
});

test('streams file-scripted tool calls for image_url messages without logging credentials or image data', async (t) => {
  const server = await startServer(t, toolResponse());
  const authorizationMarker = `Bearer ${randomUUID()}`;
  const imageUrl = 'data:image/png;base64,AAECAwQ=';
  const response = await globalThis.fetch(`${server.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: authorizationMarker,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'joy-stub-model',
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe the selected frame.' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'read_project_summary', parameters: { type: 'object' } },
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const streamText = await response.text();
  assert.match(streamText, /data: \[DONE\]\n\n$/);
  const events = streamText
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data));
  const toolCalls = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(toolCalls[0]?.function?.name, 'read_project_summary');
  assert.ok(streamText.includes('I will inspect the project first.'));
  assert.equal(streamText.includes(authorizationMarker), false);

  const invalidModel = await globalThis.fetch(`${server.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: authorizationMarker,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: authorizationMarker, messages: [] }),
  });
  assert.equal(invalidModel.status, 400);
  assert.equal((await invalidModel.text()).includes(authorizationMarker), false);

  const logText = await readFile(server.logPath, 'utf8');
  assert.equal(logText.includes(authorizationMarker), false);
  assert.equal(logText.includes(imageUrl), false);
  assert.match(logText, /"image_url_count":1/);
  assert.match(logText, /"tool_names":\["read_project_summary"\]/);
});

test('streams tool-call arguments in fragments that a client accumulator reassembles', async (t) => {
  const argumentsJson = '{"path":"docs/README.md","limit":20,"note":"ok"}';
  const server = await startServer(t, {
    responses: [
      {
        content: null,
        tool_calls: [
          {
            id: 'call_fragments',
            type: 'function',
            function: { name: 'read_project_summary', arguments: argumentsJson },
          },
        ],
      },
    ],
  });
  const response = await globalThis.fetch(`${server.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'joy-stub-model',
      stream: true,
      messages: [{ role: 'user', content: 'Read the summary.' }],
    }),
  });
  assert.equal(response.status, 200);
  const streamText = await response.text();

  // Accumulate the way a streaming client does: keyed by tool-call index, concatenating fragments.
  const accumulated = new Map();
  let finishReason = null;
  for (const line of streamText.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const choice = JSON.parse(line.slice(6)).choices[0];
    finishReason = choice.finish_reason ?? finishReason;
    for (const delta of choice.delta.tool_calls ?? []) {
      const entry = accumulated.get(delta.index) ?? {
        id: undefined,
        name: undefined,
        arguments: '',
        fragments: 0,
      };
      entry.id = delta.id ?? entry.id;
      entry.name = delta.function?.name ?? entry.name;
      if (delta.function?.arguments) {
        entry.arguments += delta.function.arguments;
        entry.fragments += 1;
      }
      accumulated.set(delta.index, entry);
    }
  }

  const call = accumulated.get(0);
  assert.equal(call.id, 'call_fragments');
  assert.equal(call.name, 'read_project_summary');
  assert.ok(call.fragments >= 2, `expected at least two argument fragments, got ${call.fragments}`);
  assert.deepEqual(JSON.parse(call.arguments), JSON.parse(argumentsJson));
  assert.equal(finishReason, 'tool_calls');
  assert.match(streamText, /data: \[DONE\]\n\n$/);
});

test('exits with code 0 through POST /__shutdown while an SSE stream is still open', async (t) => {
  const server = await startServer(t, {
    responses: [
      {
        content: 'Still streaming.',
        delay_ms: 1500,
        tool_calls: [
          {
            id: 'call_slow',
            type: 'function',
            function: { name: 'read_project_summary', arguments: '{"path":"README.md"}' },
          },
        ],
      },
    ],
  });
  const exited = waitForExit(server.child);
  const response = await globalThis.fetch(`${server.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'joy-stub-model',
      stream: true,
      messages: [{ role: 'user', content: 'Stream slowly.' }],
    }),
  });
  const reader = response.body.getReader();
  const decoder = new globalThis.TextDecoder();
  const first = await reader.read();
  assert.equal(first.done, false);
  let streamText = decoder.decode(first.value, { stream: true });

  const shutdown = await globalThis.fetch(`${new URL(server.baseUrl).origin}/__shutdown`, {
    method: 'POST',
  });
  assert.equal(shutdown.status, 202);

  // The scripted stream would take roughly six seconds more; the exit must not wait for it.
  const outcome = await withTimeout(exited, 2000);
  assert.deepEqual(outcome, { code: 0, signal: null });

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    streamText += decoder.decode(chunk.value, { stream: true });
  }
  assert.equal(streamText.includes('[DONE]'), false);
});

test('keeps answering when the request log cannot be written', async (t) => {
  const server = await startServer(t, toolResponse(), { logIsDirectory: true });

  const models = await globalThis.fetch(`${server.baseUrl}/models`);
  assert.equal(models.status, 200);
  const first = await globalThis.fetch(`${server.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'joy-stub-model',
      messages: [{ role: 'user', content: 'Say hello.' }],
    }),
  });
  assert.equal(first.status, 200);
  assert.equal(
    (await first.json()).choices[0].message.content,
    'I will inspect the project first.',
  );
  assert.equal(server.child.exitCode, null);

  await waitUntil(() => server.stderrText().includes('request log write failed'));
  const warnings = server.stderrText().split('request log write failed').length - 1;
  assert.equal(warnings, 1);
});

test('returns queued chat responses and a safe error after the script is exhausted', async (t) => {
  const server = await startServer(t, toolResponse());
  const request = () =>
    globalThis.fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'joy-stub-model',
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    });

  const response = await request();
  assert.equal(response.status, 200);
  const completion = await response.json();
  assert.equal(completion.choices[0].message.content, 'I will inspect the project first.');
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');

  const nextResponse = await request();
  assert.equal((await nextResponse.json()).choices[0].message.content, 'The local stub is ready.');

  const exhausted = await request();
  assert.equal(exhausted.status, 503);
  assert.equal((await exhausted.json()).error.code, 'script_exhausted');
});
