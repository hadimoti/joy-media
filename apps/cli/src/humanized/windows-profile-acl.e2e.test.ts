/**
 * Windows profile hardening must not rewrite files it does not own.
 *
 * On Windows a change to a directory's inheritable ACEs is propagated into every
 * existing descendant. Hardening `~/.joy-media` on every run therefore rewrote
 * the ACLs of each venv and model file. On a real profile (~126k entries) that
 * outran the 10 s icacls timeout, and `agent config` and `timeline add-clip`
 * failed with "Could not secure JOY Media configuration permissions".
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentSandbox, type AgentSandbox } from './agent-helpers.js';
import { describeRun } from './harness.js';

function icaclsOf(path: string): string {
  const r = spawnSync('icacls.exe', [path], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  expect(r.status, `icacls ${path}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

function currentUserSid(): string {
  const r = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  const sid = r.stdout.match(/S-1-[0-9-]+/)?.[0];
  if (!sid) throw new Error('Could not read the current user SID for the test.');
  return sid;
}

describe.skipIf(process.platform !== 'win32')(
  'Windows profile hardening leaves unrelated files alone',
  () => {
    let env: AgentSandbox;

    beforeEach(() => {
      env = createAgentSandbox('win-acl-scope');
    });
    afterEach(() => {
      env.cleanup();
    });

    it('agent config does not rewrite the ACL of a venv file it never touches', async () => {
      // Harden the sandbox root first so the later-created tree inherits its final ACL.
      const initial = await env.run(['agent', 'config', '--json']);
      expect(initial.code, describeRun(initial)).toBe(0);

      const dir = join(env.sb.joyDir, 'masking-venv', 'lib', 'site-packages');
      mkdirSync(dir, { recursive: true });
      const weights = join(dir, 'weights.bin');
      writeFileSync(weights, 'x');
      for (let i = 0; i < 200; i++) writeFileSync(join(dir, `part-${i}.bin`), 'x');

      const before = icaclsOf(weights);
      const r = await env.run(['agent', 'config', '--json']);
      expect(r.code, describeRun(r)).toBe(0);
      expect(icaclsOf(weights)).toBe(before);
    }, 60_000);

    it('inherit-only grants do not make the directory private, so it is still hardened', async () => {
      mkdirSync(env.sb.joyDir, { recursive: true });
      const sid = currentUserSid();
      // Full control that applies only to children (IO), never to the directory itself.
      const set = spawnSync(
        'icacls.exe',
        [
          env.sb.joyDir,
          '/inheritance:r',
          '/grant:r',
          `*S-1-5-18:(OI)(CI)(IO)F`,
          `*S-1-5-32-544:(OI)(CI)(IO)F`,
          `*${sid}:(OI)(CI)(IO)F`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      );
      expect(set.status, set.stderr).toBe(0);
      expect(icaclsOf(env.sb.joyDir)).not.toMatch(/\(OI\)\(CI\)\(F\)/);

      const r = await env.run(['agent', 'config', '--json']);
      expect(r.code, describeRun(r)).toBe(0);
      expect(icaclsOf(env.sb.joyDir)).toMatch(/\(OI\)\(CI\)\(F\)/);
    }, 60_000);
  },
);
