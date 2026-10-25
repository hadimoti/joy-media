import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SANDBOX_SESSION_PURPOSE,
  SANDBOX_USER,
  decideDisposableEnvironment,
} from './disposable-host.mjs';

const nonce = '0123456789abcdef0123456789abcdef';
const sandboxEnv = { JOY_MEDIA_SANDBOX_NONCE: nonce };
// A genuine sandbox session: a virtual machine, the sandbox account and profile, and the session file for this launch.
const sandboxFacts = {
  hostname: 'a1b2c3d4e5f6',
  manufacturer: 'Microsoft Corporation',
  model: 'Virtual Machine',
  marker: null,
  userName: SANDBOX_USER,
  profile: `C:\\Users\\${SANDBOX_USER}`,
  sandboxSession: { purpose: SANDBOX_SESSION_PURPOSE, nonce },
};
const decide = (env, facts) => decideDisposableEnvironment({ platform: 'win32', env, facts });

test('accepts a Windows Sandbox session whose nonce matches its own launch', () => {
  assert.deepEqual(decide(sandboxEnv, sandboxFacts), {
    allowed: true,
    environment: 'windows-sandbox',
    reasons: [],
  });
});

test('refuses when the launch nonce differs from the session file (negative control)', () => {
  const other = { JOY_MEDIA_SANDBOX_NONCE: 'fedcba9876543210fedcba9876543210' };
  assert.equal(decide(other, sandboxFacts).allowed, false);
});

test('refuses when the session file or the launch nonce is missing or malformed', () => {
  assert.equal(decide(sandboxEnv, { ...sandboxFacts, sandboxSession: null }).allowed, false);
  assert.equal(decide({}, sandboxFacts).allowed, false);
  const malformed = 'not-a-nonce';
  assert.equal(
    decide(
      { JOY_MEDIA_SANDBOX_NONCE: malformed },
      { ...sandboxFacts, sandboxSession: { purpose: SANDBOX_SESSION_PURPOSE, nonce: malformed } },
    ).allowed,
    false,
  );
});

test('refuses the sandbox account name on a physical machine (negative control)', () => {
  const physical = {
    ...sandboxFacts,
    manufacturer: 'ASUSTeK COMPUTER INC.',
    model: 'System Product Name',
  };
  assert.equal(decide(sandboxEnv, physical).allowed, false);
});

test('refuses a session that is not the sandbox account or profile', () => {
  assert.equal(
    decide(sandboxEnv, { ...sandboxFacts, profile: 'C:\\Users\\example-user' }).allowed,
    false,
  );
  assert.equal(decide(sandboxEnv, { ...sandboxFacts, userName: 'example-user' }).allowed, false);
});

test('the PowerShell gate carries the same sandbox rule as the Node gate', () => {
  const gate = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'disposable-environment.ps1'),
    'utf8',
  );
  for (const literal of [
    SANDBOX_USER,
    SANDBOX_SESSION_PURPOSE,
    'JOY-Staging\\session.json',
    'JOY_MEDIA_SANDBOX_NONCE',
  ]) {
    assert.ok(gate.includes(literal), `the PowerShell gate must contain ${literal}`);
  }
});
