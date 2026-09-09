/**
 * Host RPC methods for the deterministic Living Look intent tools (R2 / GAP 5).
 *
 * `look_apply` / `look_update` / `look_reset_overrides` / `look_detach` parse the
 * model's bounded intent into the SAME `LivingLooksRunInput` the panel emits and
 * hand it to a `prepareLook` callback the trusted main-thread host owns. That
 * callback resolves the definition, compiles the Look and stages a reversible
 * preview through the shared `validate_proposal` staging handler — every lease,
 * stale-revision and host-authority check applies identically, and an agent
 * detach stages for approval rather than committing.
 */

import type { LivingLooksRunInput } from '../LivingLooksPanel.js';
import {
  HostRpcDiagnosticError,
  type HostRpcHandlerContext,
  type HostRpcJson,
  type HostRpcMethod,
  type HostRpcMethods,
} from './host-rpc.js';
import type { JoyAgentPreparedHostResult } from './tool-bridge.js';

const LOOK_ID = /^[a-z][a-z0-9-]{1,63}$/;
const LOOK_INSTANCE_ID = /^look-[A-Za-z0-9][A-Za-z0-9-]{7,64}$/;
const LOOK_BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOOK_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const LOOK_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MAP_ENTRIES = 32;
const MAX_STRING_VALUE = 120;

export type PrepareLookHandler = (
  request: LivingLooksRunInput,
  context: HostRpcHandlerContext,
) => Promise<JoyAgentPreparedHostResult> | JoyAgentPreparedHostResult;

function invalid(field: string): never {
  throw new HostRpcDiagnosticError({
    code: 'JOY_AGENT_RPC_INVALID_REQUEST',
    retryable: true,
    field,
  });
}

function isRecord(value: HostRpcJson): value is { readonly [key: string]: HostRpcJson } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStringMap(
  value: HostRpcJson | undefined,
  field: string,
  keyPattern: RegExp,
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!isRecord(value)) invalid(field);
  const entries = Object.entries(value);
  if (entries.length > MAX_MAP_ENTRIES) invalid(field);
  const out: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!keyPattern.test(key)) invalid(`${field}.${key}`);
    if (typeof raw !== 'string' || raw.length === 0 || !LOOK_ENTITY_ID.test(raw))
      invalid(`${field}.${key}`);
    out[key] = raw;
  }
  return out;
}

function parseControlValues(
  value: HostRpcJson | undefined,
  field: string,
): Readonly<Record<string, number | string | boolean>> {
  if (value === undefined) return {};
  if (!isRecord(value)) invalid(field);
  const entries = Object.entries(value);
  if (entries.length > MAX_MAP_ENTRIES) invalid(field);
  const out: Record<string, number | string | boolean> = {};
  for (const [key, raw] of entries) {
    if (!LOOK_KEY_ID.test(key)) invalid(`${field}.${key}`);
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) invalid(`${field}.${key}`);
      out[key] = raw;
    } else if (typeof raw === 'string') {
      if (raw.length > MAX_STRING_VALUE) invalid(`${field}.${key}`);
      out[key] = raw;
    } else if (typeof raw === 'boolean') {
      out[key] = raw;
    } else {
      invalid(`${field}.${key}`);
    }
  }
  return out;
}

function parseInstanceId(value: HostRpcJson | undefined): string {
  if (typeof value !== 'string' || !LOOK_INSTANCE_ID.test(value)) invalid('instanceId');
  return value;
}

export function parseLookApplyArgs(
  value: HostRpcJson,
): Extract<LivingLooksRunInput, { kind: 'apply' }> {
  if (!isRecord(value)) invalid('apply');
  const { definitionId, entityBindings, controlValues } = value;
  if (typeof definitionId !== 'string' || !LOOK_ID.test(definitionId)) invalid('definitionId');
  return {
    kind: 'apply',
    definitionId,
    // The host pins the real definition version from the catalogue; the model
    // never supplies it.
    definitionVersion: 0,
    entityBindings: parseStringMap(entityBindings ?? {}, 'entityBindings', LOOK_KEY_ID),
    controlValues: parseControlValues(controlValues ?? {}, 'controlValues'),
  };
}

