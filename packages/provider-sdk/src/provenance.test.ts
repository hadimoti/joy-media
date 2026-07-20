import { describe, expect, it } from 'vitest';
import { aggregateUsage } from './provenance.js';
import type { ProviderUsage } from './types.js';

describe('aggregateUsage', () => {
  it('returns empty record for empty usages', () => {
    const result = aggregateUsage([]);

    expect(result.usages).toEqual([]);
    expect(result.totalCost.amount).toBe('0.00');
    expect(result.totalCost.currency).toBe('USD');
    expect(result.periodStart).toBe(result.periodEnd);
  });

  it('aggregates costs from multiple usages', () => {
    const usages: ProviderUsage[] = [
      {
        providerId: 'p1',
        capability: 'speech.transcribe',
        modelId: 'model1',
        timestamp: '2024-01-01T00:00:00Z',
        durationMs: 1000,
        cost: { amount: '0.10', currency: 'USD' },
      },
      {
        providerId: 'p1',
        capability: 'speech.transcribe',
        modelId: 'model1',
        timestamp: '2024-01-01T01:00:00Z',
        durationMs: 2000,
        cost: { amount: '0.20', currency: 'USD' },
      },
    ];

    const result = aggregateUsage(usages);

    expect(result.totalCost.amount).toBe('0.30');
    expect(result.totalCost.currency).toBe('USD');
  });

  it('handles usages without costs', () => {
    const usages: ProviderUsage[] = [
      {
        providerId: 'p1',
        capability: 'speech.transcribe',
        modelId: 'model1',
        timestamp: '2024-01-01T00:00:00Z',
        durationMs: 1000,
      },
      {
        providerId: 'p1',
        capability: 'speech.transcribe',
        modelId: 'model1',
        timestamp: '2024-01-01T01:00:00Z',
        durationMs: 2000,
        cost: { amount: '0.15', currency: 'USD' },
      },
    ];

    const result = aggregateUsage(usages);

    expect(result.totalCost.amount).toBe('0.15');
  });

  it('sets correct period start and end', () => {
    const usages: ProviderUsage[] = [
      {
        providerId: 'p1',
        capability: 'speech.transcribe',
        modelId: 'model1',
        timestamp: '2024-01-02T00:00:00Z',
        durationMs: 1000,
      },
      {
        providerId: 'p1',
        capability: 'speech.transcribe',
        modelId: 'model1',
        timestamp: '2024-01-01T00:00:00Z',
        durationMs: 1000,
      },
      {
        providerId: 'p1',
        capability: 'speech.transcribe',
        modelId: 'model1',
        timestamp: '2024-01-03T00:00:00Z',
        durationMs: 1000,
      },
    ];

    const result = aggregateUsage(usages);

    expect(result.periodStart).toBe('2024-01-01T00:00:00Z');
    expect(result.periodEnd).toBe('2024-01-03T00:00:00Z');
  });

  it('preserves all usages in the record', () => {
    const usages: ProviderUsage[] = [
      {
        providerId: 'p1',
        capability: 'speech.transcribe',
        modelId: 'model1',
        timestamp: '2024-01-01T00:00:00Z',
        durationMs: 1000,
      },
      {
        providerId: 'p2',
        capability: 'image.generate',
        modelId: 'model2',
        timestamp: '2024-01-02T00:00:00Z',
        durationMs: 2000,
      },
    ];

    const result = aggregateUsage(usages);

    expect(result.usages).toHaveLength(2);
    expect(result.usages).toEqual(usages);
  });

  it('handles mixed currencies by using first currency', () => {
    const usages: ProviderUsage[] = [
      {
        providerId: 'p1',
        capability: 'speech.transcribe',
        modelId: 'model1',
        timestamp: '2024-01-01T00:00:00Z',
        durationMs: 1000,
        cost: { amount: '1.00', currency: 'USD' },
      },
      {
        providerId: 'p2',
        capability: 'speech.transcribe',
        modelId: 'model2',
        timestamp: '2024-01-02T00:00:00Z',
        durationMs: 1000,
        cost: { amount: '1.00', currency: 'EUR' },
      },
    ];

    // This should throw because currencies don't match
    expect(() => aggregateUsage(usages)).toThrow('Cannot add money with different currencies');
  });
});
