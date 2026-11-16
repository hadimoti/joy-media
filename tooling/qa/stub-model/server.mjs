/**
 * Response script format: a JSON object with an optional `model` and a non-empty `responses` array.
 * Each response may set `match` (`user_includes`, `last_role`, `last_tool`, `media_part`, or `tool`),
 * `content`, `tool_calls`, `delay_ms`, and `reusable`. Omit `match` for an ordered fallback. An `error` object
 * with `message` and `code` plus optional `status_code` returns an OpenAI-style HTTP error instead
 * of a completion. Reusable responses repeat both when matched and as an unmatched fallback.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const DEFAULT_MODEL = 'joy-stub-model';
const TOOL_ARGUMENT_FRAGMENT_CODE_POINTS = 8;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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
  // Windows reserves 5174-5273 and the dev server owns 5173, so no stub may listen in that range.
  if (parsed.port >= 5173 && parsed.port <= 5273) {
    throw new Error('--port must not be in 5173-5273 (reserved); use 0 or 47xxx');
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

const MATCH_KEYS = new Set(['user_includes', 'last_role', 'last_tool', 'media_part', 'tool']);

/**
 * An optional `match` on a scripted response picks it by the shape of the request instead of by
 * position, so the order of the app's own probe calls cannot shift the script. Keys:
 * `user_includes` (text of the last user message contains it), `last_role` (role of the last
 * message), `last_tool` (the final tool reply's originating tool), `media_part` (a content part
 * of that type is present), or `tool` (that tool is offered).
 * A response without `match` is taken in order, as before.
 */
