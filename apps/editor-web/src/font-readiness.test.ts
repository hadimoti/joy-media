import { describe, expect, it } from 'vitest';
import { FontReadinessError, waitForContentFonts } from './font-readiness.js';

describe('content font readiness', () => {
  it('waits for the requested bundled families', async () => {
    const checked: string[] = [];
    await waitForContentFonts(['YekanBakh', 'Vazin'], {
      timeoutMs: 100,
      platform: {
        check: (family) => {
          checked.push(family);
          return true;
        },
        ready: Promise.resolve(),
      },
    });
    expect(checked).toEqual(['YekanBakh', 'Vazin']);
  });

  it('fails with a bounded typed error when a family is unavailable', async () => {
    await expect(
      waitForContentFonts(['YekanBakh'], {
        timeoutMs: 5,
        platform: { check: () => false, ready: Promise.resolve() },
      }),
    ).rejects.toBeInstanceOf(FontReadinessError);
  });
});
