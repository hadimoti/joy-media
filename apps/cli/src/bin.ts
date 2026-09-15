/* global console, process */
import { runCli } from './cli.js';

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const code = await runCli(argv);
    process.exit(code);
  } catch (error) {
    console.error('Fatal CLI Error:', error);
    process.exit(1);
  }
}

main();
