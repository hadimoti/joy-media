export interface JoyAgentLimits {
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxConcurrentReads: number;
  readonly maxOperations: number;
  readonly wallTimeMs: number;
  readonly probeTimeMs: number;
  readonly probeMaxOutputTokens: number;
  readonly contextBytes: number;
  readonly toolPayloadBytes: number;
  readonly maxFrameReads: number;
  readonly providerResponseBytes: number;
  readonly maxOutputTokens: number;
}

export const DEFAULT_JOY_AGENT_LIMITS: JoyAgentLimits = Object.freeze({
  maxSteps: 12,
  maxToolCalls: 24,
  maxConcurrentReads: 2,
  maxOperations: 32,
  wallTimeMs: 180_000,
  probeTimeMs: 15_000,
  probeMaxOutputTokens: 512,
  contextBytes: 524_288,
  toolPayloadBytes: 65_536,
  maxFrameReads: 3,
  providerResponseBytes: 2_097_152,
  maxOutputTokens: 8_192,
});

/**
 * Apply user-selected limits without allowing a session to weaken a JOY
 * safety boundary. Invalid, non-finite, fractional, or non-positive values
 * use the default rather than becoming an accidental unlimited value.
 */
export function clampJoyAgentLimits(
  requested: Partial<JoyAgentLimits> | undefined,
): JoyAgentLimits {
  const candidate = requested ?? {};
  const entries = Object.entries(DEFAULT_JOY_AGENT_LIMITS).map(([key, maximum]) => {
    const requestedValue = candidate[key as keyof JoyAgentLimits];
    const value =
      typeof requestedValue === 'number' &&
      Number.isFinite(requestedValue) &&
      Number.isInteger(requestedValue) &&
      requestedValue > 0
        ? Math.min(requestedValue, maximum)
        : maximum;
    return [key, value] as const;
  });
  return Object.freeze(Object.fromEntries(entries) as JoyAgentLimits);
}