export function parseLookUpdateArgs(
  value: HostRpcJson,
): Extract<LivingLooksRunInput, { kind: 'update' }> {
  if (!isRecord(value)) invalid('update');
  const hasControls = value.nextControlValues !== undefined;
  const hasBindings = value.nextEntityBindings !== undefined;
  if (!hasControls && !hasBindings) invalid('update');
  return {
    kind: 'update',
    instanceId: parseInstanceId(value.instanceId),
    ...(hasControls
      ? { nextControlValues: parseControlValues(value.nextControlValues, 'nextControlValues') }
      : {}),
    ...(hasBindings
      ? {
          nextEntityBindings: parseStringMap(
            value.nextEntityBindings,
            'nextEntityBindings',
            LOOK_KEY_ID,
          ),
        }
      : {}),
  };
}

export function parseLookResetArgs(
  value: HostRpcJson,
): Extract<LivingLooksRunInput, { kind: 'reset' }> {
  if (!isRecord(value)) invalid('reset');
  const { bindingIds } = value;
  if (!Array.isArray(bindingIds) || bindingIds.length === 0 || bindingIds.length > 64)
    invalid('bindingIds');
  const parsed = bindingIds.map((id) => {
    if (typeof id !== 'string' || !LOOK_BINDING_ID.test(id)) invalid('bindingIds');
    return id;
  });
  return { kind: 'reset', instanceId: parseInstanceId(value.instanceId), bindingIds: parsed };
}

export function parseLookDetachArgs(
  value: HostRpcJson,
): Extract<LivingLooksRunInput, { kind: 'detach' }> {
  if (!isRecord(value)) invalid('detach');
  return { kind: 'detach', instanceId: parseInstanceId(value.instanceId) };
}

function parsePreparedResult(value: HostRpcJson): JoyAgentPreparedHostResult {
  if (
    !isRecord(value) ||
    typeof value.summary !== 'string' ||
    value.summary.length > 512 ||
    typeof value.baseRevision !== 'string' ||
    typeof value.changeSetId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value.changeSetId) ||
    typeof value.operationDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.operationDigest) ||
    typeof value.bindingDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.bindingDigest) ||
    typeof value.operationCount !== 'number' ||
    !Number.isSafeInteger(value.operationCount) ||
    value.operationCount <= 0 ||
    value.operationCount > 32
  )
    throw new HostRpcDiagnosticError({
      code: 'JOY_AGENT_RPC_INVALID_REQUEST',
      retryable: false,
      field: 'result',
    });
  return {
    summary: value.summary,
    baseRevision: value.baseRevision,
    changeSetId: value.changeSetId,
    operationDigest: value.operationDigest,
    bindingDigest: value.bindingDigest,
    operationCount: value.operationCount,
  };
}

function lookMethod<A>(
  parseArgs: (value: HostRpcJson) => A,
  prepareLook: PrepareLookHandler,
): HostRpcMethod<A, JoyAgentPreparedHostResult> {
  return {
    parseArgs,
    execute: async (args, context) => {
      context.signal.throwIfAborted();
      try {
        return await prepareLook(args as unknown as LivingLooksRunInput, context);
      } catch (error) {
        if (error instanceof HostRpcDiagnosticError) throw error;
        const compilerCode =
          error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : 'JOY_AGENT_LOOK_STAGING_REJECTED';
        throw new HostRpcDiagnosticError({
          code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
          retryable: compilerCode !== 'JOY_CODE_STALE_REVISION',
          operation: 'look_intent',
          facts: { compilerCode },
        });
      }
    },
    parseResult: parsePreparedResult,
  };
}

/** The four `look_*` host methods, ready to merge into the host method map. */
export function createLookHostRpcMethods(prepareLook: PrepareLookHandler): HostRpcMethods {
  return {
    look_apply: lookMethod(parseLookApplyArgs, prepareLook) as HostRpcMethod<unknown, unknown>,
    look_update: lookMethod(parseLookUpdateArgs, prepareLook) as HostRpcMethod<unknown, unknown>,
    look_reset_overrides: lookMethod(parseLookResetArgs, prepareLook) as HostRpcMethod<
      unknown,
      unknown
    >,
    look_detach: lookMethod(parseLookDetachArgs, prepareLook) as HostRpcMethod<unknown, unknown>,
  };
}
