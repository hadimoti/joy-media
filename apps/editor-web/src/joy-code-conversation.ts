import {
  loadJoyCodeThreads,
  type JoyCodeHistoryStorage,
  type JoyCodeMessage,
  type JoyCodeThreadStatus,
} from './joy-code-history.js';

const MAX_MESSAGES = 120;
const MAX_ID_CHARS = 128;
const MAX_TIMESTAMP_CHARS = 64;
export const JOY_CODE_CONVERSATION_PREFIX = 'joy-media.joy-code-conversation.v1';

/**
 * The one durable Joy Code conversation for an editor project. Conversations
 * stay browser-local, just like the former task history; provider keys and
 * remote chat history are deliberately not part of this record.
 */
export interface JoyCodeConversation {
  readonly version: 1;
  readonly id: string;
  readonly status: JoyCodeThreadStatus;
  readonly messages: readonly JoyCodeMessage[];
  readonly updatedAt: string;
}

export function joyCodeConversationKey(projectId: string): string {
  return `${JOY_CODE_CONVERSATION_PREFIX}:${projectId}`;
}

export function createJoyCodeConversation(id: string, now: string): JoyCodeConversation {
  return { version: 1, id, status: 'draft', messages: [], updatedAt: now };
}

/**
 * Read the v1 conversation, or seed it from the latest legacy task exactly
 * once in memory. The legacy array remains untouched so an upgrade is always
 * reversible and older builds can still read their own data.
 */
export function loadJoyCodeConversation(
  storage: JoyCodeHistoryStorage,
  projectId: string,
): JoyCodeConversation | undefined {
  const raw = storage.getItem(joyCodeConversationKey(projectId));
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isJoyCodeConversation(parsed)) return parsed;
    } catch {
      // A malformed current record falls back to the recoverable legacy data.
    }
  }

  const latestLegacyThread = loadJoyCodeThreads(storage, projectId)[0];
  if (latestLegacyThread === undefined) return undefined;
  return {
    version: 1,
    id: latestLegacyThread.id,
    status: latestLegacyThread.status,
    messages: latestLegacyThread.messages,
    updatedAt: latestLegacyThread.updatedAt,
  };
}

export function saveJoyCodeConversation(
  storage: JoyCodeHistoryStorage,
  projectId: string,
  conversation: JoyCodeConversation,
): void {
  storage.setItem(joyCodeConversationKey(projectId), JSON.stringify(normalizeConversation(conversation)));
}

export function addJoyCodeConversationMessage(
  conversation: JoyCodeConversation,
  message: JoyCodeMessage,
): JoyCodeConversation {
  return normalizeConversation({
    ...conversation,
    messages: [...conversation.messages, message],
    updatedAt: message.createdAt,
  });
}

export function setJoyCodeConversationStatus(
  conversation: JoyCodeConversation,
  status: JoyCodeThreadStatus,
  now: string,
): JoyCodeConversation {
  return { ...conversation, status, updatedAt: now };
}

function normalizeConversation(conversation: JoyCodeConversation): JoyCodeConversation {
  return { ...conversation, messages: conversation.messages.slice(-MAX_MESSAGES) };
}

function isJoyCodeConversation(value: unknown): value is JoyCodeConversation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<JoyCodeConversation>;
  return (
    candidate.version === 1 &&
    typeof candidate.id === 'string' &&
    candidate.id.length <= MAX_ID_CHARS &&
    ['draft', 'planning', 'completed', 'failed'].includes(candidate.status ?? '') &&
    typeof candidate.updatedAt === 'string' &&
    candidate.updatedAt.length <= MAX_TIMESTAMP_CHARS &&
    Array.isArray(candidate.messages) &&
    candidate.messages.length <= MAX_MESSAGES &&
    candidate.messages.every(isJoyCodeMessage)
  );
}

function isJoyCodeMessage(value: unknown): value is JoyCodeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<JoyCodeMessage>;
  return (
    typeof candidate.id === 'string' &&
    (candidate.role === 'user' || candidate.role === 'assistant') &&
    typeof candidate.body === 'string' &&
    typeof candidate.createdAt === 'string' &&
    candidate.id.length <= MAX_ID_CHARS &&
    candidate.createdAt.length <= MAX_TIMESTAMP_CHARS &&
    candidate.body.length <= 8_000
  );
}
