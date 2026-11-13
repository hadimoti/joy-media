import { appendFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const DEFAULT_MODEL = 'joy-stub-model';

function parseArguments(argv) {
  const parsed = { port: 43123, scriptPath: undefined, logPath: undefined, model: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === '--port') {
      parsed.port = Number(value);
      index += 1;
    } else if (name === '--script') {
      parsed.scriptPath = value;
      index += 1;
    } else if (name === '--log') {
      parsed.logPath = value;
      index += 1;
    } else if (name === '--model') {
      parsed.model = value;
      index += 1;
    } else {
      throw new Error(`unknown option: ${name}`);
    }
  }

  if (!Number.isInteger(parsed.port) || parsed.port < 0 || parsed.port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  if (typeof parsed.scriptPath !== 'string' || parsed.scriptPath.length === 0) {
    throw new Error('--script is required');
  }
  if (typeof parsed.logPath !== 'string' || parsed.logPath.length === 0) {
    throw new Error('--log is required');
  }
  return parsed;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResponseScript(value) {
  if (!isRecord(value) || !Array.isArray(value.responses) || value.responses.length === 0) {
    throw new Error('response script must contain a non-empty responses array');
  }

  const responses = value.responses.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`response ${index + 1} must be an object`);
    const content = entry.content === undefined || entry.content === null ? null : entry.content;
    if (content !== null && typeof content !== 'string') {
      throw new Error(`response ${index + 1} content must be a string or null`);
    }
    const toolCalls = entry.tool_calls ?? [];
    if (!Array.isArray(toolCalls))
      throw new Error(`response ${index + 1} tool_calls must be an array`);
    for (const [toolIndex, call] of toolCalls.entries()) {
      if (
        !isRecord(call) ||
        typeof call.id !== 'string' ||
        call.type !== 'function' ||
        !isRecord(call.function) ||
        typeof call.function.name !== 'string' ||
        typeof call.function.arguments !== 'string'
      ) {
        throw new Error(`response ${index + 1} tool call ${toolIndex + 1} is invalid`);
      }
    }
    const delayMs = entry.delay_ms ?? 0;
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5000) {
      throw new Error(`response ${index + 1} delay_ms must be from 0 to 5000`);
    }
    return { content, tool_calls: toolCalls, delay_ms: delayMs };
  });

  const model =
    typeof value.model === 'string' && value.model.length > 0 ? value.model : DEFAULT_MODEL;
  return { model, responses };
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-private-network': 'true',
    'cache-control': 'no-store',
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

async function readRequestJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(parsed)) throw new Error('invalid_json');
    return parsed;
  } catch {
    throw new Error('invalid_json');
  }
}

function requestSummary(body, model) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let imageUrlCount = 0;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    imageUrlCount += message.content.filter(
      (part) => isRecord(part) && part.type === 'image_url',
    ).length;
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames = tools.flatMap((entry) =>
    isRecord(entry) && isRecord(entry.function) && typeof entry.function.name === 'string'
      ? [entry.function.name]
      : [],
  );
  return {
    model_matches: body.model === model,
    stream: body.stream === true,
    message_count: messages.length,
    image_url_count: imageUrlCount,
    tool_names: toolNames,
  };
}

function completionResponse(model, scripted, index) {
  const hasToolCalls = scripted.tool_calls.length > 0;
  return {
    id: `chatcmpl-joy-stub-${index + 1}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: scripted.content,
          ...(hasToolCalls ? { tool_calls: scripted.tool_calls } : {}),
        },
        finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function streamChunk(model, index, delta, finishReason = null) {
  return {
    id: `chatcmpl-joy-stub-${index + 1}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function sendStreamingResponse(response, model, scripted, index) {
  response.writeHead(200, {
    ...corsHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
  });
  let closed = false;
  response.once('close', () => {
    closed = true;
  });

  const delay = () =>
    scripted.delay_ms === 0
      ? Promise.resolve()
      : new Promise((resolveDelay) => setTimeout(resolveDelay, scripted.delay_ms));
  const emit = async (value) => {
    if (closed) return false;
    response.write(`data: ${JSON.stringify(value)}\n\n`);
    await delay();
    return !closed;
  };

  if (!(await emit(streamChunk(model, index, { role: 'assistant' })))) return;
  if (
    scripted.content !== null &&
    !(await emit(streamChunk(model, index, { content: scripted.content })))
  )
    return;
  for (const [toolIndex, call] of scripted.tool_calls.entries()) {
    const delta = {
      tool_calls: [
        {
          index: toolIndex,
          id: call.id,
          type: 'function',
          function: call.function,
        },
      ],
    };
    if (!(await emit(streamChunk(model, index, delta)))) return;
  }
  if (
    !(await emit(
      streamChunk(model, index, {}, scripted.tool_calls.length > 0 ? 'tool_calls' : 'stop'),
    ))
  ) {
    return;
  }
  if (!closed) response.end('data: [DONE]\n\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const rawScript = JSON.parse(await readFile(options.scriptPath, 'utf8'));
  const script = parseResponseScript(rawScript);
  const model = options.model ?? script.model;
  const logEvent = async (event) => {
    await appendFile(
      options.logPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      'utf8',
    );
  };
  let nextResponse = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    if (request.method === 'GET' && path === '/v1/models') {
      await logEvent({
        method: 'GET',
        path,
        authorization_present: typeof request.headers.authorization === 'string',
      });
      sendJson(response, 200, {
        object: 'list',
        data: [{ id: model, object: 'model', created: 0, owned_by: 'joy-media-stub' }],
      });
      return;
    }

    if (request.method === 'POST' && path === '/v1/chat/completions') {
      let body;
      try {
        body = await readRequestJson(request);
      } catch (error) {
        const code = error instanceof Error && error.message === 'request_too_large' ? 413 : 400;
        sendJson(response, code, {
          error: { message: 'Invalid request body.', code: 'invalid_request' },
        });
        return;
      }
      await logEvent({
        method: 'POST',
        path,
        authorization_present: typeof request.headers.authorization === 'string',
        ...requestSummary(body, model),
      });
      if (body.model !== model) {
        sendJson(response, 400, {
          error: { message: 'Requested model is not available.', code: 'model_not_found' },
        });
        return;
      }
      if (nextResponse >= script.responses.length) {
        sendJson(response, 503, {
          error: { message: 'Response script is exhausted.', code: 'script_exhausted' },
        });
        return;
      }

      const index = nextResponse;
      const scripted = script.responses[nextResponse];
      nextResponse += 1;
      if (body.stream === true) {
        await sendStreamingResponse(response, model, scripted, index);
      } else {
        sendJson(response, 200, completionResponse(model, scripted, index));
      }
      return;
    }

    sendJson(response, 404, { error: { message: 'Not found.', code: 'not_found' } });
  });

  server.listen(options.port, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('failed to bind loopback port');
    process.stdout.write(
      `${JSON.stringify({ type: 'ready', baseUrl: `http://127.0.0.1:${address.port}/v1`, model })}\n`,
    );
  });
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  process.stderr.write(
    `stub-model startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
