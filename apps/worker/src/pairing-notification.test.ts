import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPairingNotification,
  createPairingNotificationWriter,
} from './pairing-notification.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Worker pairing notification hand-off', () => {
  it('writes an ephemeral owner-facing offer outside the diagnostic log', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-worker-pairing-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'notifications', 'pairing.json');
    const notify = createPairingNotificationWriter(path, () => 123);

    notify({ code: 'secret-code', expiresAt: 456 });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      kind: 'worker-pairing-required',
      code: 'secret-code',
      expiresAt: 456,
      createdAt: 123,
    });
    clearPairingNotification(path);
    expect(() => readFileSync(path)).toThrow();
  });
});
