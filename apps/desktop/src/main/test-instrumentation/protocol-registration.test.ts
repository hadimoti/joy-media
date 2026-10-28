import { describe, expect, it } from 'vitest';
import {
  disableProtocolRegistration,
  type ProtocolRegistrationTarget,
} from './protocol-registration.js';

describe('disableProtocolRegistration', () => {
  it('stops every later registration, and reports that none was made', () => {
    const calls: string[] = [];
    const target: ProtocolRegistrationTarget = {
      setAsDefaultProtocolClient: (protocol: string) => {
        calls.push(protocol);
        return true;
      },
    };
    disableProtocolRegistration(target);
    expect(target.setAsDefaultProtocolClient('joy', 'C:/app/joy-media.exe', [])).toBe(false);
    expect(calls).toEqual([]);
  });
});
