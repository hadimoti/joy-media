import { describe, expect, it } from 'vitest';
import {
  ChainObservationError,
  ERC20_TRANSFER_EVENT_TOPIC,
  observeTransferFromReceipt,
  verifyTransferAgainstInvoice,
} from './usdc-confirmation.js';
import type {
  ChainTransferObservation,
  ConfirmationPolicy,
  JsonRpcTransport,
} from './usdc-confirmation.js';

const CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const RECIPIENT = '0x1111111111111111111111111111111111111111'.slice(0, 42);
const SENDER = '0x2222222222222222222222222222222222222222'.slice(0, 42);

function toHex(value: bigint, bytes = 32): string {
  return `0x${value.toString(16).padStart(bytes * 2, '0')}`;
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function fakeTransport(
  responses: Partial<{
    readonly receipt: unknown;
    readonly blockNumber: string;
  }>,
): JsonRpcTransport {
  return {
    async call(method) {
      if (method === 'eth_getTransactionReceipt') return responses.receipt ?? null;
      if (method === 'eth_blockNumber') return responses.blockNumber ?? '0x0';
      throw new Error(`unexpected RPC method in test: ${method}`);
    },
  };
}

function successReceipt(overrides: {
  readonly value?: bigint;
  readonly to?: string;
  readonly from?: string;
  readonly contract?: string;
  readonly blockNumber?: bigint;
  readonly logIndex?: bigint;
  readonly topic0?: string;
  readonly status?: string;
}) {
  return {
    status: overrides.status ?? '0x1',
    blockNumber: toHex(overrides.blockNumber ?? 100n, 1),
    transactionHash: '0xabc',
    logs: [
      {
        address: overrides.contract ?? CONTRACT,
        topics: [
          overrides.topic0 ?? ERC20_TRANSFER_EVENT_TOPIC,
          addressTopic(overrides.from ?? SENDER),
          addressTopic(overrides.to ?? RECIPIENT),
        ],
        data: toHex(overrides.value ?? 12_000_000n),
        logIndex: toHex(overrides.logIndex ?? 3n, 1),
      },
    ],
  };
}

describe('observeTransferFromReceipt', () => {
  it('returns undefined for a not-yet-mined transaction', async () => {
    const transport = fakeTransport({ receipt: null });
    expect(await observeTransferFromReceipt('0xabc', transport, 1, CONTRACT)).toBeUndefined();
  });

  it('decodes a successful Transfer log into a typed observation', async () => {
    const transport = fakeTransport({
      receipt: successReceipt({ blockNumber: 100n }),
      blockNumber: toHex(105n, 1),
    });
    const observation = await observeTransferFromReceipt('0xabc', transport, 1, CONTRACT);
    expect(observation).toEqual({
      txHash: '0xabc',
      logIndex: 3,
      blockNumber: 100,
      confirmations: 6, // 105 - 100 + 1
      contractAddress: CONTRACT,
      fromAddress: SENDER.toLowerCase(),
      toAddress: RECIPIENT.toLowerCase(),
      valueBaseUnits: '12000000',
      chainId: 1,
      status: 'success',
    });
  });

  it('reports a reverted transaction as status "failed"', async () => {
    const transport = fakeTransport({
      receipt: successReceipt({ status: '0x0' }),
      blockNumber: toHex(100n, 1),
    });
    const observation = await observeTransferFromReceipt('0xabc', transport, 1, CONTRACT);
    expect(observation?.status).toBe('failed');
  });

  it('computes zero confirmations for a receipt not yet reflected by the latest block', async () => {
    const transport = fakeTransport({
      receipt: successReceipt({ blockNumber: 200n }),
      blockNumber: toHex(100n, 1), // stale/lagging RPC node
    });
    const observation = await observeTransferFromReceipt('0xabc', transport, 1, CONTRACT);
    expect(observation?.confirmations).toBe(0);
  });

  it('throws when the receipt has no Transfer log on the expected contract', async () => {
    const transport = fakeTransport({
      receipt: successReceipt({ contract: '0x9999999999999999999999999999999999999999' }),
      blockNumber: toHex(100n, 1),
    });
    await expect(
      observeTransferFromReceipt('0xabc', transport, 1, CONTRACT),
    ).rejects.toBeInstanceOf(ChainObservationError);
  });

  it('throws when the log is a different event entirely (wrong topic0)', async () => {
    const transport = fakeTransport({
      receipt: successReceipt({ topic0: '0xdeadbeef'.padEnd(66, '0') }),
      blockNumber: toHex(100n, 1),
    });
    await expect(
      observeTransferFromReceipt('0xabc', transport, 1, CONTRACT),
    ).rejects.toBeInstanceOf(ChainObservationError);
  });
});

describe('verifyTransferAgainstInvoice', () => {
  const policy: ConfirmationPolicy = {
    requiredConfirmations: 12,
    expectedChainId: 1,
    expectedContractAddress: CONTRACT,
    expectedRecipientAddress: RECIPIENT,
  };
  const invoice = { amountUsdcBaseUnits: '12000000' };

  function observation(
    overrides: Partial<ChainTransferObservation> = {},
  ): ChainTransferObservation {
    return {
      txHash: '0xabc',
      logIndex: 3,
      blockNumber: 100,
      confirmations: 12,
      contractAddress: CONTRACT,
      fromAddress: SENDER,
      toAddress: RECIPIENT,
      valueBaseUnits: '12000000',
      chainId: 1,
      status: 'success',
      ...overrides,
    };
  }

  it('accepts a transfer matching every check exactly', () => {
    expect(verifyTransferAgainstInvoice(observation(), invoice, policy)).toEqual({ ok: true });
  });

  it('is case-insensitive when comparing addresses', () => {
    expect(
      verifyTransferAgainstInvoice(
        observation({
          toAddress: RECIPIENT.toUpperCase(),
          contractAddress: CONTRACT.toUpperCase(),
        }),
        invoice,
        policy,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects a failed transaction', () => {
    expect(
      verifyTransferAgainstInvoice(observation({ status: 'failed' }), invoice, policy),
    ).toEqual({ ok: false, reason: 'TX_NOT_SUCCESSFUL' });
  });

  it('rejects the wrong chain', () => {
    expect(verifyTransferAgainstInvoice(observation({ chainId: 137 }), invoice, policy)).toEqual({
      ok: false,
      reason: 'WRONG_CHAIN',
    });
  });

  it('rejects the wrong contract (a look-alike token)', () => {
    expect(
      verifyTransferAgainstInvoice(
        observation({ contractAddress: '0x9999999999999999999999999999999999999999' }),
        invoice,
        policy,
      ),
    ).toEqual({ ok: false, reason: 'WRONG_CONTRACT' });
  });

  it('rejects the wrong recipient', () => {
    expect(
      verifyTransferAgainstInvoice(
        observation({ toAddress: '0x9999999999999999999999999999999999999999' }),
        invoice,
        policy,
      ),
    ).toEqual({ ok: false, reason: 'WRONG_RECIPIENT' });
  });

  it('rejects an amount that does not match exactly, even by one base unit', () => {
    expect(
      verifyTransferAgainstInvoice(observation({ valueBaseUnits: '12000001' }), invoice, policy),
    ).toEqual({ ok: false, reason: 'AMOUNT_MISMATCH' });
  });

  it('rejects too few confirmations', () => {
    expect(
      verifyTransferAgainstInvoice(observation({ confirmations: 11 }), invoice, policy),
    ).toEqual({ ok: false, reason: 'INSUFFICIENT_CONFIRMATIONS' });
  });
});
