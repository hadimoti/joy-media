/**
 * A deliberately narrow RPC boundary between the untrusted agent runtime and
 * trusted browser-host tools. It only transports cloned JSON values and never
 * accepts editor writers, browser storage, provider configuration, or secrets.
 *
 * This module is transport-agnostic so the Worker can be wired later without
 * giving it a main-thread capability object.
 */

export const HOST_RPC_PROTOCOL_VERSION = 1 as const;
export const HOST_RPC_MAX_PAYLOAD_BYTES = 65_536;
export const HOST_RPC_DEFAULT_DEADLINE_MS = 15_000;
export const HOST_RPC_MAX_DEADLINE_MS = 30_000;

export type HostRpcJsonScalar = null | boolean | number | string;
export type HostRpcJson =
  HostRpcJsonScalar | readonly HostRpcJson[] | { readonly [key: string]: HostRpcJson };

export interface HostRpcRun {
  readonly runId: string;
  readonly epoch: number;
}

export const HOST_RPC_DIAGNOSTIC_CODES = [
  'JOY_AGENT_RPC_INVALID_REQUEST',
  'JOY_AGENT_RPC_INVALID_RESPONSE',
  'JOY_AGENT_RPC_UNKNOWN_METHOD',
  'JOY_AGENT_RPC_TIMEOUT',
  'JOY_AGENT_RPC_CANCELLED',
  'JOY_AGENT_RPC_ARGUMENT_TOO_LARGE',
  'JOY_AGENT_RPC_OUTPUT_TOO_LARGE',
  'JOY_AGENT_RPC_UNSAFE_PAYLOAD',
  'JOY_AGENT_RPC_CANONICAL_REJECTED',
  'JOY_AGENT_RPC_HANDLER_FAILED',
  'JOY_AGENT_RPC_PROTOCOL_VIOLATION',
  'JOY_AGENT_RPC_TRANSPORT_FAILED',
] as const;
export type HostRpcDiagnosticCode = (typeof HOST_RPC_DIAGNOSTIC_CODES)[number];

export type HostRpcDiagnosticFact = string | number | boolean;

/** Safe, structured feedback that can be returned to the model for repair. */
export interface HostRpcDiagnostic {
  readonly code: HostRpcDiagnosticCode;
  readonly retryable: boolean;
  readonly operation?: string;
  readonly field?: string;
  readonly facts?: Readonly<Record<string, HostRpcDiagnosticFact>>;
}

export class HostRpcError extends Error {
  readonly diagnostic: HostRpcDiagnostic;

  constructor(diagnostic: HostRpcDiagnostic) {
    const safeDiagnostic = parseHostRpcDiagnostic(diagnostic);
    super(safeDiagnostic.code);
    this.name = 'HostRpcError';
    this.diagnostic = safeDiagnostic;
  }
}

/** A host tool may throw this to provide product-owned repair information. */
export class HostRpcDiagnosticError extends HostRpcError {
  constructor(diagnostic: HostRpcDiagnostic) {
    super(diagnostic);
    this.name = 'HostRpcDiagnosticError';
  }
}

export interface HostRpcRequestMessage {
  readonly protocolVersion: typeof HOST_RPC_PROTOCOL_VERSION;
  readonly type: 'host-rpc-request';
  readonly requestId: string;
  readonly runId: string;
  readonly runEpoch: number;
  readonly method: string;
  readonly arguments: HostRpcJson;
  readonly deadlineMs: number;
}

export interface HostRpcCancelMessage {
  readonly protocolVersion: typeof HOST_RPC_PROTOCOL_VERSION;
  readonly type: 'host-rpc-cancel';
  readonly runId: string;
  readonly runEpoch: number;
}

export interface HostRpcSuccessResponseMessage {
  readonly protocolVersion: typeof HOST_RPC_PROTOCOL_VERSION;
  readonly type: 'host-rpc-response';
  readonly requestId: string;
  readonly runId: string;
  readonly runEpoch: number;
  readonly method: string;
  readonly ok: true;
  readonly result: HostRpcJson;
}

export interface HostRpcFailureResponseMessage {
  readonly protocolVersion: typeof HOST_RPC_PROTOCOL_VERSION;
  readonly type: 'host-rpc-response';
  readonly requestId: string;
  readonly runId: string;
  readonly runEpoch: number;
  readonly method: string;
  readonly ok: false;
  readonly error: HostRpcDiagnostic;
}

