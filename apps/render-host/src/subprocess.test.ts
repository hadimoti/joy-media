import { describe, expect, it } from 'vitest';
import { runSubprocess } from './subprocess.js';

describe('render-host subprocess runner', () => {
  it('keeps the event loop responsive while a render tool is running', async () => {
    const events: string[] = [];
    const child = runSubprocess(process.execPath, [
      '-e',
      "setTimeout(() => process.stderr.write('rendered'), 80)",
    ]).then((result) => {
      events.push('child');
      return result;
    });

    await new Promise<void>((resolve) =>
      setTimeout(() => {
        events.push('timer');
        resolve();
      }, 5),
    );

    expect(events).toEqual(['timer']);
    await expect(child).resolves.toEqual({ status: 0, stderr: 'rendered' });
    expect(events).toEqual(['timer', 'child']);
  });

  it('returns a failed tool status and bounded diagnostic output', async () => {
    const result = await runSubprocess(process.execPath, [
      '-e',
      "process.stderr.write('x'.repeat(70000)); process.exit(7)",
    ]);

    expect(result.status).toBe(7);
    expect(Buffer.byteLength(result.stderr)).toBe(64 * 1024);
  });
});
