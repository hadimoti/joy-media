// A stand-in for the packaged app in launch-diagnostics.test.mjs. It writes a start-up marker into its user-data folder, so the
// test can tell that it ran. It writes a diagnostic file only when STUB_WRITE_DIAGNOSTICS is 1 and it is given the diagnostics
// switch, so the test can check that the checker sees such a file. Then it waits to be stopped.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setInterval } from 'node:timers';

const args = process.argv.slice(2);
const userDataArg = args.find((arg) => arg.startsWith('--user-data-dir='));
if (userDataArg) {
  const dir = userDataArg.slice('--user-data-dir='.length);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'stub-started.txt'), 'started\n', 'utf8');
  if (args.includes('--joy-media-gpu-diagnostics') && process.env.STUB_WRITE_DIAGNOSTICS === '1') {
    await writeFile(join(dir, 'gpu-diagnostics.jsonl'), '{"event":"stand-in"}\n', 'utf8');
  }
}

// Keep running until the test stops it.
setInterval(() => {}, 60000);
