import { describe, expect, it } from 'vitest';
import type { SubscriptionInfo } from './api.js';
import { periodEndLabel, planLabel } from './subscription-labels.js';

const sub = (plan: SubscriptionInfo['plan'], currentPeriodEnd?: number): SubscriptionInfo => ({
  ownerId: 'o',
  plan,
  status: plan === 'none' ? 'none' : 'active',
  ...(currentPeriodEnd === undefined ? {} : { currentPeriodEnd }),
});

describe('#16 subscription labels', () => {
  it('never shows "Lifetime / No Expiry" next to a paid plan', () => {
    expect(planLabel(sub('yearly'))).toBe('JOY Pro Yearly');
    expect(periodEndLabel(sub('yearly'))).toBe('Period end not available');
    expect(periodEndLabel(sub('monthly'))).not.toMatch(/lifetime|no expiry/i);
  });

  it('shows the period end when the server sends it', () => {
    expect(periodEndLabel(sub('yearly', 1_800_000_000_000), () => '2027-01-15')).toBe('2027-01-15');
  });

  it('describes the free plan without implying a paid lifetime licence', () => {
    expect(planLabel(sub('none'))).toBe('Standard Creator');
    expect(periodEndLabel(sub('none'))).toBe('No paid plan (local editing never expires)');
    expect(periodEndLabel(null)).toBe('No paid plan (local editing never expires)');
  });
});
