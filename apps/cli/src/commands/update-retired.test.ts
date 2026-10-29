import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';

/**
 * The CLI has no `update` command in this build. The installer and its rollback belong to the desktop app
 * (PLAN-v4 §9c). `update check` and `update verify` were retired, so they must answer as unknown commands.
 */
describe('retired update commands', () => {
  let printed: string[] = [];

  beforeEach(() => {
    printed = [];
    const record = (...args: unknown[]): void => {
      printed.push(args.map(String).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([['check'], ['verify']])(
    'answers `update %s` with an unknown command and exits with 1',
    async (subcommand) => {
      const code = await runCli(['update', subcommand]);

      expect(code).toBe(1);
      expect(printed.join('\n')).toContain('Unknown command "update"');
    },
  );
});
