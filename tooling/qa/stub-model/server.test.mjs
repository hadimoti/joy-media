import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const serverPath = resolve('tooling/qa/stub-model/server.mjs');

async function startServer(t, script) {
  const directory = await mkdtemp(join(tmpdir(), 'joy-stub-model-'));
  const scriptPath = join(directory, 'responses.json');
  const logPath = join(directory, 'requests.ndjson');
  await writeFile(scriptPath, JSON.stringify(script));

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
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolveExit) => child.once('exit', resolveExit));
    }
    await rm(directory, { recursive: true, force: true });
  });

  const result = await startup;
  assert.equal(result.type, 'ready', JSON.stringify(result));
  return { ...result, child, logPath };
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
