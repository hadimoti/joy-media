/**
 * USD catalog and exact USD -> USDC base-unit conversion (JOY Media desktop migration,
 * wave 5). Locked owner decisions: "Prices are USD. Settlement is USDC only on Ethereum
 * mainnet ... Use exact integer base units."
 *
 * **The prices below are placeholders, not an approved price list.** The lead brief locks
 * "one paid plan with monthly and yearly billing" and "Prices are USD" but names no amount.
 * Rather than invent a real-looking number, the placeholder is exactly `$0.00`: if checkout
 * were ever reached with this default in place, every invoice would require a real on-chain
 * transfer of zero USDC to confirm, which no real payment produces — a defensive fail-safe,
 * not just a marker. Real pricing must be supplied via
 * `JOY_MEDIA_USDC_MONTHLY_PRICE_USD`/`JOY_MEDIA_USDC_YEARLY_PRICE_USD` before checkout is ever
 * enabled (see usdc-checkout-service.ts's `JOY_MEDIA_USDC_CHECKOUT_ENABLED` gate).
 */

export type BillingPlan = 'monthly' | 'yearly';

/** USDC's canonical decimal precision on every chain it's deployed to. */
export const USDC_DECIMALS = 6;

const PLACEHOLDER_MONTHLY_USD = '0.00';
const PLACEHOLDER_YEARLY_USD = '0.00';

export interface CatalogPrice {
  readonly plan: BillingPlan;
  /** Decimal USD string, e.g. "12.00" — never a float, to keep the USD->USDC conversion exact. */
  readonly usd: string;
}

export class CatalogError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

export function resolveCatalog(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly CatalogPrice[] {
  return [
    { plan: 'monthly', usd: env['JOY_MEDIA_USDC_MONTHLY_PRICE_USD'] ?? PLACEHOLDER_MONTHLY_USD },
    { plan: 'yearly', usd: env['JOY_MEDIA_USDC_YEARLY_PRICE_USD'] ?? PLACEHOLDER_YEARLY_USD },
  ];
}

export function priceForPlan(
  plan: BillingPlan,
  catalog: readonly CatalogPrice[] = resolveCatalog(),
): CatalogPrice {
  const price = catalog.find((entry) => entry.plan === plan);
  if (price === undefined) {
    throw new CatalogError('PLAN_NOT_IN_CATALOG', `no catalog price for plan "${plan}"`);
  }
  return price;
}

const USD_AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Exact decimal parsing — no `Number()`/float math anywhere in this path, so a price like
 * "0.10" can never round to a wrong base-unit count the way IEEE-754 division sometimes would.
 */
export function usdToUsdcBaseUnits(usd: string): bigint {
  const match = USD_AMOUNT_PATTERN.exec(usd.trim());
  if (match === null) {
    throw new CatalogError('USD_AMOUNT_INVALID', `"${usd}" is not a valid USD decimal amount`);
  }
  const whole = BigInt(match[1] as string);
  const centsText = (match[2] ?? '').padEnd(2, '0');
  const cents = BigInt(centsText);
  // USDC has 6 decimals; USD cents are 2 decimals, so cents scale by 10^4 to reach base units.
  return whole * 10n ** BigInt(USDC_DECIMALS) + cents * 10n ** BigInt(USDC_DECIMALS - 2);
}
