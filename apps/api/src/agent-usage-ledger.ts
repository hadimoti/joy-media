import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface RecordAgentUsageInput {
  readonly ownerId: string;
  readonly modelId: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly upstreamCostMicros: bigint;
  readonly billedCostMicros: bigint;
  readonly commissionRateBps: number;
  readonly estimated?: boolean;
  readonly generationId?: string;
}

export interface AgentUsageSummary {
  readonly ownerId: string;
  readonly totalPromptTokens: number;
  readonly totalCompletionTokens: number;
  readonly totalUpstreamCostMicros: string;
  readonly totalBilledCostMicros: string;
  readonly totalRequests: number;
}

export interface AgentUsageLedger {
  record(input: RecordAgentUsageInput): Promise<string>;
  reserveSpend(
    ownerId: string,
    dayStart: Date,
    amountMicros: bigint,
    capMicros: bigint,
  ): Promise<string>;
  settleSpend(reservationId: string, input: RecordAgentUsageInput): Promise<string>;
  releaseSpend(reservationId: string): Promise<void>;
  getSummary(ownerId: string): Promise<AgentUsageSummary>;
  getDailyBilledCostMicros(ownerId: string, dayStart: Date): Promise<bigint>;
  replaceEstimate?(
    id: string,
    input: Pick<
      RecordAgentUsageInput,
      'promptTokens' | 'completionTokens' | 'upstreamCostMicros' | 'billedCostMicros'
    >,
  ): Promise<void>;
}

export class PostgresAgentUsageLedger implements AgentUsageLedger {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordAgentUsageInput): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO agent_usage (
        id, owner_id, model_id, prompt_tokens, completion_tokens,
        upstream_cost_micros, billed_cost_micros, commission_rate_bps, created_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9::jsonb)`,
      [
        id,
        input.ownerId,
        input.modelId,
        input.promptTokens,
        input.completionTokens,
        input.upstreamCostMicros.toString(),
        input.billedCostMicros.toString(),
        input.commissionRateBps,
        JSON.stringify({
          estimated: input.estimated === true,
          ...(input.generationId ? { generationId: input.generationId } : {}),
        }),
      ],
    );
    return id;
  }

  async reserveSpend(
    ownerId: string,
    dayStart: Date,
    amountMicros: bigint,
    capMicros: bigint,
  ): Promise<string> {
    const client = await this.pool.connect();
    const id = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        ownerId,
        dayStart.toISOString().slice(0, 10),
      ]);
      const totals = await client.query<{ spent: string; reserved: string }>(
        `SELECT
          (SELECT COALESCE(SUM(billed_cost_micros), 0)::text FROM agent_usage WHERE owner_id = $1 AND created_at >= $2) AS spent,
          (SELECT COALESCE(SUM(amount_micros), 0)::text FROM agent_usage_reservations WHERE owner_id = $1 AND day_start = $2) AS reserved`,
        [ownerId, dayStart],
      );
      const row = totals.rows[0];
      if (BigInt(row?.spent ?? '0') + BigInt(row?.reserved ?? '0') + amountMicros > capMicros) {
        await client.query('ROLLBACK');
        throw new Error('DAILY_SPEND_CAP_REACHED');
      }
      await client.query(
        'INSERT INTO agent_usage_reservations (id, owner_id, day_start, amount_micros) VALUES ($1, $2, $3, $4)',
        [id, ownerId, dayStart, amountMicros.toString()],
      );
      await client.query('COMMIT');
      return id;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* transaction already closed */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async settleSpend(reservationId: string, input: RecordAgentUsageInput): Promise<string> {
    const client = await this.pool.connect();
    const id = randomUUID();
    try {
      await client.query('BEGIN');
      const deleted = await client.query(
        'DELETE FROM agent_usage_reservations WHERE id = $1 AND owner_id = $2 RETURNING id',
        [reservationId, input.ownerId],
      );
      if (deleted.rowCount !== 1) throw new Error('SPEND_RESERVATION_MISSING');
      await client.query(
        `INSERT INTO agent_usage (id, owner_id, model_id, prompt_tokens, completion_tokens, upstream_cost_micros, billed_cost_micros, commission_rate_bps, created_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9::jsonb)`,
        [
          id,
          input.ownerId,
          input.modelId,
          input.promptTokens,
          input.completionTokens,
          input.upstreamCostMicros.toString(),
          input.billedCostMicros.toString(),
          input.commissionRateBps,
          JSON.stringify({
            estimated: input.estimated === true,
            ...(input.generationId ? { generationId: input.generationId } : {}),
          }),
        ],
      );
      await client.query('COMMIT');
      return id;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* transaction already closed */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseSpend(reservationId: string): Promise<void> {
    await this.pool.query('DELETE FROM agent_usage_reservations WHERE id = $1', [reservationId]);
  }

  async getDailyBilledCostMicros(ownerId: string, dayStart: Date): Promise<bigint> {
    const result = await this.pool.query<{ total: string | null }>(
      'SELECT COALESCE(SUM(billed_cost_micros), 0)::text AS total FROM agent_usage WHERE owner_id = $1 AND created_at >= $2',
      [ownerId, dayStart],
    );
    return BigInt(result.rows[0]?.total ?? '0');
  }

  async replaceEstimate(
    id: string,
    input: Pick<
      RecordAgentUsageInput,
      'promptTokens' | 'completionTokens' | 'upstreamCostMicros' | 'billedCostMicros'
    >,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE agent_usage SET prompt_tokens = $2, completion_tokens = $3,
       upstream_cost_micros = $4, billed_cost_micros = $5,
       metadata = metadata || '{"estimated":false}'::jsonb WHERE id = $1 AND metadata->>'estimated' = 'true'`,
      [
        id,
        input.promptTokens,
        input.completionTokens,
        input.upstreamCostMicros.toString(),
        input.billedCostMicros.toString(),
      ],
    );
  }

  async getSummary(ownerId: string): Promise<AgentUsageSummary> {
    const result = await this.pool.query<{
      total_prompt_tokens: string | null;
      total_completion_tokens: string | null;
      total_upstream_cost_micros: string | null;
      total_billed_cost_micros: string | null;
      total_requests: string | null;
    }>(
      `SELECT
        COALESCE(SUM(prompt_tokens), 0)::text AS total_prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::text AS total_completion_tokens,
        COALESCE(SUM(upstream_cost_micros), 0)::text AS total_upstream_cost_micros,
        COALESCE(SUM(billed_cost_micros), 0)::text AS total_billed_cost_micros,
        COUNT(*)::text AS total_requests
       FROM agent_usage
       WHERE owner_id = $1`,
      [ownerId],
    );
    const row = result.rows[0];
    return {
      ownerId,
      totalPromptTokens: Number(row?.total_prompt_tokens ?? '0'),
      totalCompletionTokens: Number(row?.total_completion_tokens ?? '0'),
      totalUpstreamCostMicros: row?.total_upstream_cost_micros ?? '0',
      totalBilledCostMicros: row?.total_billed_cost_micros ?? '0',
      totalRequests: Number(row?.total_requests ?? '0'),
    };
  }
}

