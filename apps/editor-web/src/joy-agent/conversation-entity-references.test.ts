import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { createExecutionReceipt } from '../execution-receipt.js';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  deriveJoyAgentConversationEntityReferences,
  JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT,
  resolveJoyAgentConversationEntityReference,
  type JoyAgentConversationEntitySource,
} from './conversation-entity-references.js';

function source(visual: JoyProjectV1 = INITIAL_EDITOR_PROJECT): JoyAgentConversationEntitySource {
  return { timeline: buildReferenceSpikeProject(), visual };
}

function receipt(changedEntityIds: readonly string[]) {
  const timeline = buildReferenceSpikeProject();
  return createExecutionReceipt({
    executionId: 'host-execution-1',
    projectId: timeline.id,
    operationDigest: 'a'.repeat(64),
    baseRevision: 'revision-base',
    resultRevision: 'revision-result',
    writerFence: 1,
    changedEntityIds,
    undoEntryId: 'history-1',
  });
}

describe('JOY conversation entity references', () => {
  it('derives only unambiguous current canonical entities from a committed host receipt', () => {
    const result = deriveJoyAgentConversationEntityReferences(
      receipt(['intro', 'intro-title', 'product-still']),
      source(),
    );

    expect(result).toEqual({
      kind: 'references',
      omittedEntityCount: 0,
      references: [
        expect.objectContaining({ entityId: 'intro', entityKind: 'timeline-video-clip' }),
        expect.objectContaining({ entityId: 'intro-title', entityKind: 'visual-text' }),
        expect.objectContaining({ entityId: 'product-still', entityKind: 'asset-image' }),
      ],
    });
    if (result.kind !== 'references') throw new Error('Expected references');
    expect(result.references.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(result.references)).toBe(true);
  });

  it('does not retain source text, display names, provider-like values, URLs, or arbitrary metadata', () => {
    const visual: JoyProjectV1 = {
      ...INITIAL_EDITOR_PROJECT,
      visualObjects: {
        ...INITIAL_EDITOR_PROJECT.visualObjects,
        'intro-title': {
          ...INITIAL_EDITOR_PROJECT.visualObjects['intro-title']!,
          text: 'https://provider.invalid/v1 apiKey=do-not-retain',
          arbitraryProviderOutput: 'sk-this-must-not-cross-the-boundary',
        } as JoyProjectV1['visualObjects'][string],
      },
      assets: {
        ...INITIAL_EDITOR_PROJECT.assets,
        'product-still': {
          ...INITIAL_EDITOR_PROJECT.assets['product-still']!,
          displayName: 'Bearer secret-token',
          providerMetadata: { prompt: 'never retain this' },
        } as JoyProjectV1['assets'][string],
      },
    };
    const result = deriveJoyAgentConversationEntityReferences(
      receipt(['intro-title', 'product-still', 'secret-token']),
      source(visual),
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('provider.invalid');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('arbitraryProviderOutput');
    expect(serialized).not.toContain('providerMetadata');
    expect(serialized).toContain('Text layer');
    expect(serialized).toContain('Image asset');
  });

  it('bounds references and reports the omitted canonical receipt IDs without storing their content', () => {
    const visualObjects = Object.fromEntries(
      Array.from({ length: JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT + 6 }, (_, index) => {
        const id = `title-${String(index).padStart(2, '0')}`;
        return [
          id,
          {
            ...INITIAL_EDITOR_PROJECT.visualObjects['intro-title']!,
            id,
          },
        ];
      }),
    );
    const ids = Object.keys(visualObjects);
    const result = deriveJoyAgentConversationEntityReferences(
      receipt(ids),
      source({ ...INITIAL_EDITOR_PROJECT, visualObjects }),
    );

    if (result.kind !== 'references') throw new Error('Expected bounded references');
    expect(result.references).toHaveLength(JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT);
    expect(result.omittedEntityCount).toBe(6);
  });

  it('returns a fixed structured clarification when a stored prior entity was deleted', () => {
    const derived = deriveJoyAgentConversationEntityReferences(receipt(['intro-title']), source());
    if (derived.kind !== 'references') throw new Error('Expected a safe reference fixture');
    const reference = derived.references[0];
    if (reference === undefined) throw new Error('Expected one reference');
    const visual: JoyProjectV1 = {
      ...INITIAL_EDITOR_PROJECT,
      visualObjects: Object.fromEntries(
        Object.entries(INITIAL_EDITOR_PROJECT.visualObjects).filter(([id]) => id !== 'intro-title'),
      ),
    };

    const result = resolveJoyAgentConversationEntityReference(reference, source(visual));

    expect(result).toEqual({
      kind: 'clarification',
      clarification: {
        version: 1,
        code: 'JOY_AGENT_CONVERSATION_REFERENCE_MISSING_OR_DELETED',
        message:
          'A previously edited item is no longer available. Select an existing item before continuing.',
        entityIds: ['intro-title'],
        omittedEntityCount: 1,
      },
    });
  });

  it('fails closed when a receipt belongs to another timeline document', () => {
    const result = deriveJoyAgentConversationEntityReferences(
      { ...receipt(['intro-title']), projectId: 'other-project' },
      source(),
    );

    expect(result).toEqual({
      kind: 'clarification',
      references: [],
      clarification: expect.objectContaining({
        code: 'JOY_AGENT_CONVERSATION_REFERENCE_PROJECT_MISMATCH',
        entityIds: ['intro-title'],
      }),
    });
  });
});
