import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { compileJoyCodeCompoundDraft } from './joy-code-compound-compiler.js';

describe('Joy Code compound compiler', () => {
  it('compiles mixed timeline, title, caption, and transition operations against one base', () => {
    const result = compileJoyCodeCompoundDraft({
      planId: 'compound-1',
      baseRevision: 'rev-1',
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      registeredAssetIds: ['asset-a'],
      operations: [
        {
          id: 'title',
          dependsOn: [],
          kind: 'text.insertTemplate',
          templateId: 'clean-title',
          content: 'سلام',
          startUs: 2_000_000,
          durationUs: 2_000_000,
          placementPreset: 'center',
        },
        {
          id: 'caption',
          dependsOn: ['title'],
          kind: 'caption.setTemplate',
          captionClipId: 'caption-clip-1',
          templateId: 'joy-rtl-classic',
        },
        { id: 'burn', dependsOn: ['caption'], kind: 'caption.setBurnIn', enabled: true },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseRevision).toBe('rev-1');
    expect(result.proposalHash).toMatch(/^joy-code-proposal-[0-9a-f]+$/);
    expect(result.document.visualObjects['text-clean-title-compound-1-0']).toBeDefined();
    expect(result.document.captionDocuments['captions-fa']?.styleRef).toBe('joy-rtl-classic');
    expect(result.document.pluginData['joy.captions.burnIn']).toBe(true);
    expect(result.groups.map((group) => group.kind)).toEqual(['text', 'caption', 'caption']);
  });

  it('is byte-stable and rejects any failed sub-operation without partial output', () => {
    const input = {
      planId: 'compound-2',
      baseRevision: 'rev-2',
      timeline: buildReferenceSpikeProject(),
      visualProject: INITIAL_EDITOR_PROJECT,
      registeredAssetIds: [],
      operations: [
        {
          id: 'bad',
          dependsOn: [],
          kind: 'text.insertTemplate' as const,
          templateId: 'missing',
          content: 'x',
          startUs: 0,
          durationUs: 1_000_000,
          placementPreset: 'center' as const,
        },
      ],
    };
    const first = compileJoyCodeCompoundDraft(input);
    const second = compileJoyCodeCompoundDraft(input);
    expect(first).toEqual(second);
    expect(first.ok).toBe(false);
  });
});
