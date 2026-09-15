import { describe, expect, it, vi } from 'vitest';
import {
  createLookHostRpcMethods,
  parseLookApplyArgs,
  parseLookDetachArgs,
  parseLookResetArgs,
  parseLookUpdateArgs,
} from './look-tool-bridge.js';
import type { HostRpcHandlerContext } from './host-rpc.js';

const INSTANCE_ID = 'look-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const prepared = {
  summary: 'Apply the "Editorial Clean" Look',
  baseRevision: 'rev-1',
  changeSetId: 'change-set-1',
  operationDigest: 'a'.repeat(64),
  bindingDigest: 'b'.repeat(64),
  operationCount: 3,
};

const rpcContext = {
  run: { runId: 'r1', epoch: 1 },
  requestId: 'req-1',
  signal: AbortSignal.timeout(30_000),
  deadlineAt: Date.now() + 30_000,
} as unknown as HostRpcHandlerContext;

describe('look-tool-bridge arg parsing (GAP 5)', () => {
  it('parses a well-formed apply intent and pins version to 0 for the host', () => {
    expect(
      parseLookApplyArgs({
        definitionId: 'editorial-clean',
        entityBindings: { headline: 'text-1' },
        controlValues: { energy: 0.6, 'caption-style': 'muted', bold: true },
      }),
    ).toEqual({
      kind: 'apply',
      definitionId: 'editorial-clean',
      definitionVersion: 0,
      entityBindings: { headline: 'text-1' },
      controlValues: { energy: 0.6, 'caption-style': 'muted', bold: true },
    });
  });

  it('rejects a bad pack id, non-string binding, and oversized map', () => {
    expect(() =>
      parseLookApplyArgs({ definitionId: 'Bad Id!', entityBindings: {}, controlValues: {} }),
    ).toThrow();
    expect(() =>
      parseLookApplyArgs({
        definitionId: 'editorial-clean',
        entityBindings: { s: 5 },
        controlValues: {},
      }),
    ).toThrow();
    const huge = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, i]));
    expect(() =>
      parseLookApplyArgs({
        definitionId: 'editorial-clean',
        entityBindings: {},
        controlValues: huge,
      }),
    ).toThrow();
  });

  it('update requires at least one of nextControlValues / nextEntityBindings', () => {
    expect(() => parseLookUpdateArgs({ instanceId: INSTANCE_ID })).toThrow();
    expect(
      parseLookUpdateArgs({ instanceId: INSTANCE_ID, nextControlValues: { energy: 1 } }),
    ).toEqual({
      kind: 'update',
      instanceId: INSTANCE_ID,
      nextControlValues: { energy: 1 },
    });
    expect(
      parseLookUpdateArgs({ instanceId: INSTANCE_ID, nextEntityBindings: { headline: 'text-2' } }),
    ).toEqual({
      kind: 'update',
      instanceId: INSTANCE_ID,
      nextEntityBindings: { headline: 'text-2' },
    });
  });

  it('reset requires a non-empty bounded bindingIds array', () => {
    expect(() => parseLookResetArgs({ instanceId: INSTANCE_ID, bindingIds: [] })).toThrow();
    expect(parseLookResetArgs({ instanceId: INSTANCE_ID, bindingIds: ['b-1', 'b-2'] })).toEqual({
      kind: 'reset',
      instanceId: INSTANCE_ID,
      bindingIds: ['b-1', 'b-2'],
    });
  });

  it('detach requires a valid instance id', () => {
    expect(() => parseLookDetachArgs({ instanceId: 'nope' })).toThrow();
    expect(parseLookDetachArgs({ instanceId: INSTANCE_ID })).toEqual({
      kind: 'detach',
      instanceId: INSTANCE_ID,
    });
  });

  it('routes every look_* method through one prepareLook handler', async () => {
    const prepareLook = vi.fn(async () => prepared);
    const methods = createLookHostRpcMethods(prepareLook);
    for (const name of [
      'look_apply',
      'look_update',
      'look_reset_overrides',
      'look_detach',
    ] as const) {
      expect(methods[name]).toBeDefined();
    }
    const applyArgs = methods.look_apply!.parseArgs({
      definitionId: 'editorial-clean',
      entityBindings: {},
      controlValues: {},
    });
    const result = await methods.look_apply!.execute(applyArgs, rpcContext);
    expect(result).toEqual(prepared);
    expect(prepareLook).toHaveBeenCalledWith(
      {
        kind: 'apply',
        definitionId: 'editorial-clean',
        definitionVersion: 0,
        entityBindings: {},
        controlValues: {},
      },
      rpcContext,
    );
  });

  it('turns a plain host error into a retryable canonical rejection', async () => {
    const methods = createLookHostRpcMethods(async () => {
      throw new Error('LOOK_UNKNOWN_INSTANCE');
    });
    const args = methods.look_detach!.parseArgs({ instanceId: INSTANCE_ID });
    await expect(methods.look_detach!.execute(args, rpcContext)).rejects.toMatchObject({
      diagnostic: {
        code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
        facts: { compilerCode: 'LOOK_UNKNOWN_INSTANCE' },
      },
    });
  });
});
