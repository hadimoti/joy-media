/**
 * Canonical on-chain confirmation checks for a USDC invoice (JOY Media desktop migration,
 * wave 5). Locked owner decisions: "canonical RPC confirmation checks", "exact integer base
 * units", "duplicate tx/log protection".
 *
 * Two layers, deliberately separated:
 * - `verifyTransferAgainstInvoice` is pure (no I/O) — the actual matching logic, fully
 *   testable without a real chain or RPC provider.
 * - `observeTransferFromReceipt` decodes a `JsonRpcTransport`'s raw receipt/log response into
 *   the typed shape the pure verifier consumes. Only this half touches a transport.
 */

export interface ChainTransferObservation {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly confirmations: number;
  readonly contractAddress: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  /** Exact integer base units (USDC has 6 decimals), as a decimal string — never a float. */
  readonly valueBaseUnits: string;
  readonly chainId: number;
  readonly status: 'success' | 'failed';
}

export interface ConfirmationPolicy {
  readonly requiredConfirmations: number;
  readonly expectedChainId: number;
  readonly expectedContractAddress: string;
  readonly expectedRecipientAddress: string;
}

export interface InvoiceForVerification {
  readonly amountUsdcBaseUnits: string;
}

export type ConfirmationVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: ConfirmationFailureReason };

export type ConfirmationFailureReason =
  | 'TX_NOT_SUCCESSFUL'
  | 'WRONG_CHAIN'
  | 'WRONG_CONTRACT'
  | 'WRONG_RECIPIENT'
  | 'AMOUNT_MISMATCH'
  | 'INSUFFICIENT_CONFIRMATIONS';

export function verifyTransferAgainstInvoice(
  observation: ChainTransferObservation,
  invoice: InvoiceForVerification,
  policy: ConfirmationPolicy,
): ConfirmationVerdict {
  if (observation.status !== 'success') return { ok: false, reason: 'TX_NOT_SUCCESSFUL' };
  if (observation.chainId !== policy.expectedChainId) return { ok: false, reason: 'WRONG_CHAIN' };
  if (!sameAddress(observation.contractAddress, policy.expectedContractAddress)) {
    return { ok: false, reason: 'WRONG_CONTRACT' };
  }
  if (!sameAddress(observation.toAddress, policy.expectedRecipientAddress)) {
    return { ok: false, reason: 'WRONG_RECIPIENT' };
  }
  if (observation.valueBaseUnits !== invoice.amountUsdcBaseUnits) {
    return { ok: false, reason: 'AMOUNT_MISMATCH' };
  }
  if (observation.confirmations < policy.requiredConfirmations) {
    return { ok: false, reason: 'INSUFFICIENT_CONFIRMATIONS' };
  }
  return { ok: true };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ===== RPC receipt decoding =====

/** Universal ERC20 `Transfer(address indexed from, address indexed to, uint256 value)` event
 * signature hash — identical for every ERC20 token ever deployed, on every EVM chain. This is
 * public protocol data, not owner- or product-specific configuration, so unlike the USDC
 * contract/recipient address it is safe to hardcode. */
export const ERC20_TRANSFER_EVENT_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface JsonRpcTransport {
  call(method: string, params: readonly unknown[]): Promise<unknown>;
}

interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly logIndex: string;
}

interface RawReceipt {
  readonly status: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logs: readonly RawLog[];
}

export class ChainObservationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChainObservationError';
  }
}

/**
 * Fetches a transaction receipt and the current block height, then decodes the single
 * ERC20 Transfer log matching `expectedContractAddress`. Returns `undefined` (not an error)
 * for a not-yet-mined transaction — the caller should simply poll again later, which is the
 * normal, expected state for most of an invoice's pending lifetime.
 */
export async function observeTransferFromReceipt(
  txHash: string,
  transport: JsonRpcTransport,
  chainId: number,
  expectedContractAddress: string,
): Promise<ChainTransferObservation | undefined> {
  const receipt = (await transport.call('eth_getTransactionReceipt', [
    txHash,
  ])) as RawReceipt | null;
  if (receipt === null) return undefined; // not yet mined — poll again later

  const currentBlockHex = (await transport.call('eth_blockNumber', [])) as string;
  const currentBlock = hexToBigInt(currentBlockHex);
  const receiptBlock = hexToBigInt(receipt.blockNumber);
  const confirmations = currentBlock >= receiptBlock ? Number(currentBlock - receiptBlock) + 1 : 0;

  const transferLog = receipt.logs.find(
    (log) =>
      sameAddress(log.address, expectedContractAddress) &&
      log.topics[0]?.toLowerCase() === ERC20_TRANSFER_EVENT_TOPIC,
  );
  if (transferLog === undefined) {
    throw new ChainObservationError(
      'TRANSFER_LOG_NOT_FOUND',
      `receipt for ${txHash} has no Transfer log on ${expectedContractAddress}`,
    );
  }
  const fromTopic = transferLog.topics[1];
  const toTopic = transferLog.topics[2];
  if (fromTopic === undefined || toTopic === undefined) {
    throw new ChainObservationError(
      'TRANSFER_LOG_MALFORMED',
      `Transfer log for ${txHash} is missing indexed from/to topics`,
    );
  }

  return {
    txHash: receipt.transactionHash,
    logIndex: Number(hexToBigInt(transferLog.logIndex)),
    blockNumber: Number(receiptBlock),
    confirmations,
    contractAddress: transferLog.address,
    fromAddress: addressFromTopic(fromTopic),
    toAddress: addressFromTopic(toTopic),
    valueBaseUnits: hexToBigInt(transferLog.data).toString(10),
    chainId,
    status: receipt.status === '0x1' ? 'success' : 'failed',
  };
}

function hexToBigInt(hex: string): bigint {
  return hex === '0x' || hex.length === 0 ? 0n : BigInt(hex);
}

/** A 32-byte indexed `address` topic is left-zero-padded; the address is the low 20 bytes. */
function addressFromTopic(topic: string): string {
  return `0x${topic.slice(-40)}`;
}