export type HostRpcResponseMessage = HostRpcSuccessResponseMessage | HostRpcFailureResponseMessage;

export type HostRpcWireMessage =
  HostRpcRequestMessage | HostRpcCancelMessage | HostRpcResponseMessage;

export interface HostRpcTransport {
  postMessage(message: HostRpcWireMessage): void;
}

export interface HostRpcHandlerContext {
  readonly run: HostRpcRun;
  readonly requestId: string;
  readonly signal: AbortSignal;
  /** Monotonic host-clock timestamp. It is never sent across the transport. */
  readonly deadlineAt: number;
}

/**
 * A method owns the exact argument and result schema. Its output is validated
 * both before and after parsing, so a parser cannot accidentally leak a
 * non-JSON host capability through the response envelope.
 */
export interface HostRpcMethod<Arguments = unknown, Result = unknown> {
  parseArgs(value: HostRpcJson): Arguments;
  execute(args: Arguments, context: HostRpcHandlerContext): Result | Promise<Result>;
  parseResult(value: HostRpcJson): Result;
}

export type HostRpcMethods = Readonly<Record<string, HostRpcMethod<unknown, unknown>>>;

export interface HostRpcHostOptions {
  readonly transport: HostRpcTransport;
  readonly methods: HostRpcMethods;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly maxPayloadBytes?: number;
  readonly maxDeadlineMs?: number;
}

export interface HostRpcClientOptions {
  readonly transport: HostRpcTransport;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly defaultDeadlineMs?: number;
  readonly maxDeadlineMs?: number;
  readonly maxPayloadBytes?: number;
  readonly requestIdFactory?: () => string;
}

export interface HostRpcCallOptions {
  readonly deadlineMs?: number;
}

export interface HostRpcClient {
  /** A caller may adopt the outer lifecycle epoch to keep both protocols aligned. */
  beginRun(run: string | HostRpcRun): HostRpcRun;
  call<Result extends HostRpcJson = HostRpcJson>(
    run: HostRpcRun,
    method: string,
    args: HostRpcJson,
    options?: HostRpcCallOptions,
  ): Promise<Result>;
  receive(message: unknown): boolean;
  cancelRun(run: HostRpcRun): void;
  dispose(): void;
}