export class MemoryAgentUsageLedger implements AgentUsageLedger {
  private readonly records: (RecordAgentUsageInput & { id: string; createdAt: Date })[] = [];
  private readonly reservations = new Map<
    string,
    { ownerId: string; dayStart: Date; amountMicros: bigint }
  >();

  async reserveSpend(
    ownerId: string,
    dayStart: Date,
    amountMicros: bigint,
    capMicros: bigint,
  ): Promise<string> {
    const spent = this.records
      .filter((record) => record.ownerId === ownerId && record.createdAt >= dayStart)
      .reduce((sum, record) => sum + record.billedCostMicros, 0n);
    const reserved = [...this.reservations.values()]
      .filter((item) => item.ownerId === ownerId && item.dayStart.getTime() === dayStart.getTime())
      .reduce((sum, item) => sum + item.amountMicros, 0n);
    if (spent + reserved + amountMicros > capMicros) throw new Error('DAILY_SPEND_CAP_REACHED');
    const id = randomUUID();
    this.reservations.set(id, { ownerId, dayStart, amountMicros });
    return id;
  }

  async settleSpend(reservationId: string, input: RecordAgentUsageInput): Promise<string> {
    if (!this.reservations.has(reservationId)) throw new Error('SPEND_RESERVATION_MISSING');
    this.reservations.delete(reservationId);
    return this.record(input);
  }

  async releaseSpend(reservationId: string): Promise<void> {
    this.reservations.delete(reservationId);
  }

  async record(input: RecordAgentUsageInput): Promise<string> {
    const id = randomUUID();
    this.records.push({ ...input, id, createdAt: new Date() });
    return id;
  }

  async getSummary(ownerId: string): Promise<AgentUsageSummary> {
    const owned = this.records.filter((r) => r.ownerId === ownerId);
    let promptTokens = 0;
    let completionTokens = 0;
    let upstream = 0n;
    let billed = 0n;
    for (const r of owned) {
      promptTokens += r.promptTokens;
      completionTokens += r.completionTokens;
      upstream += r.upstreamCostMicros;
      billed += r.billedCostMicros;
    }
    return {
      ownerId,
      totalPromptTokens: promptTokens,
      totalCompletionTokens: completionTokens,
      totalUpstreamCostMicros: upstream.toString(),
      totalBilledCostMicros: billed.toString(),
      totalRequests: owned.length,
    };
  }

  async getDailyBilledCostMicros(ownerId: string, dayStart: Date): Promise<bigint> {
    return this.records
      .filter((record) => record.ownerId === ownerId && record.createdAt >= dayStart)
      .reduce((total, record) => total + record.billedCostMicros, 0n);
  }

  async replaceEstimate(
    id: string,
    input: Pick<
      RecordAgentUsageInput,
      'promptTokens' | 'completionTokens' | 'upstreamCostMicros' | 'billedCostMicros'
    >,
  ): Promise<void> {
    const index = this.records.findIndex((record) => record.id === id && record.estimated === true);
    if (index >= 0) this.records[index] = { ...this.records[index]!, ...input, estimated: false };
  }
}
