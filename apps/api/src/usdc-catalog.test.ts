import { describe, expect, it } from 'vitest';
import { CatalogError, priceForPlan, resolveCatalog, usdToUsdcBaseUnits } from './usdc-catalog.js';

describe('resolveCatalog', () => {
  it('defaults every plan to the $0.00 placeholder when no env override is set', () => {
    expect(resolveCatalog({})).toEqual([
      { plan: 'monthly', usd: '0.00' },
      { plan: 'yearly', usd: '0.00' },
    ]);
  });

  it('reads real prices from the env overrides', () => {
    expect(
      resolveCatalog({
        JOY_MEDIA_USDC_MONTHLY_PRICE_USD: '12.00',
        JOY_MEDIA_USDC_YEARLY_PRICE_USD: '120.00',
      }),
    ).toEqual([
      { plan: 'monthly', usd: '12.00' },
      { plan: 'yearly', usd: '120.00' },
    ]);
  });
});

describe('priceForPlan', () => {
  it('finds the price for a plan in a given catalog', () => {
    const catalog = resolveCatalog({ JOY_MEDIA_USDC_MONTHLY_PRICE_USD: '9.99' });
    expect(priceForPlan('monthly', catalog)).toEqual({ plan: 'monthly', usd: '9.99' });
  });

  it('throws for a plan absent from the catalog', () => {
    expect(() => priceForPlan('monthly', [])).toThrow(CatalogError);
  });
});

describe('usdToUsdcBaseUnits', () => {
  it('converts a whole-dollar amount', () => {
    expect(usdToUsdcBaseUnits('12')).toBe(12_000_000n);
  });

  it('converts an amount with cents', () => {
    expect(usdToUsdcBaseUnits('12.34')).toBe(12_340_000n);
  });

  it('converts a single-decimal amount', () => {
    expect(usdToUsdcBaseUnits('0.1')).toBe(100_000n);
  });

  it('converts zero exactly', () => {
    expect(usdToUsdcBaseUnits('0.00')).toBe(0n);
  });

  it('converts a large amount without floating-point drift', () => {
    // 0.1 + 0.2 famously != 0.3 in IEEE-754; this path must never go through Number().
    expect(usdToUsdcBaseUnits('999999.99')).toBe(999_999_990_000n);
  });

  it('rejects more than two decimal places (USD has no smaller unit)', () => {
    expect(() => usdToUsdcBaseUnits('1.234')).toThrow();
  });

  it('rejects a negative amount', () => {
    expect(() => usdToUsdcBaseUnits('-1.00')).toThrow();
  });

  it('rejects a non-numeric string', () => {
    expect(() => usdToUsdcBaseUnits('abc')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => usdToUsdcBaseUnits('')).toThrow();
  });
});