export interface HostRpcHost {
  receive(message: unknown): boolean;
  cancelRun(run: HostRpcRun): void;
  dispose(): void;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_FACT_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const DIAGNOSTIC_CODES = new Set<string>(HOST_RPC_DIAGNOSTIC_CODES);
const FORBIDDEN_PAYLOAD_KEY_PARTS = [
  'apikey',
  'authorization',
  'cookie',
  'header',
  'secret',
  'token',
  'password',
  'credential',
  'writer',
  'storage',
  'endpoint',
  'baseurl',
  'origin',
  'url',
  'uri',
] as const;
const UNSAFE_TRANSPORT_VALUE =
  /(?:^|[\s:='"(])(?:bearer\s+|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|https?:|blob:|data:|file:|opfs:)/i;
const MAX_DIAGNOSTIC_FACTS = 8;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.get === undefined && descriptor.set === undefined,
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => expected.has(key));
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function isForbiddenPayloadKey(key: string): boolean {
  const normalized = key.replaceAll(/[_-]/g, '').toLowerCase();
  return FORBIDDEN_PAYLOAD_KEY_PARTS.some((part) => normalized.includes(part));
}

function defaultRetryability(code: HostRpcDiagnosticCode): boolean {
  return (
    code === 'JOY_AGENT_RPC_TIMEOUT' ||
    code === 'JOY_AGENT_RPC_TRANSPORT_FAILED' ||
    code === 'JOY_AGENT_RPC_INVALID_REQUEST'
  );
}

function createDiagnostic(
  code: HostRpcDiagnosticCode,
  overrides: Omit<HostRpcDiagnostic, 'code' | 'retryable'> & { readonly retryable?: boolean } = {},
): HostRpcDiagnostic {
  return parseHostRpcDiagnostic({
    code,
    retryable: overrides.retryable ?? defaultRetryability(code),
    ...(overrides.operation === undefined ? {} : { operation: overrides.operation }),
    ...(overrides.field === undefined ? {} : { field: overrides.field }),
    ...(overrides.facts === undefined ? {} : { facts: overrides.facts }),
  });
}

/** Validate and clone a safe diagnostic. Raw thrown errors are never serialized. */
export function parseHostRpcDiagnostic(value: unknown): HostRpcDiagnostic {
  if (!isPlainRecord(value)) throw new Error('JOY_AGENT_RPC_INVALID_DIAGNOSTIC');
  if (
    !hasExactKeys(value, [
      'code',
      'retryable',
      ...(value.operation === undefined ? [] : ['operation']),
      ...(value.field === undefined ? [] : ['field']),
      ...(value.facts === undefined ? [] : ['facts']),
    ]) ||
    typeof value.code !== 'string' ||
    !DIAGNOSTIC_CODES.has(value.code) ||
    typeof value.retryable !== 'boolean' ||
    (value.operation !== undefined && !isSafeId(value.operation)) ||
    (value.field !== undefined && !isSafeId(value.field))
  ) {
    throw new Error('JOY_AGENT_RPC_INVALID_DIAGNOSTIC');
  }
  const facts = value.facts;
  if (facts !== undefined) {
    if (!isPlainRecord(facts) || Object.keys(facts).length > MAX_DIAGNOSTIC_FACTS)
      throw new Error('JOY_AGENT_RPC_INVALID_DIAGNOSTIC');
    for (const [key, fact] of Object.entries(facts)) {
      if (
        !SAFE_FACT_KEY.test(key) ||
        isForbiddenPayloadKey(key) ||
        !(
          typeof fact === 'boolean' ||
          (typeof fact === 'number' && Number.isFinite(fact)) ||
          (typeof fact === 'string' && fact.length <= 256 && !UNSAFE_TRANSPORT_VALUE.test(fact))
        )
      ) {
        throw new Error('JOY_AGENT_RPC_INVALID_DIAGNOSTIC');
      }
    }
  }
  return Object.freeze({
    code: value.code as HostRpcDiagnosticCode,
    retryable: value.retryable,
    ...(value.operation === undefined ? {} : { operation: value.operation as string }),
    ...(value.field === undefined ? {} : { field: value.field as string }),
    ...(facts === undefined
      ? {}
      : { facts: Object.freeze({ ...facts }) as Readonly<Record<string, HostRpcDiagnosticFact>> }),
  });
}

function assertSafeJsonValue(
  value: unknown,
  seen = new Set<object>(),
): asserts value is HostRpcJson {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_UNSAFE_PAYLOAD'));
  }
  if (typeof value === 'string') {
    if (!UNSAFE_TRANSPORT_VALUE.test(value)) return;
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_UNSAFE_PAYLOAD'));
  }
  if (typeof value !== 'object' || seen.has(value))
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_UNSAFE_PAYLOAD'));
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_UNSAFE_PAYLOAD'));
    for (const key of Object.keys(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
        throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_UNSAFE_PAYLOAD'));
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value))
        throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_UNSAFE_PAYLOAD'));
      assertSafeJsonValue(value[index], seen);
    }
    seen.delete(value);
    return;
  }
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0)
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_UNSAFE_PAYLOAD'));
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      isForbiddenPayloadKey(key) ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    ) {
      throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_UNSAFE_PAYLOAD'));
    }
    assertSafeJsonValue(descriptor.value, seen);
  }
  seen.delete(value);
}

function cloneBoundedJson(
  value: unknown,
  maxBytes: number,
  overflowCode: 'JOY_AGENT_RPC_ARGUMENT_TOO_LARGE' | 'JOY_AGENT_RPC_OUTPUT_TOO_LARGE',
): HostRpcJson {
  assertSafeJsonValue(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_UNSAFE_PAYLOAD'));
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes)
    throw new HostRpcError(createDiagnostic(overflowCode));
  return JSON.parse(serialized) as HostRpcJson;
}

function parseRun(value: unknown): HostRpcRun {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['runId', 'epoch']))
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST'));
  if (!isSafeId(value.runId) || !safeInteger(value.epoch, 1, Number.MAX_SAFE_INTEGER))
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST'));
  return Object.freeze({ runId: value.runId, epoch: value.epoch });
}

function normaliseLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!safeInteger(value, 1, maximum)) throw new RangeError('JOY_AGENT_RPC_INVALID_LIMIT');
  return value;
}

