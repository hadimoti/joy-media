import type { SubscriptionInfo } from './api.js';

export function planLabel(subscription: SubscriptionInfo | null): string {
  if (subscription?.plan === 'monthly') return 'JOY Pro Monthly';
  if (subscription?.plan === 'yearly') return 'JOY Pro Yearly';
  return 'Standard Creator';
}

/**
 * The renewal cell. A paid plan never says "Lifetime / No Expiry" (#16): without a period end
 * from the server it says the date is not available.
 */
export function periodEndLabel(
  subscription: SubscriptionInfo | null,
  formatDate: (at: number) => string = (at) => new Date(at).toLocaleDateString(),
): string {
  if (subscription?.currentPeriodEnd) return formatDate(subscription.currentPeriodEnd);
  if (subscription?.plan === 'monthly' || subscription?.plan === 'yearly')
    return 'Period end not available';
  return 'No paid plan (local editing never expires)';
}
