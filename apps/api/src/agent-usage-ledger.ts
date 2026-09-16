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
  getSummary(ownerId: string): Promise<AgentUsageSummary>;
}

export class PostgresAgentUsageLedger implements AgentUsageLedger {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordAgentUsageInput): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO agent_usage (
        id, owner_id, model_id, prompt_tokens, completion_tokens,
        upstream_cost_micros, billed_cost_micros, commission_rate_bps, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
      [
        id,
        input.ownerId,
        input.modelId,
        input.promptTokens,
        input.completionTokens,
        input.upstreamCostMicros.toString(),
        input.billedCostMicros.toString(),
        input.commissionRateBps,
      ],
    );
    return id;
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
}