function parseRequest(
  value: unknown,
  maxPayloadBytes: number,
  maxDeadlineMs: number,
): HostRpcRequestMessage {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'protocolVersion',
      'type',
      'requestId',
      'runId',
      'runEpoch',
      'method',
      'arguments',
      'deadlineMs',
    ])
  ) {
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST'));
  }
  if (
    value.protocolVersion !== HOST_RPC_PROTOCOL_VERSION ||
    value.type !== 'host-rpc-request' ||
    !isSafeId(value.requestId) ||
    !isSafeId(value.runId) ||
    !safeInteger(value.runEpoch, 1, Number.MAX_SAFE_INTEGER) ||
    !isSafeId(value.method) ||
    !safeInteger(value.deadlineMs, 1, maxDeadlineMs)
  ) {
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST'));
  }
  const args = cloneBoundedJson(
    value.arguments,
    maxPayloadBytes,
    'JOY_AGENT_RPC_ARGUMENT_TOO_LARGE',
  );
  return Object.freeze({
    protocolVersion: HOST_RPC_PROTOCOL_VERSION,
    type: 'host-rpc-request',
    requestId: value.requestId,
    runId: value.runId,
    runEpoch: value.runEpoch,
    method: value.method,
    arguments: args,
    deadlineMs: value.deadlineMs,
  });
}

function parseCancel(value: unknown): HostRpcCancelMessage {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['protocolVersion', 'type', 'runId', 'runEpoch'])
  )
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST'));
  if (
    value.protocolVersion !== HOST_RPC_PROTOCOL_VERSION ||
    value.type !== 'host-rpc-cancel' ||
    !isSafeId(value.runId) ||
    !safeInteger(value.runEpoch, 1, Number.MAX_SAFE_INTEGER)
  ) {
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST'));
  }
  return Object.freeze({
    protocolVersion: HOST_RPC_PROTOCOL_VERSION,
    type: 'host-rpc-cancel',
    runId: value.runId,
    runEpoch: value.runEpoch,
  });
}

/** Strict parser for a Host response. Invalid fields never reach a pending call. */
export function parseHostRpcResponse(
  value: unknown,
  maxPayloadBytes = HOST_RPC_MAX_PAYLOAD_BYTES,
): HostRpcResponseMessage {
  if (!isPlainRecord(value))
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_INVALID_RESPONSE'));
  const common = ['protocolVersion', 'type', 'requestId', 'runId', 'runEpoch', 'method', 'ok'];
  if (!(
    hasExactKeys(value, [...common, ...(value.ok === true ? ['result'] : ['error'])]) &&
    value.protocolVersion === HOST_RPC_PROTOCOL_VERSION &&
    value.type === 'host-rpc-response' &&
    isSafeId(value.requestId) &&
    isSafeId(value.runId) &&
    safeInteger(value.runEpoch, 1, Number.MAX_SAFE_INTEGER) &&
    isSafeId(value.method) &&
    typeof value.ok === 'boolean'
  )) {
    throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_INVALID_RESPONSE'));
  }
  if (value.ok) {
    return Object.freeze({
      protocolVersion: HOST_RPC_PROTOCOL_VERSION,
      type: 'host-rpc-response',
      requestId: value.requestId,
      runId: value.runId,
      runEpoch: value.runEpoch,
      method: value.method,
      ok: true,
      result: cloneBoundedJson(value.result, maxPayloadBytes, 'JOY_AGENT_RPC_OUTPUT_TOO_LARGE'),
    });
  }
  return Object.freeze({
    protocolVersion: HOST_RPC_PROTOCOL_VERSION,
    type: 'host-rpc-response',
    requestId: value.requestId,
    runId: value.runId,
    runEpoch: value.runEpoch,
    method: value.method,
    ok: false,
    error: parseHostRpcDiagnostic(value.error),
  });
}

function routingForMalformedRequest(
  value: unknown,
): Pick<HostRpcRequestMessage, 'requestId' | 'runId' | 'runEpoch' | 'method'> | undefined {
  if (!isPlainRecord(value) || value.type !== 'host-rpc-request') return undefined;
  if (
    !isSafeId(value.requestId) ||
    !isSafeId(value.runId) ||
    !safeInteger(value.runEpoch, 1, Number.MAX_SAFE_INTEGER) ||
    !isSafeId(value.method)
  ) {
    return undefined;
  }
  return {
    requestId: value.requestId,
    runId: value.runId,
    runEpoch: value.runEpoch,
    method: value.method,
  };
}

