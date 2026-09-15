import type { JsonRpcTransport } from './usdc-confirmation.js';

/**
 * Alchemy JSON-RPC HTTP transport (JOY Media desktop migration, wave 5). Locked owner
 * decision: "protected Alchemy webhook/RPC configuration ... never copy Alchemy API keys or
 * signing secrets."
 *
 * Alchemy's RPC auth is URL-based — the API key is embedded in the URL path
 * (`https://eth-mainnet.g.alchemy.com/v2/<key>`), so the *entire URL* is the credential here,
 * not just a header value. It is read only from the systemd credential directory (see
 * `readAlchemyRpcUrlFromCredential` below, same convention as
 * entitlement-signing.ts/stock-video-credentials.ts) and never appears in a thrown error
 * message or log line in this module.
 */

export class AlchemyTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AlchemyTransportError';
  }
}

export type FetchImplementation = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

export interface AlchemyRpcOptions {
  readonly rpcUrl: string;
  readonly fetchImpl?: FetchImplementation;
}

interface JsonRpcSuccess {
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly error: { readonly code: number; readonly message: string };
}

export class AlchemyJsonRpcTransport implements JsonRpcTransport {
  private readonly rpcUrl: string;
  private readonly fetchImpl: FetchImplementation;
  private nextId = 1;

  constructor(options: AlchemyRpcOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.rpcUrl);
    } catch {
      // Deliberately does not include the attempted value: it may be (most of) the credential.
      throw new AlchemyTransportError('RPC_URL_INVALID', 'Alchemy RPC URL is not a valid URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new AlchemyTransportError('RPC_URL_INSECURE', 'Alchemy RPC URL must be https://');
    }
    this.rpcUrl = options.rpcUrl;
    this.fetchImpl =
      options.fetchImpl ??
      ((input, init) => fetch(input, init) as unknown as ReturnType<FetchImplementation>);
  }

  async call(method: string, params: readonly unknown[]): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.fetchImpl(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!response.ok) {
      throw new AlchemyTransportError(
        'RPC_HTTP_ERROR',
        `Alchemy RPC returned HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as Partial<JsonRpcSuccess & JsonRpcFailure>;
    if (body.error !== undefined) {
      throw new AlchemyTransportError(
        'RPC_ERROR',
        `Alchemy RPC error ${body.error.code}: ${body.error.message}`,
      );
    }
    return body.result;
  }
}

/** Same systemd `LoadCredential=` directory `joy-media@api.service` already uses (see
 * entitlement-signing.ts). Never generated, never committed, never logged — provisioning the
 * actual credential file is an out-of-band ops action for the owner/Codex. */
export const ALCHEMY_RPC_URL_SYSTEMD_CREDENTIAL_ID = 'joy-media-alchemy-rpc-url';
const DEFAULT_ALCHEMY_CREDENTIAL_DIRECTORY = '/run/credentials/joy-media@api.service';

export function readAlchemyRpcUrlFromCredential(
  readFile: (path: string, encoding: 'utf8') => string,
  directory = DEFAULT_ALCHEMY_CREDENTIAL_DIRECTORY,
): string | undefined {
  try {
    const value = readFile(`${directory}/${ALCHEMY_RPC_URL_SYSTEMD_CREDENTIAL_ID}`, 'utf8');
    return value.trim() === '' ? undefined : value.trim();
  } catch {
    return undefined;
  }
}

/** Same credential directory, for the webhook HMAC signing key (see alchemy-webhook.ts). */
export const ALCHEMY_WEBHOOK_SIGNING_KEY_SYSTEMD_CREDENTIAL_ID =
  'joy-media-alchemy-webhook-signing-key';

export function readAlchemyWebhookSigningKeyFromCredential(
  readFile: (path: string, encoding: 'utf8') => string,
  directory = DEFAULT_ALCHEMY_CREDENTIAL_DIRECTORY,
): string | undefined {
  try {
    const value = readFile(
      `${directory}/${ALCHEMY_WEBHOOK_SIGNING_KEY_SYSTEMD_CREDENTIAL_ID}`,
      'utf8',
    );
    return value.trim() === '' ? undefined : value.trim();
  } catch {
    return undefined;
  }
}
