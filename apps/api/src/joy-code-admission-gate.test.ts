import { describe, expect, it } from 'vitest';
import { JoyCodeAdmissionGate } from './joy-code-admission-gate.js';

describe('Joy Code admission gate', () => {
  it('allows one owner/project and rejects a duplicate in flight', () => {
    const gate = new JoyCodeAdmissionGate({ maxConcurrent: 1 });
    expect(gate.admit('owner', 'project', 0)).toEqual({ allowed: true });
    expect(gate.admit('owner', 'project', 1)).toEqual({
      allowed: false,
      code: 'JOY_CODE_IN_FLIGHT',
    });
    gate.release('owner', 'project');
    expect(gate.admit('owner', 'project', 2)).toEqual({ allowed: true });
  });
  it('enforces per-owner rate and daily limits', () => {
    const gate = new JoyCodeAdmissionGate({ perMinute: 2, perDay: 3 });
    expect(gate.admit('owner', 'p1', 0)).toEqual({ allowed: true });
    gate.release('owner', 'p1');
    expect(gate.admit('owner', 'p2', 1)).toEqual({ allowed: true });
    gate.release('owner', 'p2');
    expect(gate.admit('owner', 'p3', 2)).toEqual({ allowed: false, code: 'JOY_CODE_RATE_LIMIT' });
    expect(gate.admit('other', 'p3', 2)).toEqual({ allowed: true });
    gate.release('other', 'p3');
  });
  it('opens a circuit after provider failures and resets after cooldown', () => {
    const gate = new JoyCodeAdmissionGate({ failureThreshold: 2, circuitCooldownMs: 10 });
    expect(gate.admit('owner', 'p', 0)).toEqual({ allowed: true });
    gate.release('owner', 'p');
    gate.recordOutcome('provider-failed', 1);
    expect(gate.admit('owner', 'p', 2)).toEqual({ allowed: true });
    gate.release('owner', 'p');
    gate.recordOutcome('provider-failed', 3);
    expect(gate.admit('owner', 'p', 4)).toEqual({ allowed: false, code: 'JOY_CODE_CIRCUIT_OPEN' });
    expect(gate.admit('owner', 'p', 14)).toEqual({ allowed: true });
  });
  it('resets circuit failures on a successful outcome', () => {
    const gate = new JoyCodeAdmissionGate({ failureThreshold: 2 });
    gate.recordOutcome('provider-failed', 0);
    gate.recordOutcome('ready', 1);
    expect(gate.admit('owner', 'p', 2)).toEqual({ allowed: true });
  });
});