function routingForMalformedResponse(
  value: unknown,
): Pick<HostRpcResponseMessage, 'requestId' | 'runId' | 'runEpoch' | 'method'> | undefined {
  if (!isPlainRecord(value) || value.type !== 'host-rpc-response') return undefined;
  if (
    !isSafeId(value.requestId) ||
    !isSafeId(value.runId) ||
    !safeInteger(value.runEpoch, 1, Number.MAX_SAFE_INTEGER) ||
    !isSafeId(value.method)
  ) {
    return undefined;
  }
  return {
    requestId: value.requestId,
    runId: value.runId,
    runEpoch: value.runEpoch,
    method: value.method,
  };
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === 'AbortError';
}

function failureResponse(
  request: Pick<HostRpcRequestMessage, 'requestId' | 'runId' | 'runEpoch' | 'method'>,
  diagnostic: HostRpcDiagnostic,
): HostRpcFailureResponseMessage {
  return Object.freeze({
    protocolVersion: HOST_RPC_PROTOCOL_VERSION,
    type: 'host-rpc-response' as const,
    requestId: request.requestId,
    runId: request.runId,
    runEpoch: request.runEpoch,
    method: request.method,
    ok: false,
    error: diagnostic,
  });
}

interface ActiveHostCall {
  readonly request: HostRpcRequestMessage;
  readonly controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  timedOut: boolean;
}

interface HostRunState {
  highestEpoch: number;
  cancelledThrough: number;
}

