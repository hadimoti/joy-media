/* global console */
import type { CliFlags } from '../cli.js';

// Placeholder until the bounded query command lands. It keeps the dispatch table compiling.
export async function handleQueryCommand(args: string[], flags: CliFlags): Promise<number> {
  const subject = args[0] ?? 'none';
  const message = `query is not implemented yet (${subject})`;
  if (flags.json) console.log(JSON.stringify({ type: 'error', code: 'USAGE', message }));
  else console.error(message);
  return 2;
}