function parseMatch(value, index) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`response ${index + 1} match must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    if (!MATCH_KEYS.has(key) || typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`response ${index + 1} match has an invalid ${key}`);
    }
  }
  return value;
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
        .join('\n');
    }
    return '';
  }
  return '';
}

function requestMatches(match, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (match.user_includes !== undefined && !lastUserText(messages).includes(match.user_includes)) {
    return false;
  }
  if (match.last_role !== undefined) {
    const last = messages.at(-1);
    if (!isRecord(last) || last.role !== match.last_role) return false;
  }
  if (match.last_tool !== undefined) {
    const last = messages.at(-1);
    if (!isRecord(last) || last.role !== 'tool' || typeof last.tool_call_id !== 'string')
      return false;
    const toolName = messages
      .slice(0, -1)
      .reverse()
      .find(
        (message) =>
          isRecord(message) && message.role === 'assistant' && Array.isArray(message.tool_calls),
      )
      ?.tool_calls.find((call) => isRecord(call) && call.id === last.tool_call_id)?.function?.name;
    if (toolName !== match.last_tool) return false;
  }
  if (match.media_part !== undefined) {
    const found = messages.some(
      (message) =>
        isRecord(message) &&
        Array.isArray(message.content) &&
        message.content.some((part) => isRecord(part) && part.type === match.media_part),
    );
    if (!found) return false;
  }
  if (match.tool !== undefined) {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const offered = tools.some(
      (entry) => isRecord(entry) && isRecord(entry.function) && entry.function.name === match.tool,
    );
    if (!offered) return false;
  }
  return true;
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
    const error = entry.error ?? null;
    if (
      error !== null &&
      (!isRecord(error) || typeof error.message !== 'string' || typeof error.code !== 'string')
    ) {
      throw new Error(`response ${index + 1} error must contain message and code strings`);
    }
    if (error !== null && (content !== null || toolCalls.length > 0)) {
      throw new Error(`response ${index + 1} cannot combine an error with content or tool calls`);
    }
    const statusCode = entry.status_code ?? 400;
    if (error !== null && (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599)) {
      throw new Error(`response ${index + 1} status_code must be from 400 to 599`);
    }
    const match = parseMatch(entry.match, index);
    return {
      content,
      tool_calls: toolCalls,
      error,
      status_code: statusCode,
      delay_ms: delayMs,
      match,
      reusable: entry.reusable === true,
      used: false,
    };
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

/** The log never holds the key: only that an Authorization header was sent, and how long it was. */
function authorizationSummary(request) {
  const header = request.headers.authorization;
  return typeof header === 'string'
    ? { authorization_present: true, authorization_length: header.length }
    : { authorization_present: false };
}

/** The matching response for a request, or undefined when the script has none left. */
function pickResponse(script, body) {
  for (const [index, entry] of script.responses.entries()) {
    if (entry.match === null || (entry.used && !entry.reusable)) continue;
    if (requestMatches(entry.match, body)) {
      entry.used = true;
      return { index, entry };
    }
  }
  for (const [index, entry] of script.responses.entries()) {
    if (entry.match !== null || (entry.used && !entry.reusable)) continue;
    entry.used = true;
    return { index, entry };
  }
  return undefined;
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
  // What a tool answered (project data, never a key), so a live row can see why a run went as it did.
  const last = messages.at(-1);
  const lastToolContent =
    isRecord(last) && last.role === 'tool' && typeof last.content === 'string'
      ? last.content.slice(0, 1500)
      : undefined;
  return {
    model_matches: body.model === model,
    stream: body.stream === true,
    message_count: messages.length,
    image_url_count: imageUrlCount,
    tool_names: toolNames,
    ...(lastToolContent === undefined ? {} : { last_tool_content: lastToolContent }),
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

function argumentFragments(text) {
  const characters = Array.from(text);
  const fragments = [];
  for (let start = 0; start < characters.length; start += TOOL_ARGUMENT_FRAGMENT_CODE_POINTS) {
    fragments.push(characters.slice(start, start + TOOL_ARGUMENT_FRAGMENT_CODE_POINTS).join(''));
  }
  return fragments;
}

async function sendStreamingResponse(response, model, scripted, index, openStreams) {
  response.writeHead(200, {
    ...corsHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
  });
  let closed = false;
  openStreams.add(response);
  response.once('close', () => {
    closed = true;
    openStreams.delete(response);
  });

  const delay = () =>
    scripted.delay_ms === 0
      ? Promise.resolve()
      : new Promise((resolveDelay) => {
          const timer = setTimeout(resolveDelay, scripted.delay_ms);
          // A pending delay must not keep the process alive once the server has closed.
          timer.unref();
        });
  const emit = async (value) => {
    if (closed || response.writableEnded) return false;
    response.write(`data: ${JSON.stringify(value)}\n\n`);
    await delay();
    return !closed && !response.writableEnded;
  };

  if (!(await emit(streamChunk(model, index, { role: 'assistant' })))) return;
  if (
    scripted.content !== null &&
    !(await emit(streamChunk(model, index, { content: scripted.content })))
  )
    return;
  for (const [toolIndex, call] of scripted.tool_calls.entries()) {
    // As in the OpenAI stream, the first delta carries the id and name; the arguments follow in fragments.
    const opening = {
      tool_calls: [
        {
          index: toolIndex,
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: '' },
        },
      ],
    };
    if (!(await emit(streamChunk(model, index, opening)))) return;
    for (const fragment of argumentFragments(call.function.arguments)) {
      const delta = { tool_calls: [{ index: toolIndex, function: { arguments: fragment } }] };
      if (!(await emit(streamChunk(model, index, delta)))) return;
    }
  }
  if (
    !(await emit(
      streamChunk(model, index, {}, scripted.tool_calls.length > 0 ? 'tool_calls' : 'stop'),
    ))
  ) {
    return;
  }
  if (!closed && !response.writableEnded) response.end('data: [DONE]\n\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const rawScript = JSON.parse(await readFile(options.scriptPath, 'utf8'));
  const script = parseResponseScript(rawScript);
  const model = options.model ?? script.model;
  let logWriteWarned = false;
  const logEvent = async (event) => {
    try {
      await appendFile(
        options.logPath,
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
        'utf8',
      );
    } catch (error) {
      // The request log is diagnostic only: report the first failure and keep serving.
      if (!logWriteWarned) {
        logWriteWarned = true;
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
        process.stderr.write(`stub-model request log write failed: ${code}\n`);
      }
    }
  };
  const openStreams = new Set();
  let stopping = false;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    if (request.method === 'POST' && path === '/__shutdown') {
      if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? '')) {
        sendJson(response, 403, { error: { message: 'Forbidden.', code: 'forbidden' } });
        return;
      }
      sendJson(response, 202, { status: 'stopping' });
      // Stop only once the acknowledgement has been flushed to the caller.
      response.once('finish', shutdown);
      return;
    }

    if (request.method === 'GET' && path === '/v1/models') {
      await logEvent({ method: 'GET', path, ...authorizationSummary(request) });
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
        ...authorizationSummary(request),
        ...requestSummary(body, model),
      });
      if (body.model !== model) {
        sendJson(response, 400, {
          error: { message: 'Requested model is not available.', code: 'model_not_found' },
        });
        return;
      }
      const picked = pickResponse(script, body);
      if (picked === undefined) {
        sendJson(response, 503, {
          error: { message: 'Response script is exhausted.', code: 'script_exhausted' },
        });
        return;
      }

      const { index, entry: scripted } = picked;
      if (scripted.error !== null) {
        sendJson(response, scripted.status_code, { error: scripted.error });
        return;
      }
      if (body.stream === true) {
        await sendStreamingResponse(response, model, scripted, index, openStreams);
      } else {
        if (scripted.delay_ms > 0) {
          await new Promise((resolveDelay) => {
            const timer = setTimeout(resolveDelay, scripted.delay_ms);
            timer.unref();
          });
        }
        if (!response.destroyed) {
          sendJson(response, 200, completionResponse(model, scripted, index));
        }
      }
      return;
    }

    sendJson(response, 404, { error: { message: 'Not found.', code: 'not_found' } });
  });

  // Ends open SSE streams so server.close() does not wait on them. Streams end without the
  // DONE sentinel, so a client can tell that the reply was cut short.
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    for (const response of openStreams) {
      if (!response.writableEnded) response.end();
    }
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  };

  server.listen(options.port, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('failed to bind loopback port');
    process.stdout.write(
      `${JSON.stringify({ type: 'ready', baseUrl: `http://127.0.0.1:${address.port}/v1`, model })}\n`,
    );
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(
    `stub-model startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