/** Create the main-thread side. Handlers receive only parsed JSON and an abort signal. */
export function createHostRpcHost(options: HostRpcHostOptions): HostRpcHost {
  const maxPayloadBytes = normaliseLimit(
    options.maxPayloadBytes,
    HOST_RPC_MAX_PAYLOAD_BYTES,
    HOST_RPC_MAX_PAYLOAD_BYTES,
  );
  const maxDeadlineMs = normaliseLimit(
    options.maxDeadlineMs,
    HOST_RPC_MAX_DEADLINE_MS,
    HOST_RPC_MAX_DEADLINE_MS,
  );
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  const active = new Map<string, ActiveHostCall>();
  const runStates = new Map<string, HostRunState>();
  const usedRequestIds = new Map<string, true>();
  let disposed = false;

  const rememberRequestId = (requestId: string): boolean => {
    if (usedRequestIds.has(requestId)) return false;
    usedRequestIds.set(requestId, true);
    while (usedRequestIds.size > 1_024) usedRequestIds.delete(usedRequestIds.keys().next().value!);
    return true;
  };

  const settle = (call: ActiveHostCall, response: HostRpcResponseMessage): void => {
    if (call.settled || disposed) return;
    call.settled = true;
    active.delete(call.request.requestId);
    cancelTimer(call.timer);
    options.transport.postMessage(response);
  };

  const cancelActiveRun = (run: HostRpcRun): void => {
    const state = runStates.get(run.runId) ?? { highestEpoch: run.epoch, cancelledThrough: 0 };
    state.highestEpoch = Math.max(state.highestEpoch, run.epoch);
    state.cancelledThrough = Math.max(state.cancelledThrough, run.epoch);
    runStates.set(run.runId, state);
    for (const call of [...active.values()]) {
      if (call.request.runId === run.runId && call.request.runEpoch <= run.epoch) {
        call.controller.abort();
        settle(
          call,
          failureResponse(
            call.request,
            createDiagnostic('JOY_AGENT_RPC_CANCELLED', {
              operation: call.request.method,
              retryable: false,
            }),
          ),
        );
      }
    }
  };

  const runRequest = (request: HostRpcRequestMessage): void => {
    if (!rememberRequestId(request.requestId)) {
      options.transport.postMessage(
        failureResponse(
          request,
          createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST', {
            operation: request.method,
            field: 'requestId',
            retryable: false,
          }),
        ),
      );
      return;
    }
    const state = runStates.get(request.runId) ?? {
      highestEpoch: request.runEpoch,
      cancelledThrough: 0,
    };
    if (request.runEpoch < state.highestEpoch || request.runEpoch <= state.cancelledThrough) {
      options.transport.postMessage(
        failureResponse(
          request,
          createDiagnostic('JOY_AGENT_RPC_CANCELLED', {
            operation: request.method,
            retryable: false,
          }),
        ),
      );
      return;
    }
    if (request.runEpoch > state.highestEpoch) {
      for (const call of [...active.values()]) {
        if (call.request.runId === request.runId && call.request.runEpoch < request.runEpoch) {
          call.controller.abort();
          settle(
            call,
            failureResponse(
              call.request,
              createDiagnostic('JOY_AGENT_RPC_CANCELLED', {
                operation: call.request.method,
                retryable: false,
              }),
            ),
          );
        }
      }
      state.highestEpoch = request.runEpoch;
    }
    runStates.set(request.runId, state);
    const method = options.methods[request.method];
    if (method === undefined) {
      options.transport.postMessage(
        failureResponse(
          request,
          createDiagnostic('JOY_AGENT_RPC_UNKNOWN_METHOD', {
            operation: request.method,
            retryable: false,
          }),
        ),
      );
      return;
    }
    const controller = new AbortController();
    const call: ActiveHostCall = {
      request,
      controller,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      settled: false,
      timedOut: false,
    };
    call.timer = schedule(() => {
      call.timedOut = true;
      call.controller.abort();
      settle(
        call,
        failureResponse(
          request,
          createDiagnostic('JOY_AGENT_RPC_TIMEOUT', {
            operation: request.method,
            retryable: true,
          }),
        ),
      );
    }, request.deadlineMs);
    active.set(request.requestId, call);
    const context: HostRpcHandlerContext = Object.freeze({
      run: Object.freeze({ runId: request.runId, epoch: request.runEpoch }),
      requestId: request.requestId,
      signal: controller.signal,
      deadlineAt: now() + request.deadlineMs,
    });
    void Promise.resolve()
      .then(async () => {
        let args: unknown;
        try {
          args = method.parseArgs(request.arguments);
        } catch (error) {
          if (error instanceof HostRpcDiagnosticError) throw error;
          throw new HostRpcDiagnosticError(
            createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST', {
              operation: request.method,
              field: 'arguments',
              retryable: true,
            }),
          );
        }
        const rawResult = await method.execute(args, context);
        const result = cloneBoundedJson(
          rawResult,
          maxPayloadBytes,
          'JOY_AGENT_RPC_OUTPUT_TOO_LARGE',
        );
        let normalizedResult: HostRpcJson;
        try {
          normalizedResult = cloneBoundedJson(
            method.parseResult(result),
            maxPayloadBytes,
            'JOY_AGENT_RPC_OUTPUT_TOO_LARGE',
          );
        } catch (error) {
          if (error instanceof HostRpcDiagnosticError) throw error;
          throw new HostRpcDiagnosticError(
            createDiagnostic('JOY_AGENT_RPC_INVALID_RESPONSE', {
              operation: request.method,
              field: 'result',
              retryable: false,
            }),
          );
        }
        settle(
          call,
          Object.freeze({
            protocolVersion: HOST_RPC_PROTOCOL_VERSION,
            type: 'host-rpc-response' as const,
            requestId: request.requestId,
            runId: request.runId,
            runEpoch: request.runEpoch,
            method: request.method,
            ok: true as const,
            result: normalizedResult,
          }),
        );
      })
      .catch((error: unknown) => {
        if (call.settled) return;
        const diagnostic =
          error instanceof HostRpcError
            ? error.diagnostic
            : call.timedOut
              ? createDiagnostic('JOY_AGENT_RPC_TIMEOUT', {
                  operation: request.method,
                  retryable: true,
                })
              : controller.signal.aborted || isAbortError(error)
                ? createDiagnostic('JOY_AGENT_RPC_CANCELLED', {
                    operation: request.method,
                    retryable: false,
                  })
                : createDiagnostic('JOY_AGENT_RPC_HANDLER_FAILED', {
                    operation: request.method,
                    retryable: false,
                  });
        settle(call, failureResponse(request, diagnostic));
      });
  };

  return {
    receive(message) {
      if (disposed || !isPlainRecord(message)) return false;
      if (message.type === 'host-rpc-cancel') {
        try {
          const cancellation = parseCancel(message);
          cancelActiveRun({ runId: cancellation.runId, epoch: cancellation.runEpoch });
          return true;
        } catch {
          return false;
        }
      }
      if (message.type !== 'host-rpc-request') return false;
      try {
        runRequest(parseRequest(message, maxPayloadBytes, maxDeadlineMs));
        return true;
      } catch (error) {
        const routing = routingForMalformedRequest(message);
        if (routing !== undefined) {
          const diagnostic =
            error instanceof HostRpcError
              ? error.diagnostic
              : createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST');
          options.transport.postMessage(failureResponse(routing, diagnostic));
        }
        return false;
      }
    },
    cancelRun(run) {
      try {
        cancelActiveRun(parseRun(run));
      } catch {
        // A trusted owner should never supply an invalid run, but this boundary
        // intentionally has no raw-error side channel.
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const call of active.values()) {
        call.controller.abort();
        cancelTimer(call.timer);
      }
      active.clear();
      runStates.clear();
      usedRequestIds.clear();
    },
  };
}

