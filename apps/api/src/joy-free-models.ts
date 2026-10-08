/**
 * The hosted JOY Agent's zero-cost model allow-list (Round FC, revised in FC3 on 8 Oct 2026).
 *
 * The gateway serves and forwards only these ids; paid models cannot be enabled. Every id is an
 * OpenRouter ":free" variant with tool calling, and exactly one entry is the default.
 * - Text requests try the requested model, then the rest of this list in order.
 * - Requests with images go only to the vision entries (gemma-4-31b first, then nano-omni).
 * An attempt that is busy, gated or failing upstream falls back to the next candidate, never to
 * a model outside this list (see joy-model-gateway.ts for which upstream answers count).
 *
 * This file has no imports so `tooling/release/src/free-model-check.ts` can load it with
 * Node's type stripping and compare it with OpenRouter's public /models list.
 */

export interface JoyModelCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly contextLength: number;
  readonly vision: boolean;
  readonly isDefault?: boolean;
  /** A reasoning model: the gateway asks OpenRouter to leave its reasoning out of replies. */
  readonly reasoning?: boolean;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export const JOY_AGENT_FREE_MODELS: readonly JoyModelCatalogEntry[] = Object.freeze([
  Object.freeze({
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    displayName: 'Nemotron 3 Super (free)',
    description: 'Default. Text and tool calling at zero cost.',
    contextLength: 262144,
    vision: false,
    isDefault: true,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  }),
  Object.freeze({
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    displayName: 'Nemotron 3 Ultra (free)',
    description: 'Large text model with tool calling at zero cost.',
    contextLength: 1000000,
    vision: false,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  }),
  Object.freeze({
    id: 'cohere/north-mini-code:free',
    displayName: 'North Mini Code (free)',
    description: 'Compact text and code model with tool calling at zero cost.',
    contextLength: 256000,
    vision: false,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  }),
  Object.freeze({
    id: 'google/gemma-4-31b-it:free',
    displayName: 'Gemma 4 31B (free)',
    description: 'Vision and tool calling at zero cost. Requests with images try it first.',
    contextLength: 262144,
    vision: true,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  }),
  Object.freeze({
    id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    displayName: 'Nemotron 3 Nano Omni (free)',
    description:
      'Best-effort vision fallback with tool calling at zero cost. A reasoning model; its reasoning is not returned.',
    contextLength: 256000,
    vision: true,
    reasoning: true,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  }),
]);

/**
 * Throws unless every entry is an OpenRouter ":free" id with zero prices, ids are unique,
 * exactly one entry is the default and at least one accepts images. Run at module load, so a bad edit stops the API at startup
 * instead of forwarding a priced model as "free".
 */
export function assertFreeCatalog(catalog: readonly JoyModelCatalogEntry[]): void {
  if (catalog.length === 0) throw new Error('joy free catalog: no models');
  const seen = new Set<string>();
  for (const model of catalog) {
    if (!model.id.endsWith(':free'))
      throw new Error(`joy free catalog: ${model.id} is not an OpenRouter ":free" id`);
    if (model.inputUsdPerMillion !== 0 || model.outputUsdPerMillion !== 0)
      throw new Error(`joy free catalog: ${model.id} has a non-zero price`);
    if (seen.has(model.id)) throw new Error(`joy free catalog: ${model.id} is listed twice`);
    seen.add(model.id);
  }
  const defaults = catalog.filter((model) => model.isDefault === true).length;
  if (defaults !== 1)
    throw new Error(`joy free catalog: needs exactly one default model, found ${defaults}`);
  if (!catalog.some((model) => model.vision))
    throw new Error('joy free catalog: needs at least one vision model for image requests');
}

assertFreeCatalog(JOY_AGENT_FREE_MODELS);

/** Ids installed clients may still send; all resolve to the free default. */
export const JOY_AGENT_LEGACY_MODEL_IDS: readonly string[] = Object.freeze([
  'openrouter/free',
  'minimax/minimax-m3',
  'anthropic/claude-3.5-sonnet',
  'meta-llama/llama-3.3-70b-instruct',
]);
