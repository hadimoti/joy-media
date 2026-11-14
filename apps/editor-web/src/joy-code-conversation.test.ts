import { describe, expect, it } from 'vitest';
import {
  addJoyCodeConversationMessage,
  createJoyCodeConversation,
  joyCodeConversationKey,
  loadJoyCodeConversation,
  saveJoyCodeConversation,
  setJoyCodeConversationEntityReferences,
} from './joy-code-conversation.js';
import { joyCodeHistoryKey } from './joy-code-history.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return entries.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
  };
}

describe('Joy Code project conversation', () => {
  it('creates and persists one conversation for a project', () => {
    const storage = memoryStorage();
    const conversation = addJoyCodeConversationMessage(
      createJoyCodeConversation('conversation-a', '2026-09-05T10:00:00.000Z'),
      {
        id: 'message-a',
        role: 'user',
        body: 'Make the intro faster',
        createdAt: '2026-09-05T10:01:00.000Z',
      },
    );
    saveJoyCodeConversation(storage, 'project-a', conversation);

    expect(loadJoyCodeConversation(storage, 'project-a')).toEqual(conversation);
    expect(storage.getItem(joyCodeConversationKey('project-a'))).not.toBeNull();
  });

  it('keeps message parts through save and load, and loads a conversation saved without them', () => {
    const storage = memoryStorage();
    const oldMessage = {
      id: 'old',
      role: 'user' as const,
      body: 'Make a picture',
      createdAt: '2026-11-15T10:00:00.000Z',
    };
    const withParts = addJoyCodeConversationMessage(
      addJoyCodeConversationMessage(
        createJoyCodeConversation('conversation-a', '2026-11-15T09:00:00.000Z'),
        oldMessage,
      ),
      {
        id: 'new',
        role: 'assistant',
        body: '',
        createdAt: '2026-11-15T10:01:00.000Z',
        parts: [
          { kind: 'image', jobId: 'job-1' },
          {
            kind: 'job',
            jobId: 'job-2',
            mediaKind: 'video',
            state: 'queued',
            startedAt: '2026-11-15T10:01:00.000Z',
          },
        ],
      },
    );
    saveJoyCodeConversation(storage, 'project-a', withParts);

    const loaded = loadJoyCodeConversation(storage, 'project-a');
    expect(loaded).toEqual(withParts);
    expect(loaded?.messages[0]).not.toHaveProperty('parts');
    expect(loaded?.messages[1]?.parts).toHaveLength(2);
  });

  it('ignores a conversation record with a malformed part and falls back to the legacy task', () => {
    const projectId = 'project-a';
    const legacy = [
      {
        id: 'legacy',
        title: 'Task',
        createdAt: '2026-09-05T10:00:00.000Z',
        updatedAt: '2026-09-05T11:00:00.000Z',
        status: 'completed',
        messages: [],
      },
    ];
    const bad = {
      version: 1,
      id: 'conversation-a',
      status: 'draft',
      updatedAt: '2026-11-15T10:00:00.000Z',
      messages: [
        {
          id: 'm',
          role: 'assistant',
          body: '',
          createdAt: '2026-11-15T10:00:00.000Z',
          parts: [{ kind: 'image' }],
        },
      ],
    };
    const storage = memoryStorage({
      [joyCodeConversationKey(projectId)]: JSON.stringify(bad),
      [joyCodeHistoryKey(projectId)]: JSON.stringify(legacy),
    });
    expect(loadJoyCodeConversation(storage, projectId)?.id).toBe('legacy');
  });

  it('seeds the newest legacy task without deleting the recoverable legacy record', () => {
    const projectId = 'project-a';
    const legacyKey = joyCodeHistoryKey(projectId);
    const legacy = [
      {
        id: 'legacy-newest',
        title: 'Newest task',
        createdAt: '2026-09-05T10:00:00.000Z',
        updatedAt: '2026-09-05T11:00:00.000Z',
        status: 'completed',
        messages: [],
      },
      {
        id: 'legacy-older',
        title: 'Older task',
        createdAt: '2026-09-05T08:00:00.000Z',
        updatedAt: '2026-09-05T09:00:00.000Z',
        status: 'draft',
        messages: [],
      },
    ];
    const storage = memoryStorage({ [legacyKey]: JSON.stringify(legacy) });

    expect(loadJoyCodeConversation(storage, projectId)).toMatchObject({
      id: 'legacy-newest',
      status: 'completed',
    });
    expect(storage.getItem(legacyKey)).toBe(JSON.stringify(legacy));
    expect(storage.getItem(joyCodeConversationKey(projectId))).toBeNull();
  });

  it('persists only closed-vocabulary entity references for a future safe follow-up', () => {
    const storage = memoryStorage();
    const conversation = setJoyCodeConversationEntityReferences(
      createJoyCodeConversation('conversation-a', '2026-09-05T10:00:00.000Z'),
      [
        {
          version: 1,
          projectId: 'timeline-project-a',
          executionId: 'execution-a',
          resultRevision: 'revision-a',
          entityId: 'title-a',
          entityKind: 'visual-text',
          label: 'Text layer',
        },
        {
          version: 1,
          projectId: 'timeline-project-a',
          executionId: 'execution-a',
          resultRevision: 'revision-a',
          entityId: 'title-b',
          entityKind: 'visual-text',
          label: 'private title text',
        },
      ] as never,
      '2026-09-05T10:01:00.000Z',
    );
    saveJoyCodeConversation(storage, 'project-a', conversation);

    expect(loadJoyCodeConversation(storage, 'project-a')?.recentEntityReferences).toEqual([
      {
        version: 1,
        projectId: 'timeline-project-a',
        executionId: 'execution-a',
        resultRevision: 'revision-a',
        entityId: 'title-a',
        entityKind: 'visual-text',
        label: 'Text layer',
      },
    ]);
    expect(storage.getItem(joyCodeConversationKey('project-a'))).not.toContain(
      'private title text',
    );
  });
});