interface PendingClientCall {
  readonly run: HostRpcRun;
  readonly method: string;
  readonly timer: ReturnType<typeof setTimeout>;
  settle(result: HostRpcResponseMessage | HostRpcError): void;
}

/** Create the Worker/runtime side. It owns correlation and its local deadlines. */
export function createHostRpcClient(options: HostRpcClientOptions): HostRpcClient {
  const maxPayloadBytes = normaliseLimit(
    options.maxPayloadBytes,
    HOST_RPC_MAX_PAYLOAD_BYTES,
    HOST_RPC_MAX_PAYLOAD_BYTES,
  );
  const maxDeadlineMs = normaliseLimit(
    options.maxDeadlineMs,
    HOST_RPC_MAX_DEADLINE_MS,
    HOST_RPC_MAX_DEADLINE_MS,
  );
  const defaultDeadlineMs =
    options.defaultDeadlineMs === undefined
      ? Math.min(HOST_RPC_DEFAULT_DEADLINE_MS, maxDeadlineMs)
      : normaliseLimit(options.defaultDeadlineMs, HOST_RPC_DEFAULT_DEADLINE_MS, maxDeadlineMs);
  const schedule = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  const epochByRun = new Map<string, number>();
  const cancelledRuns = new Set<string>();
  const pending = new Map<string, PendingClientCall>();
  let disposed = false;
  let fallbackRequestSequence = 0;

  const runKey = (run: HostRpcRun): string => `${run.runId}:${run.epoch}`;

  const cancelPending = (run: HostRpcRun, error: HostRpcError): void => {
    for (const [requestId, item] of pending) {
      if (item.run.runId === run.runId && item.run.epoch === run.epoch) {
        pending.delete(requestId);
        cancelTimer(item.timer);
        item.settle(error);
      }
    }
  };

  const sendCancellation = (run: HostRpcRun): void => {
    try {
      options.transport.postMessage({
        protocolVersion: HOST_RPC_PROTOCOL_VERSION,
        type: 'host-rpc-cancel',
        runId: run.runId,
        runEpoch: run.epoch,
      });
    } catch {
      // Local cancellation is already authoritative for this endpoint.
    }
  };

  const isCurrentRun = (run: HostRpcRun): boolean =>
    !disposed && epochByRun.get(run.runId) === run.epoch && !cancelledRuns.has(runKey(run));

  return {
    beginRun(run: string | HostRpcRun) {
      let requested: HostRpcRun | undefined;
      if (typeof run === 'string') {
        if (!isSafeId(run))
          throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST'));
      } else {
        requested = parseRun(run);
      }
      const runId = typeof run === 'string' ? run : requested!.runId;
      if (disposed || !isSafeId(runId))
        throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST'));
      const previousEpoch = epochByRun.get(runId);
      if (previousEpoch !== undefined && !cancelledRuns.has(`${runId}:${previousEpoch}`)) {
        const previous = Object.freeze({ runId, epoch: previousEpoch });
        cancelledRuns.add(runKey(previous));
        cancelPending(
          previous,
          new HostRpcError(createDiagnostic('JOY_AGENT_RPC_CANCELLED', { retryable: false })),
        );
        sendCancellation(previous);
      }
      const epoch = requested?.epoch ?? (previousEpoch ?? 0) + 1;
      if (previousEpoch !== undefined && epoch <= previousEpoch)
        throw new HostRpcError(
          createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'epoch', retryable: false }),
        );
      epochByRun.set(runId, epoch);
      return Object.freeze({ runId, epoch });
    },
    async call<Result extends HostRpcJson = HostRpcJson>(
      run: HostRpcRun,
      method: string,
      args: HostRpcJson,
      callOptions: HostRpcCallOptions = {},
    ) {
      const safeRun = parseRun(run);
      if (!isCurrentRun(safeRun))
        throw new HostRpcError(createDiagnostic('JOY_AGENT_RPC_CANCELLED', { retryable: false }));
      if (!isSafeId(method))
        throw new HostRpcError(
          createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'method' }),
        );
      const deadlineMs = normaliseLimit(callOptions.deadlineMs, defaultDeadlineMs, maxDeadlineMs);
      const safeArgs = cloneBoundedJson(args, maxPayloadBytes, 'JOY_AGENT_RPC_ARGUMENT_TOO_LARGE');
      const requestId = options.requestIdFactory?.() ?? `host-rpc-${++fallbackRequestSequence}`;
      if (!isSafeId(requestId) || pending.has(requestId))
        throw new HostRpcError(
          createDiagnostic('JOY_AGENT_RPC_INVALID_REQUEST', { field: 'requestId' }),
        );
      return new Promise<Result>((resolve, reject) => {
        let settled = false;
        const settle = (result: HostRpcResponseMessage | HostRpcError): void => {
          if (settled) return;
          settled = true;
          if (result instanceof HostRpcError) {
            reject(result);
            return;
          }
          if (result.ok) resolve(result.result as Result);
          else reject(new HostRpcError(result.error));
        };
        const timer = schedule(() => {
          const item = pending.get(requestId);
          if (item === undefined) return;
          pending.delete(requestId);
          // A host preparation that outlives a Worker-side deadline could
          // otherwise stage an orphaned change. Cancel the whole epoch on a
          // client timeout before rejecting the model turn.
          cancelledRuns.add(runKey(safeRun));
          sendCancellation(safeRun);
          item.settle(
            new HostRpcError(
              createDiagnostic('JOY_AGENT_RPC_TIMEOUT', { operation: method, retryable: true }),
            ),
          );
        }, deadlineMs);
        pending.set(requestId, { run: safeRun, method, timer, settle });
        const request: HostRpcRequestMessage = {
          protocolVersion: HOST_RPC_PROTOCOL_VERSION,
          type: 'host-rpc-request',
          requestId,
          runId: safeRun.runId,
          runEpoch: safeRun.epoch,
          method,
          arguments: safeArgs,
          deadlineMs,
        };
        try {
          options.transport.postMessage(request);
        } catch {
          pending.delete(requestId);
          cancelTimer(timer);
          settle(
            new HostRpcError(
              createDiagnostic('JOY_AGENT_RPC_TRANSPORT_FAILED', {
                operation: method,
                retryable: true,
              }),
            ),
          );
        }
      });
    },
    receive(message: unknown) {
      const routing = routingForMalformedResponse(message);
      let response: HostRpcResponseMessage;
      try {
        response = parseHostRpcResponse(message, maxPayloadBytes);
      } catch {
        if (routing !== undefined) {
          const item = pending.get(routing.requestId);
          if (
            item !== undefined &&
            item.run.runId === routing.runId &&
            item.run.epoch === routing.runEpoch &&
            item.method === routing.method
          ) {
            pending.delete(routing.requestId);
            cancelTimer(item.timer);
            item.settle(
              new HostRpcError(
                createDiagnostic('JOY_AGENT_RPC_INVALID_RESPONSE', {
                  operation: routing.method,
                  retryable: false,
                }),
              ),
            );
          }
        }
        return false;
      }
      const item = pending.get(response.requestId);
      if (item === undefined) return false;
      if (
        item.run.runId !== response.runId ||
        item.run.epoch !== response.runEpoch ||
        item.method !== response.method
      ) {
        pending.delete(response.requestId);
        cancelTimer(item.timer);
        item.settle(
          new HostRpcError(
            createDiagnostic('JOY_AGENT_RPC_PROTOCOL_VIOLATION', {
              operation: item.method,
              retryable: false,
            }),
          ),
        );
        return false;
      }
      pending.delete(response.requestId);
      cancelTimer(item.timer);
      item.settle(response);
      return true;
    },
    cancelRun(run: HostRpcRun) {
      let safeRun: HostRpcRun;
      try {
        safeRun = parseRun(run);
      } catch {
        return;
      }
      if (epochByRun.get(safeRun.runId) !== safeRun.epoch || cancelledRuns.has(runKey(safeRun)))
        return;
      cancelledRuns.add(runKey(safeRun));
      cancelPending(
        safeRun,
        new HostRpcError(createDiagnostic('JOY_AGENT_RPC_CANCELLED', { retryable: false })),
      );
      sendCancellation(safeRun);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [requestId, item] of pending) {
        pending.delete(requestId);
        cancelTimer(item.timer);
        item.settle(
          new HostRpcError(createDiagnostic('JOY_AGENT_RPC_CANCELLED', { retryable: false })),
        );
      }
      epochByRun.clear();
      cancelledRuns.clear();
    },
  };
}
