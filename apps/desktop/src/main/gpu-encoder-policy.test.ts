import { describe, expect, it } from 'vitest';
import {
  compareDriverVersions,
  decideEncoderPolicy,
  KNOWN_BAD_ENCODER_RANGES,
  type KnownBadEncoderRange,
} from './gpu-encoder-policy.js';

// Synthetic facts only. These rules are exercised with made-up IDs; no real device is named.
const NOW = '2026-10-26T12:00:00.000Z';
const ADAPTER = { vendorId: 0x1234, deviceId: 0x5678, driverVersion: '617.42' };
const RANGE: KnownBadEncoderRange = {
  id: 'synthetic-range',
  vendorId: 0x1234,
  deviceIds: [0x5678],
  lastBadDriver: '617.42',
  electronMajor: 44,
  expires: '2027-01-01T00:00:00.000Z',
};

describe('pre-emptive encoder policy', () => {
  it('keeps the hardware path while no range is known bad, which is the shipped state', () => {
    expect(KNOWN_BAD_ENCODER_RANGES).toEqual([]);
    expect(decideEncoderPolicy({ adapter: ADAPTER, electronMajor: 44, now: NOW })).toEqual({
      mode: 'hardware',
    });
  });

  it('switches only the Media Foundation encoder off for a matching adapter, driver and Electron major', () => {
    expect(
      decideEncoderPolicy({ adapter: ADAPTER, electronMajor: 44, now: NOW, ranges: [RANGE] }),
    ).toEqual({ mode: 'software-mf-off', reason: 'synthetic-range' });
  });

  it('stops applying once the driver moves past the last bad version', () => {
    const newer = { ...ADAPTER, driverVersion: '617.43' };
    expect(
      decideEncoderPolicy({ adapter: newer, electronMajor: 44, now: NOW, ranges: [RANGE] }),
    ).toEqual({ mode: 'hardware' });
  });

  it('does not apply to another device, vendor or Electron major', () => {
    for (const adapter of [
      { ...ADAPTER, deviceId: 0x9999 },
      { ...ADAPTER, vendorId: 0x4321 },
    ]) {
      expect(
        decideEncoderPolicy({ adapter, electronMajor: 44, now: NOW, ranges: [RANGE] }),
      ).toEqual({ mode: 'hardware' });
    }
    expect(
      decideEncoderPolicy({ adapter: ADAPTER, electronMajor: 45, now: NOW, ranges: [RANGE] }),
    ).toEqual({ mode: 'hardware' });
  });

  it('stops applying after the entry expires, so a stale entry cannot pin a device', () => {
    expect(
      decideEncoderPolicy({
        adapter: ADAPTER,
        electronMajor: 44,
        now: '2027-02-01T00:00:00.000Z',
        ranges: [RANGE],
      }),
    ).toEqual({ mode: 'hardware' });
  });
});

describe('driver version order', () => {
  it('compares dotted parts as numbers, not as text', () => {
    expect(compareDriverVersions('617.5', '617.42')).toBeLessThan(0);
    expect(compareDriverVersions('617.100', '617.99')).toBeGreaterThan(0);
    expect(compareDriverVersions('617.42', '617.42')).toBe(0);
    expect(compareDriverVersions('617.42.1', '617.42')).toBeGreaterThan(0);
  });
});
