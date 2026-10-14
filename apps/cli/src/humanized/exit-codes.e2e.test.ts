/**
 * Process-level contract: an AI agent (or a shell script) decides whether a
 * command worked by looking at its exit code. These tests run the real binary.
 *
 * Regression: `exitWithCode` used to wait on an unref'd timer, so the event loop
 * drained and Node exited 0 before `process.exit(code)` ran. Every failing
 * command reported success.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, describeRun, type Sandbox } from './harness.js';

describe('exit codes are honest (real binary)', () => {
  let sb: Sandbox;
  beforeAll(() => {
    sb = createSandbox('exit-codes');
  });
  afterAll(() => sb.cleanup());

  for (const entry of ['bin', 'bundle'] as const) {
    describe(`via ${entry} entry`, () => {
      it('exits 0 for help, version and a clean read-only command', async () => {
        for (const args of [['--help'], ['--version'], ['help'], ['project', 'list']]) {
          const r = await sb.run(args, { entry });
          expect(r.code, describeRun(r)).toBe(0);
        }
      }, 30_000);

      it('exits 1 when a human mistypes a command', async () => {
        const r = await sb.run(['frobnicate'], { entry });
        expect(r.code, describeRun(r)).toBe(1);
        expect(r.err).toMatch(/Unknown command "frobnicate"/);
      });

      it('exits 2 for an invalid numeric flag (usage error, not a crash)', async () => {
        const r = await sb.run(['timeline', 'add-clip', '--duration', 'abc'], { entry });
        expect(r.code, describeRun(r)).toBe(2);
        expect(r.err).toMatch(/--duration/);
      });

      it('exits non-zero when a project does not exist', async () => {
        const r = await sb.run(['render', '--project', 'does-not-exist', '--json'], { entry });
        expect(r.code, describeRun(r)).not.toBe(0);
      });

      it('still delivers all stdout before exiting non-zero', async () => {
        const r = await sb.run(['render', '--project', 'does-not-exist', '--json'], { entry });
        expect(r.code, describeRun(r)).not.toBe(0);
        const events = r.ndjson<{ type: string }>();
        expect(events.at(-1)?.type).toBe('error');
      });
    });
  }
});
