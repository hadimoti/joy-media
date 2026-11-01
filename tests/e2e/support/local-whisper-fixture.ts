import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LocalWhisperWord {
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly confidence: number;
}

export interface LocalWhisperFixture {
  readonly words: readonly LocalWhisperWord[];
}

export interface LocalWhisperRequest {
  readonly language: string | undefined;
  readonly fileBytes: number;
}

export interface LocalWhisperFixtureServer {
  readonly endpoint: string;
  readonly requests: LocalWhisperRequest[];
  failNext: boolean;
  close(): Promise<void>;
}

function readMultipart(body: Buffer, contentType: string | undefined): LocalWhisperRequest {
  const boundary =
    /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')?.[1] ??
    /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')?.[2]?.trim();
  if (boundary === undefined) return { language: undefined, fileBytes: 0 };

  let language: string | undefined;
  let fileBytes = 0;
  for (const rawPart of body.toString('latin1').split(`--${boundary}`)) {
    const headerEnd = rawPart.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = rawPart.slice(0, headerEnd);
    const value = rawPart.slice(headerEnd + 4).replace(/\r\n$/, '');
    if (/content-disposition:[^\r\n]*\bname="language"/i.test(headers)) language = value;
    if (/content-disposition:[^\r\n]*\bname="file"/i.test(headers)) {
      fileBytes = Buffer.byteLength(value, 'latin1');
    }
  }
  return { language, fileBytes };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export async function startLocalWhisperFixtureServer(options: {
  readonly fixtures: Readonly<Record<'en' | 'fa', LocalWhisperFixture>>;
  readonly responseDelayMs?: number;
}): Promise<LocalWhisperFixtureServer> {
  const requests: LocalWhisperRequest[] = [];
  let failNext = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST' || request.url !== '/audio/transcriptions') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      const received = readMultipart(Buffer.concat(chunks), request.headers['content-type']);
      requests.push(received);
      if ((received.language !== 'en' && received.language !== 'fa') || received.fileBytes <= 0) {
        sendJson(response, 400, { error: 'Expected language and non-empty file parts' });
        return;
      }
      if (failNext) {
        failNext = false;
        sendJson(response, 503, { error: 'Deterministic local Whisper outage' });
        return;
      }

      const fixture = options.fixtures[received.language];
      const reply = {
        text: fixture.words.map((word) => word.text).join(' '),
        words: fixture.words.map((word) => ({
          word: word.text,
          start: word.startUs / 1_000_000,
          end: word.endUs / 1_000_000,
          probability: word.confidence,
        })),
      };
      const respond = (): void => sendJson(response, 200, reply);
      if (options.responseDelayMs && options.responseDelayMs > 0) {
        setTimeout(respond, options.responseDelayMs);
      } else {
        respond();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    get failNext() {
      return failNext;
    },
    set failNext(value: boolean) {
      failNext = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
