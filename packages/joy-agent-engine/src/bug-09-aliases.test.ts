// Bug 9: operation shapes that models really send (seen in runs h3, h5, o1, k2, k3, k6)
// were rejected, burning the three-proposal retry budget.
import { describe, expect, it } from 'vitest';
import { parseJoyDocumentOperations, parseJoyTimelineOperations } from './tools.js';

describe('bug 9: agent operation aliases', () => {
  it('accepts kind "text"/"add-text"/"caption" and `operation`/`op` as create-text', () => {
    for (const operation of [
      { kind: 'text', text: 'Hi', startUs: 0, durationUs: 1_000_000 },
      { kind: 'add-text', text: 'Hi', startUs: 0, durationUs: 1_000_000 },
      { kind: 'caption', text: 'Hi', startUs: 0, durationUs: 1_000_000 },
      { operation: 'create-text', text: 'Hi', durationUs: 1_000_000 },
      { op: 'create-text', text: 'Hi', durationUs: 1_000_000 },
    ]) {
      const [parsed] = parseJoyDocumentOperations([operation]);
      expect(parsed).toMatchObject({ kind: 'create-text', text: 'Hi' });
    }
  });

  it('accepts timelineStartUs/start and endUs on create-text (h3, k3)', () => {
    const [a] = parseJoyDocumentOperations([
      { kind: 'create-text', text: 'A', timelineStartUs: 4_000_000, durationUs: 4_000_000 },
    ]);
    expect(a).toMatchObject({ startUs: 4_000_000, durationUs: 4_000_000 });
    const [b] = parseJoyDocumentOperations([
      { kind: 'create-text', text: 'B', startUs: 4_000_000, endUs: 8_000_000 },
    ]);
    expect(b).toMatchObject({ startUs: 4_000_000, durationUs: 4_000_000 });
  });

  it('accepts a centred/bottom `position` on create-text instead of rejecting it (h3)', () => {
    const [parsed] = parseJoyDocumentOperations([
      { kind: 'create-text', text: 'A', position: 'center', durationUs: 1_000_000 },
    ]);
    expect(parsed).toMatchObject({ kind: 'create-text', text: 'A' });
  });

  it('accepts kind "look"/"apply-look" and a missing id on add-effect (h5)', () => {
    for (const operation of [
      { kind: 'look', clipId: 'clip-a', look: 'crt' },
      { type: 'add-effect', clipId: 'clip-a', look: 'crt' },
      { kind: 'apply-look', clipId: 'clip-a', look: 'CRT' },
    ]) {
      const [parsed] = parseJoyDocumentOperations([operation]);
      expect(parsed).toMatchObject({ kind: 'add-effect', objectId: 'clip-a', effectId: 'crt' });
      expect(parsed!.id).toMatch(/\S/);
    }
  });

  it('accepts a timeline operation without an id (k2 first proposal)', () => {
    const [parsed] = parseJoyTimelineOperations([
      { kind: 'trim', clipId: 'clip-a', sourceInUs: 0, sourceOutUs: 5_000_000 },
    ]);
    expect(parsed).toMatchObject({ kind: 'trim', clipId: 'clip-a' });
    expect(parsed!.id).toMatch(/\S/);
  });

  it('still rejects a genuinely unknown kind', () => {
    expect(() => parseJoyDocumentOperations([{ kind: 'explode', id: 'x' }])).toThrow();
  });
});
