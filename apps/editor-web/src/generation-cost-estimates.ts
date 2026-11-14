import type { GenerationKind } from '@joy-media/provider-sdk';

/**
 * The prices the generation cost card shows (T-C07).
 *
 * PLACEHOLDERS. T-C10 measures the real prices on the MiniMax API and has not run yet. Until it has, every number
 * below is a stand-in, and `measured` is false so the card says so next to the number. When T-C10 is done, replace
 * the three numbers, set `measured` to true and update the test. This is the only place that holds them.
 */
export const GENERATION_COST_ESTIMATES: {
  readonly measured: boolean;
  readonly usd: Readonly<Record<GenerationKind, number>>;
} = {
  measured: false,
  usd: {
    image: 0.01,
    video: 0.5,
  },
};

/** The price line of the cost card, for example "About $0.01". Adds the placeholder note until T-C10 has measured. */
export function generationCostLine(kind: GenerationKind): string {
  const amount = GENERATION_COST_ESTIMATES.usd[kind];
  const price = `About $${amount.toFixed(2)}`;
  return GENERATION_COST_ESTIMATES.measured ? price : `${price} (not measured yet)`;
}
