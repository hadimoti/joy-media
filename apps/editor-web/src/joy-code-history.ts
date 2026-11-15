export type JoyCodeMessageRole = 'user' | 'assistant';
export type JoyCodeThreadStatus = 'draft' | 'planning' | 'completed' | 'failed';

/** The state of a generation job, as the main process names it (apps/desktop generation-job-store). */
export type JoyCodeJobState =
  | 'queued'
  | 'running'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'abandoned-locally'
  | 'timed-out';

export const JOY_CODE_JOB_STATES: readonly JoyCodeJobState[] = [
  'queued',
  'running',
  'downloading',
  'completed',
  'failed',
  'cancelled',
  'abandoned-locally',
  'timed-out',
];

/**
 * One piece of a message. Media is named by job id only: the bytes are read
 * from the main process when shown, never by file path, and nothing here
 * carries a path, link or key.
 */
export type JoyCodeMessagePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly jobId: string; readonly label?: string }
  | { readonly kind: 'video'; readonly jobId: string; readonly label?: string }
  | {
      readonly kind: 'job';
      readonly jobId: string;
      readonly mediaKind: 'image' | 'video';
      readonly state: JoyCodeJobState;
      /** ISO time the job started; elapsed time counts from here. */
      readonly startedAt: string;
      /** ISO time the job ended; absent while it is still working. */
      readonly endedAt?: string;
      /** One short plain sentence for a failed job. */
      readonly reason?: string;
    };

export interface JoyCodeMessage {
  readonly id: string;
  readonly role: JoyCodeMessageRole;
  readonly body: string;
  readonly createdAt: string;
  /**
   * A failure shown as one card: the key of its entry in the Joy Code message
   * table (joy-code-messages.ts). The card renders from the table, not the body.
   */
  readonly failureKey?: string;
  /**
   * Text, pictures, videos and job cards in order. Absent on every message
   * written before T-C05: those show their body as before.
   */
  readonly parts?: readonly JoyCodeMessagePart[];
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
const MAX_THREAD_ID_CHARS = 128;
const MAX_THREAD_TITLE_CHARS = 160;
const MAX_MESSAGE_ID_CHARS = 128;
const MAX_MESSAGE_BODY_CHARS = 8_000;
const MAX_TIMESTAMP_CHARS = 64;
const MAX_FAILURE_KEY_CHARS = 64;
const MAX_PARTS_PER_MESSAGE = 16;
const MAX_PART_LABEL_CHARS = 200;
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
  if (
    candidate.id.length > MAX_THREAD_ID_CHARS ||
    candidate.title.length > MAX_THREAD_TITLE_CHARS ||
    candidate.createdAt.length > MAX_TIMESTAMP_CHARS ||
    candidate.updatedAt.length > MAX_TIMESTAMP_CHARS
  ) {
    return false;
  }
  return candidate.messages.every(isJoyCodeMessage);
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isJoyCodeMessagePart(value: unknown): value is JoyCodeMessagePart {
  if (typeof value !== 'object' || value === null) return false;
  const part = value as Record<string, unknown>;
  switch (part.kind) {
    case 'text':
      return isShortString(part.text, MAX_MESSAGE_BODY_CHARS);
    case 'image':
    case 'video':
      return (
        isShortString(part.jobId, MAX_MESSAGE_ID_CHARS) &&
        (part.label === undefined || isShortString(part.label, MAX_PART_LABEL_CHARS))
      );
    case 'job':
      return (
        isShortString(part.jobId, MAX_MESSAGE_ID_CHARS) &&
        (part.mediaKind === 'image' || part.mediaKind === 'video') &&
        JOY_CODE_JOB_STATES.includes(part.state as JoyCodeJobState) &&
        isShortString(part.startedAt, MAX_TIMESTAMP_CHARS) &&
        (part.endedAt === undefined || isShortString(part.endedAt, MAX_TIMESTAMP_CHARS)) &&
        (part.reason === undefined || isShortString(part.reason, MAX_PART_LABEL_CHARS))
      );
    default:
      return false;
  }
}

/** True when `parts` is absent (an older message) or a short list of valid parts. */
export function isJoyCodeMessageParts(parts: unknown): boolean {
  return (
    parts === undefined ||
    (Array.isArray(parts) &&
      parts.length <= MAX_PARTS_PER_MESSAGE &&
      parts.every(isJoyCodeMessagePart))
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
    candidate.id.length <= MAX_MESSAGE_ID_CHARS &&
    candidate.body.length <= MAX_MESSAGE_BODY_CHARS &&
    candidate.createdAt.length <= MAX_TIMESTAMP_CHARS &&
    (candidate.failureKey === undefined ||
      (typeof candidate.failureKey === 'string' &&
        candidate.failureKey.length <= MAX_FAILURE_KEY_CHARS)) &&
    isJoyCodeMessageParts(candidate.parts)
  );
}
