import { describe, expect, it, vi } from 'vitest';
import {
  normalizeDocumentOperationAliases,
  normalizeLookName,
  pickAlias,
  resolveLookAliases,
} from './aliases.js';
import {
  createJoyAgentTools,
  parseJoyDocumentOperations,
  parseJoyTimelineOperations,
  type JoyAgentToolBridge,
} from './tools.js';

describe('shared operation aliases', () => {
  it('normalises look names case-insensitively', () => {
    expect(normalizeLookName('CRT')).toBe('crt');
    expect(normalizeLookName(' Warm ')).toBe('warm');
    expect(normalizeLookName('B&W')).toBeUndefined();
    expect(normalizeLookName(3)).toBeUndefined();
  });

  it('resolves look aliases and rejects conflicting or unsupported values', () => {
    expect(resolveLookAliases([['--kind', 'BW']])).toBe('bw');
    expect(
      resolveLookAliases([
        ['--look', 'crt'],
        ['--type', 'CRT'],
      ]),
    ).toBe('crt');
    expect(resolveLookAliases([])).toBeUndefined();
    expect(() =>
      resolveLookAliases([
        ['--look', 'crt'],
        ['--kind', 'bw'],
      ]),
    ).toThrow('Conflicting look values: --look crt, --kind bw');
    expect(() => resolveLookAliases([['--look', 'sepia']])).toThrow(
      'Look must be one of: crt, bw, warm, cool (got "sepia").',
    );
  });

  it('picks one value from aliased fields and rejects disagreement', () => {
    expect(
      pickAlias('clip id', [
        ['--clip', undefined],
        ['--clipId', 'c1'],
      ]),
    ).toBe('c1');
    expect(
      pickAlias('clip id', [
        ['--clip', 'c1'],
        ['--clip-id', 'c1'],
      ]),
    ).toBe('c1');
    expect(() =>
      pickAlias('clip id', [
        ['--clip', 'a'],
        ['--clipId', 'b'],
      ]),
    ).toThrow('Conflicting clip id values: --clip a, --clipId b');
  });

  it('accepts the add-effect aliases models use (clipId, look, effect, type)', () => {
    expect(
      parseJoyDocumentOperations([
        { kind: 'add-effect', id: 'e1', clipId: 'clip-1', look: 'CRT' },
        { type: 'add-effect', id: 'e2', objectId: 'clip-2', effect: 'warm' },
        { kind: 'add-effect', id: 'e3', clipId: 'clip-3', type: 'bw' },
      ]),
    ).toEqual([
      { kind: 'add-effect', id: 'e1', objectId: 'clip-1', effectId: 'crt', dependsOn: [] },
      { kind: 'add-effect', id: 'e2', objectId: 'clip-2', effectId: 'warm', dependsOn: [] },
      { kind: 'add-effect', id: 'e3', objectId: 'clip-3', effectId: 'bw', dependsOn: [] },
    ]);
  });

  it('defaults a missing create-text id and startUs', () => {
    expect(
      parseJoyDocumentOperations([
        { kind: 'create-text', id: 'text-1', text: 'A', startUs: 0, durationUs: 1_000_000 },
        { type: 'create-text', text: 'B', durationUs: 1_000_000 },
      ]),
    ).toEqual([
      {
        kind: 'create-text',
        id: 'text-1',
        text: 'A',
        startUs: 0,
        durationUs: 1_000_000,
        dependsOn: [],
      },
      {
        kind: 'create-text',
        id: 'text-2',
        text: 'B',
        startUs: 0,
        durationUs: 1_000_000,
        dependsOn: [],
      },
    ]);
  });

  it('rejects disagreeing aliases with a message the model can act on', () => {
    expect(() =>
      parseJoyDocumentOperations([
        { kind: 'add-effect', id: 'e1', objectId: 'a', clipId: 'b', effectId: 'crt' },
      ]),
    ).toThrow('add-effect e1: conflicting clip id values: objectId a, clipId b');
    expect(() =>
      parseJoyDocumentOperations([
        { kind: 'add-effect', id: 'e1', objectId: 'a', effectId: 'crt', look: 'bw' },
      ]),
    ).toThrow('add-effect e1: conflicting look values: effectId crt, look bw');
    expect(() =>
      normalizeDocumentOperationAliases([{ kind: 'create-text', type: 'add-effect', text: 'x' }]),
    ).toThrow('conflicting operation kind values: kind create-text, type add-effect');
  });

  it('accepts type for kind on timeline operations too', () => {
    expect(
      parseJoyTimelineOperations([{ type: 'split', id: 's1', clipId: 'c1', atUs: 5 }]),
    ).toEqual([{ kind: 'split', id: 's1', clipId: 'c1', atUs: 5, dependsOn: [] }]);
  });

  it('hands the normalised operations to the bridge from propose_document_operations', async () => {
    const proposeDocumentOperations = vi.fn(async () => ({ accepted: true }));
    const bridge: JoyAgentToolBridge = {
      readProjectSummary: async () => ({}),
      readSelection: async () => ({}),
      readTimelineWindow: async () => ({}),
      readAssetMetadata: async () => ({}),
      readStyleCatalog: async () => ({}),
      proposeTimelineOperations: async () => ({}),
      proposeDocumentOperations,
      submitPlan: async () => ({}),
    };
    const tools = createJoyAgentTools(bridge);
    const propose = (
      tools.propose_document_operations as { execute: (input: unknown) => Promise<unknown> }
    ).execute;

    await expect(
      propose({
        operations: [
          { type: 'add-effect', id: 'look', clipId: 'clip-1', look: 'Cool' },
          { kind: 'create-text', text: 'Hi', durationUs: 2_000_000 },
        ],
      }),
    ).resolves.toEqual({ accepted: true });
    expect(proposeDocumentOperations).toHaveBeenCalledWith({
      operations: [
        { kind: 'add-effect', id: 'look', objectId: 'clip-1', effectId: 'cool', dependsOn: [] },
        {
          kind: 'create-text',
          id: 'text-1',
          text: 'Hi',
          startUs: 0,
          durationUs: 2_000_000,
          dependsOn: [],
        },
      ],
    });
  });
});
