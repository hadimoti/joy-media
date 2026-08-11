import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it, vi } from 'vitest';
import type { SpectralDenoiseRequest, SpectralDenoiseResult } from './spectral-denoise.js';
import {
  MemorySpectralDenoiseInvocationLedger,
  PostgresSpectralDenoiseInvocationLedger,
  SpectralDenoiseService,
} from './spectral-denoise-service.js';

describe('SpectralDenoiseService durable idempotency', () => {
  it('allows one atomic claim and replays the accepted result without invoking twice', async () => {
    let finish: ((result: SpectralDenoiseResult) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<SpectralDenoiseResult>((resolve) => {
          finish = resolve;
        }),
    );
    const service = new SpectralDenoiseService(new MemorySpectralDenoiseInvocationLedger(), {
      run,
      maxGlobalConcurrency: 2,
      maxPerOwnerConcurrency: 2,
    });
    const request = denoiseRequest('operation-1', 'asset-1');

    const first = service.run('owner-1', request);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await expect(service.run('owner-1', request)).rejects.toMatchObject({
      code: 'PROVIDER_BUSY',
      message: expect.stringContaining('already running'),
    });

    finish?.(denoiseResult('asset-1-clean'));
    await expect(first).resolves.toMatchObject({
      projectId: 'project-1',
      operationId: 'operation-1',
      status: 'succeeded',
      result: { assetId: 'asset-1-clean' },
    });
    await expect(service.run('owner-1', request)).resolves.toMatchObject({
      status: 'succeeded',
      result: { assetId: 'asset-1-clean' },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('survives a server/service restart in PostgreSQL and exposes the same recovery result', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const firstLedger = new PostgresSpectralDenoiseInvocationLedger(pool);
    await firstLedger.initialize();
    const firstRun = vi.fn(async () => denoiseResult('durable-clean'));
    const first = new SpectralDenoiseService(firstLedger, { run: firstRun });
    const request = denoiseRequest('durable-operation', 'durable-source');

    await expect(first.run('owner-1', request)).resolves.toMatchObject({
      status: 'succeeded',
      result: { assetId: 'durable-clean' },
    });

    const restartedRun = vi.fn(async () => denoiseResult('must-not-run'));
    const restarted = new SpectralDenoiseService(
      new PostgresSpectralDenoiseInvocationLedger(pool),
      { run: restartedRun },
    );
    await expect(
      restarted.find('owner-1', 'project-1', 'durable-operation'),
    ).resolves.toMatchObject({
      status: 'succeeded',
      result: { assetId: 'durable-clean', bytesBase64: 'Y2xlYW4=' },
    });
    await expect(restarted.run('owner-1', request)).resolves.toMatchObject({
      status: 'succeeded',
      result: { assetId: 'durable-clean' },
    });
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(restartedRun).not.toHaveBeenCalled();
    await pool.end();
  });

  it('rejects conflicting input that reuses a completed operation ID', async () => {
    const service = new SpectralDenoiseService(new MemorySpectralDenoiseInvocationLedger(), {
      run: async () => denoiseResult('clean'),
    });
    await service.run('owner-1', denoiseRequest('operation-1', 'asset-1'));

    await expect(
      service.run('owner-1', denoiseRequest('operation-1', 'different-asset')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('reclaims an expired in-memory crash lease and fences the abandoned invocation', async () => {
    let now = 1_000;
    let finishAbandoned: ((result: SpectralDenoiseResult) => void) | undefined;
    const ledger = new MemorySpectralDenoiseInvocationLedger({
      now: () => now,
    });
    const abandonedRun = vi.fn(
      () =>
        new Promise<SpectralDenoiseResult>((resolve) => {
          finishAbandoned = resolve;
        }),
    );
    const abandonedService = new SpectralDenoiseService(ledger, {
      run: abandonedRun,
      leaseDurationMs: 5_000,
    });
    const request = denoiseRequest('crash-operation', 'crash-source');
    const abandoned = abandonedService.run('owner-1', request);
    await vi.waitFor(() => expect(abandonedRun).toHaveBeenCalledTimes(1));
    const running = await abandonedService.find('owner-1', 'project-1', 'crash-operation');
    expect(running).toMatchObject({ status: 'running', leaseExpiresAt: 6_000 });
    expect(running).not.toHaveProperty('leaseToken');

    const retryRun = vi.fn(async () => denoiseResult('reclaimed-clean'));
    const restartedService = new SpectralDenoiseService(ledger, {
      run: retryRun,
      leaseDurationMs: 5_000,
    });
    await expect(restartedService.run('owner-1', request)).rejects.toMatchObject({
      code: 'PROVIDER_BUSY',
    });
    expect(retryRun).not.toHaveBeenCalled();

    now += 5_001;
    await expect(restartedService.run('owner-1', request)).resolves.toMatchObject({
      status: 'succeeded',
      result: { assetId: 'reclaimed-clean' },
    });
    finishAbandoned?.(denoiseResult('abandoned-must-not-win'));
    await expect(abandoned).resolves.toMatchObject({
      status: 'succeeded',
      result: { assetId: 'reclaimed-clean' },
    });
    await expect(
      restartedService.find('owner-1', 'project-1', 'crash-operation'),
    ).resolves.toMatchObject({ result: { assetId: 'reclaimed-clean' } });
  });

  it('explicitly retries failed input with the same hash but rejects a mismatched retry', async () => {
    const run = vi
      .fn<(request: SpectralDenoiseRequest) => Promise<SpectralDenoiseResult>>()
      .mockRejectedValueOnce(new Error('provider process exited'))
      .mockResolvedValueOnce(denoiseResult('retried-clean'));
    const service = new SpectralDenoiseService(new MemorySpectralDenoiseInvocationLedger(), {
      run,
    });
    const request = denoiseRequest('failed-operation', 'failed-source');

    await expect(service.run('owner-1', request)).rejects.toThrow('provider process exited');
    await expect(service.find('owner-1', 'project-1', 'failed-operation')).resolves.toMatchObject({
      status: 'failed',
      error: 'provider process exited',
    });
    await expect(
      service.run('owner-1', denoiseRequest('failed-operation', 'different-source')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service.run('owner-1', request)).resolves.toMatchObject({
      status: 'succeeded',
      result: { assetId: 'retried-clean' },
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('PostgresSpectralDenoiseInvocationLedger lease transitions', () => {
  it('atomically reclaims only an expired same-hash lease across service processes', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const ledger = new PostgresSpectralDenoiseInvocationLedger(pool);
    await ledger.initialize();
    let finishAbandoned: ((result: SpectralDenoiseResult) => void) | undefined;
    const abandonedRun = vi.fn(
      () =>
        new Promise<SpectralDenoiseResult>((resolve) => {
          finishAbandoned = resolve;
        }),
    );
    const abandonedService = new SpectralDenoiseService(ledger, {
      run: abandonedRun,
      leaseDurationMs: 30_000,
    });
    const request = denoiseRequest('postgres-crash', 'postgres-source');
    const abandoned = abandonedService.run('owner-1', request);
    await vi.waitFor(() => expect(abandonedRun).toHaveBeenCalledTimes(1));

    const retryRun = vi.fn(async () => denoiseResult('postgres-reclaimed'));
    const restartedService = new SpectralDenoiseService(ledger, {
      run: retryRun,
      leaseDurationMs: 30_000,
    });
    await expect(restartedService.run('owner-1', request)).rejects.toMatchObject({
      code: 'PROVIDER_BUSY',
    });
    await pool.query(
      `UPDATE provider_audio_denoise_operations
       SET lease_expires_at = '2000-01-01T00:00:00.000Z'
       WHERE operation_id = 'postgres-crash'`,
    );
    await expect(restartedService.run('owner-1', request)).resolves.toMatchObject({
      status: 'succeeded',
      result: { assetId: 'postgres-reclaimed' },
    });
    finishAbandoned?.(denoiseResult('postgres-abandoned'));
    await expect(abandoned).resolves.toMatchObject({
      result: { assetId: 'postgres-reclaimed' },
    });
    expect(retryRun).toHaveBeenCalledTimes(1);
    await pool.end();
  });

  it('retries a durable failed row, keeps success immutable, and rejects hash mismatch', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const ledger = new PostgresSpectralDenoiseInvocationLedger(pool);
    await ledger.initialize();
    const failedRun = vi.fn(async () => {
      throw new Error('transient ffmpeg exit');
    });
    const request = denoiseRequest('postgres-failed', 'postgres-source');
    await expect(
      new SpectralDenoiseService(ledger, { run: failedRun }).run('owner-1', request),
    ).rejects.toThrow('transient ffmpeg exit');

    const retryRun = vi.fn(async () => denoiseResult('postgres-clean'));
    const restarted = new SpectralDenoiseService(ledger, { run: retryRun });
    await expect(
      restarted.run('owner-1', denoiseRequest('postgres-failed', 'different-source')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(restarted.run('owner-1', request)).resolves.toMatchObject({
      status: 'succeeded',
      result: { assetId: 'postgres-clean' },
    });
    await expect(restarted.run('owner-1', request)).resolves.toMatchObject({
      result: { assetId: 'postgres-clean' },
    });
    expect(failedRun).toHaveBeenCalledTimes(1);
    expect(retryRun).toHaveBeenCalledTimes(1);
    await pool.end();
  });
});

describe('SpectralDenoiseService concurrency boundary', () => {
  it('enforces both per-owner and global limits with an actionable busy error', async () => {
    const resolvers = new Map<string, (result: SpectralDenoiseResult) => void>();
    const run = vi.fn(
      (request: SpectralDenoiseRequest) =>
        new Promise<SpectralDenoiseResult>((resolve) => {
          resolvers.set(request.assetId, resolve);
        }),
    );
    const service = new SpectralDenoiseService(new MemorySpectralDenoiseInvocationLedger(), {
      run,
      maxGlobalConcurrency: 2,
      maxPerOwnerConcurrency: 1,
    });

    const ownerA = service.run('owner-a', denoiseRequest('operation-a', 'asset-a'));
    await vi.waitFor(() => expect(resolvers.has('asset-a')).toBe(true));
    await expect(
      service.run('owner-a', denoiseRequest('operation-a2', 'asset-a2')),
    ).rejects.toMatchObject({
      code: 'PROVIDER_BUSY',
      message: 'Cloud denoise is busy for this account; retry in a moment.',
    });

    const ownerB = service.run('owner-b', denoiseRequest('operation-b', 'asset-b'));
    await vi.waitFor(() => expect(resolvers.has('asset-b')).toBe(true));
    await expect(
      service.run('owner-c', denoiseRequest('operation-c', 'asset-c')),
    ).rejects.toMatchObject({ code: 'PROVIDER_BUSY' });

    resolvers.get('asset-a')?.(denoiseResult('asset-a-clean'));
    resolvers.get('asset-b')?.(denoiseResult('asset-b-clean'));
    await expect(Promise.all([ownerA, ownerB])).resolves.toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

function denoiseRequest(operationId: string, assetId: string) {
  return {
    projectId: 'project-1',
    operationId,
    assetId,
    mediaBase64: Buffer.from(`source:${assetId}`).toString('base64'),
    strength: 0.8,
  };
}

function denoiseResult(assetId: string): SpectralDenoiseResult {
  return {
    assetId,
    mimeType: 'audio/wav',
    bytesBase64: 'Y2xlYW4=',
    method: 'ffmpeg-afftdn',
    strength: 0.8,
  };
}
