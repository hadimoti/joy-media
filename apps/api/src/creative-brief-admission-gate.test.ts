import { describe, expect, it } from 'vitest';
import { CreativeBriefAdmissionGate } from './creative-brief-admission-gate.js';

describe('CreativeBriefAdmissionGate', () => {
  it('enforces one in-flight request per owner/project and releases it', () => {
    const gate = new CreativeBriefAdmissionGate({ maxConcurrent: 2 });

    expect(gate.admit('owner-1', 'project-1', 0)).toEqual({ allowed: true });
    expect(gate.admit('owner-1', 'project-1', 1)).toEqual({
      allowed: false,
      code: 'CREATIVE_BRIEF_IN_FLIGHT',
    });
    gate.release('owner-1', 'project-1');
    expect(gate.admit('owner-1', 'project-1', 2)).toEqual({ allowed: true });
  });

  it('enforces global concurrency independently of owner/project keys', () => {
    const gate = new CreativeBriefAdmissionGate({ maxConcurrent: 2 });

    expect(gate.admit('owner-1', 'project-1', 0)).toEqual({ allowed: true });
    expect(gate.admit('owner-2', 'project-2', 0)).toEqual({ allowed: true });
    expect(gate.admit('owner-3', 'project-3', 0)).toEqual({
      allowed: false,
      code: 'CREATIVE_BRIEF_CONCURRENCY_LIMIT',
    });
  });

  it('enforces three requests per owner per rolling minute', () => {
    const gate = new CreativeBriefAdmissionGate({ maxConcurrent: 10, perMinute: 3 });

    for (let i = 0; i < 3; i += 1) {
      expect(gate.admit('owner-1', `project-${i}`, i)).toEqual({ allowed: true });
      gate.release('owner-1', `project-${i}`);
    }
    expect(gate.admit('owner-1', 'project-3', 59_999)).toEqual({
      allowed: false,
      code: 'CREATIVE_BRIEF_RATE_LIMIT',
    });
    expect(gate.admit('owner-1', 'project-3', 60_000)).toEqual({ allowed: true });
  });

  it('enforces twenty requests per owner per day', () => {
    const gate = new CreativeBriefAdmissionGate({ maxConcurrent: 30, perMinute: 30, perDay: 20 });

    for (let i = 0; i < 20; i += 1) {
      expect(gate.admit('owner-1', `project-${i}`, i * 1000)).toEqual({ allowed: true });
      gate.release('owner-1', `project-${i}`);
    }
    expect(gate.admit('owner-1', 'project-20', 86_399_999)).toEqual({
      allowed: false,
      code: 'CREATIVE_BRIEF_DAILY_LIMIT',
    });
    expect(gate.admit('owner-1', 'project-20', 86_400_000)).toEqual({ allowed: true });
  });

  it('opens a circuit after repeated provider failures and closes after cooldown', () => {
    const gate = new CreativeBriefAdmissionGate({
      maxConcurrent: 2,
      failureThreshold: 3,
      circuitCooldownMs: 1000,
    });

    for (let i = 0; i < 3; i += 1) gate.recordOutcome('provider-failed');
    expect(gate.admit('owner-1', 'project-1', 0)).toEqual({
      allowed: false,
      code: 'CREATIVE_BRIEF_CIRCUIT_OPEN',
    });
    expect(gate.admit('owner-1', 'project-1', 1000)).toEqual({ allowed: true });
  });

  it('resets failure count after a successful outcome', () => {
    const gate = new CreativeBriefAdmissionGate({ failureThreshold: 2, maxConcurrent: 2 });

    gate.recordOutcome('provider-failed');
    gate.recordOutcome('ready');
    gate.recordOutcome('provider-failed');
    expect(gate.admit('owner-1', 'project-1', 0)).toEqual({ allowed: true });
  });

  it('does not expose actor/project identifiers in admission results', () => {
    const gate = new CreativeBriefAdmissionGate({ maxConcurrent: 1 });
    gate.admit('owner-secret', 'project-secret', 0);

    expect(JSON.stringify(gate.admit('owner-secret', 'project-secret', 1))).not.toContain('secret');
  });
});
