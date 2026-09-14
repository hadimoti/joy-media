import { describe, expect, it, vi } from 'vitest';
import {
  ALCHEMY_RPC_URL_SYSTEMD_CREDENTIAL_ID,
  ALCHEMY_WEBHOOK_SIGNING_KEY_SYSTEMD_CREDENTIAL_ID,
  AlchemyJsonRpcTransport,
  AlchemyTransportError,
  readAlchemyRpcUrlFromCredential,
  readAlchemyWebhookSigningKeyFromCredential,
} from './alchemy-transport.js';
import type { FetchImplementation } from './alchemy-transport.js';

const RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/fake-key-for-tests';

describe('AlchemyJsonRpcTransport', () => {
  it('rejects a non-URL string without ever including it in the error message', () => {
    expect(() => new AlchemyJsonRpcTransport({ rpcUrl: 'super-secret-not-a-url' })).toThrow(
      AlchemyTransportError,
    );
    try {
      new AlchemyJsonRpcTransport({ rpcUrl: 'super-secret-not-a-url' });
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-not-a-url');
    }
  });

  it('rejects a non-https URL', () => {
    expect(
      () => new AlchemyJsonRpcTransport({ rpcUrl: 'http://eth-mainnet.example/v2/key' }),
    ).toThrow(AlchemyTransportError);
  });

  it('posts a well-formed JSON-RPC 2.0 request to the configured URL', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: '0x64' }),
    })) as unknown as FetchImplementation;
    const transport = new AlchemyJsonRpcTransport({ rpcUrl: RPC_URL, fetchImpl });
    const result = await transport.call('eth_blockNumber', []);
    expect(result).toBe('0x64');
    expect(fetchImpl).toHaveBeenCalledWith(RPC_URL, expect.objectContaining({ method: 'POST' }));
    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    const body = JSON.parse(init.body) as { jsonrpc: string; method: string; params: unknown[] };
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [] });
  });

  it('increments the request id across calls', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: null }),
    })) as unknown as FetchImplementation;
    const transport = new AlchemyJsonRpcTransport({ rpcUrl: RPC_URL, fetchImpl });
    await transport.call('eth_blockNumber', []);
    await transport.call('eth_blockNumber', []);
    const ids = vi
      .mocked(fetchImpl)
      .mock.calls.map(([, init]) => (JSON.parse(init.body) as { id: number }).id);
    expect(ids).toEqual([1, 2]);
  });

  it('surfaces a non-2xx HTTP response as AlchemyTransportError', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as FetchImplementation;
    const transport = new AlchemyJsonRpcTransport({ rpcUrl: RPC_URL, fetchImpl });
    await expect(transport.call('eth_blockNumber', [])).rejects.toBeInstanceOf(
      AlchemyTransportError,
    );
  });

  it('surfaces a JSON-RPC error response as AlchemyTransportError', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: -32000, message: 'bad request' } }),
    })) as unknown as FetchImplementation;
    const transport = new AlchemyJsonRpcTransport({ rpcUrl: RPC_URL, fetchImpl });
    await expect(transport.call('eth_blockNumber', [])).rejects.toBeInstanceOf(
      AlchemyTransportError,
    );
  });
});

describe('readAlchemyRpcUrlFromCredential', () => {
  it('reads the RPC URL from the expected credential path', () => {
    const reads: string[] = [];
    const value = readAlchemyRpcUrlFromCredential((path) => {
      reads.push(path);
      return RPC_URL;
    }, '/run/credentials/joy-media@api.service');
    expect(reads).toEqual([
      `/run/credentials/joy-media@api.service/${ALCHEMY_RPC_URL_SYSTEMD_CREDENTIAL_ID}`,
    ]);
    expect(value).toBe(RPC_URL);
  });

  it('returns undefined when the credential file is absent', () => {
    expect(
      readAlchemyRpcUrlFromCredential(() => {
        throw new Error('ENOENT');
      }),
    ).toBeUndefined();
  });
});

describe('readAlchemyWebhookSigningKeyFromCredential', () => {
  it('reads the signing key from the expected credential path', () => {
    const reads: string[] = [];
    const value = readAlchemyWebhookSigningKeyFromCredential((path) => {
      reads.push(path);
      return 'whsec_test';
    }, '/run/credentials/joy-media@api.service');
    expect(reads).toEqual([
      `/run/credentials/joy-media@api.service/${ALCHEMY_WEBHOOK_SIGNING_KEY_SYSTEMD_CREDENTIAL_ID}`,
    ]);
    expect(value).toBe('whsec_test');
  });

  it('returns undefined for a present but empty credential file', () => {
    expect(readAlchemyWebhookSigningKeyFromCredential(() => '  ')).toBeUndefined();
  });
});
