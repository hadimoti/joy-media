export type JoyCodeMessageRole = 'user' | 'assistant';
export type JoyCodeThreadStatus = 'draft' | 'planning' | 'completed' | 'failed';

export interface JoyCodeMessage {
  readonly id: string;
  readonly role: JoyCodeMessageRole;
  readonly body: string;
  readonly createdAt: string;
}

export interface JoyCodeThread {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: JoyCodeThreadStatus;
  readonly messages: readonly JoyCodeMessage[];
}

export interface JoyCodeHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MAX_THREADS = 30;
const MAX_MESSAGES_PER_THREAD = 120;
export const JOY_CODE_HISTORY_PREFIX = 'joy-media.joy-code-history.v1';

export function joyCodeHistoryKey(projectId: string): string {
  return `${JOY_CODE_HISTORY_PREFIX}:${projectId}`;
}

export function createJoyCodeThread(id: string, now: string): JoyCodeThread {
  return {
    id,
    title: 'New task',
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    messages: [],
  };
}

export function addJoyCodeMessage(
  threads: readonly JoyCodeThread[],
  threadId: string,
  message: JoyCodeMessage,
): readonly JoyCodeThread[] {
  const updated = threads.map((thread) => {
    if (thread.id !== threadId) return thread;
    const messages = [...thread.messages, message].slice(-MAX_MESSAGES_PER_THREAD);
    const firstPrompt = messages.find((candidate) => candidate.role === 'user')?.body;
    return {
      ...thread,
      title: firstPrompt === undefined ? thread.title : titleFromPrompt(firstPrompt),
      updatedAt: message.createdAt,
      messages,
    };
  });
  return sortAndLimit(updated);
}

export function setJoyCodeThreadStatus(
  threads: readonly JoyCodeThread[],
  threadId: string,
  status: JoyCodeThreadStatus,
  now: string,
): readonly JoyCodeThread[] {
  return sortAndLimit(
    threads.map((thread) =>
      thread.id === threadId ? { ...thread, status, updatedAt: now } : thread,
    ),
  );
}

export function loadJoyCodeThreads(
  storage: JoyCodeHistoryStorage,
  projectId: string,
): readonly JoyCodeThread[] {
  const raw = storage.getItem(joyCodeHistoryKey(projectId));
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortAndLimit(parsed.filter(isJoyCodeThread));
  } catch {
    return [];
  }
}

export function saveJoyCodeThreads(
  storage: JoyCodeHistoryStorage,
  projectId: string,
  threads: readonly JoyCodeThread[],
): void {
  storage.setItem(joyCodeHistoryKey(projectId), JSON.stringify(sortAndLimit(threads)));
}

export function removeJoyCodeThreads(
  storage: JoyCodeHistoryStorage & { removeItem?: (key: string) => void },
  projectId: string,
): void {
  storage.removeItem?.(joyCodeHistoryKey(projectId));
}

export function matchJoyCodeIntentId(prompt: string): string | undefined {
  const normalized = prompt.toLowerCase().trim().replace(/\s+/g, ' ');
  const slashCommand = normalized.split(' ')[0];
  const slashCommands: Readonly<Record<string, string>> = {
    '/split': 'split-at-playhead',
    '/recipe': 'recipe-split-trim',
    '/shorten': 'shorten-intro',
    '/move': 'move-to-playhead',
    '/remove': 'remove-selected',
    '/delete': 'remove-selected',
    '/join': 'join-with-next',
    '/insert': 'insert-test-clip',
  };
  if (slashCommand !== undefined && slashCommands[slashCommand] !== undefined) {
    return slashCommands[slashCommand];
  }
  if (normalized.includes('shorten') && normalized.includes('intro')) return 'shorten-intro';
  if (
    normalized.includes('split') &&
    (normalized.includes('trim') || normalized.includes('recipe'))
  ) {
    return 'recipe-split-trim';
  }
  if (normalized.includes('split')) return 'split-at-playhead';
  if (normalized.includes('move') && normalized.includes('playhead')) return 'move-to-playhead';
  if (normalized.includes('remove') || normalized.includes('delete')) return 'remove-selected';
  if (normalized.includes('join')) return 'join-with-next';
  if (normalized.includes('insert')) return 'insert-test-clip';
  return undefined;
}

function titleFromPrompt(prompt: string): string {
  const clean = prompt.trim().replace(/\s+/g, ' ');
  return clean.length <= 52 ? clean : `${clean.slice(0, 49).trimEnd()}…`;
}

function sortAndLimit(threads: readonly JoyCodeThread[]): readonly JoyCodeThread[] {
  return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_THREADS);
}

function isJoyCodeThread(value: unknown): value is JoyCodeThread {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<JoyCodeThread>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    !['draft', 'planning', 'completed', 'failed'].includes(candidate.status ?? '') ||
    !Array.isArray(candidate.messages)
  ) {
    return false;
  }
  return candidate.messages.every(isJoyCodeMessage);
}

function isJoyCodeMessage(value: unknown): value is JoyCodeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<JoyCodeMessage>;
  return (
    typeof candidate.id === 'string' &&
    (candidate.role === 'user' || candidate.role === 'assistant') &&
    typeof candidate.body === 'string' &&
    typeof candidate.createdAt === 'string'
  );
}
