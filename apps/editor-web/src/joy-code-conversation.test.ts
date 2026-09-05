import { describe, expect, it } from 'vitest';
import {
  addJoyCodeConversationMessage,
  createJoyCodeConversation,
  joyCodeConversationKey,
  loadJoyCodeConversation,
  saveJoyCodeConversation,
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
});
