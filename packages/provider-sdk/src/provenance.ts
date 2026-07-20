import type { Money, ProviderUsage, UsageRecord } from './types.js';
import { addMoney } from './utils.js';

const ZERO_USD: Money = { amount: '0.00', currency: 'USD' };

export function aggregateUsage(usages: readonly ProviderUsage[]): UsageRecord {
  if (usages.length === 0) {
    const now = new Date().toISOString();
    return {
      usages: [],
      totalCost: { ...ZERO_USD },
      periodStart: now,
      periodEnd: now,
    };
  }

  const timestamps = usages.map((u) => u.timestamp).sort();
  let totalCost: Money = { ...ZERO_USD };
  let currencySet = false;

  for (const u of usages) {
    if (u.cost) {
      if (!currencySet) {
        totalCost = { amount: '0.00', currency: u.cost.currency };
        currencySet = true;
      }
      totalCost = addMoney(totalCost, u.cost);
    }
  }

  return {
    usages,
    totalCost,
    periodStart: timestamps[0]!,
    periodEnd: timestamps[timestamps.length - 1]!,
  };
}
