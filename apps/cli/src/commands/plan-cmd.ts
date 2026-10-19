/* global console */
import type { CliFlags } from '../cli.js';

// Placeholder until the prepare/inspect/apply plan command lands. It keeps the dispatch table compiling.
export async function handlePlanCommand(args: string[], flags: CliFlags): Promise<number> {
  const subject = args[0] ?? 'none';
  const message = `plan is not implemented yet (${subject})`;
  if (flags.json) console.log(JSON.stringify({ type: 'error', code: 'USAGE', message }));
  else console.error(message);
  return 2;
}
