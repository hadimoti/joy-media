/**
 * Remembered Gmail / Telegram contacts for the login gate.
 * Stored locally so typing 1–2 characters can surface prior values.
 */

export type LoginContactMethod = 'gmail' | 'telegram';

export interface LoginContactStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'joy-media.login-contacts';
const MAX_PER_METHOD = 12;

export interface LoginContactHistory {
  readonly gmail: readonly string[];
  readonly telegram: readonly string[];
}

const EMPTY: LoginContactHistory = { gmail: [], telegram: [] };

export function loadLoginContactHistory(storage: LoginContactStorage): LoginContactHistory {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null || raw.length === 0) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<LoginContactHistory>;
    return {
      gmail: sanitizeList(parsed.gmail),
      telegram: sanitizeList(parsed.telegram),
    };
  } catch {
    return EMPTY;
  }
}

export function rememberLoginContact(
  storage: LoginContactStorage,
  method: LoginContactMethod,
  value: string,
): LoginContactHistory {
  const clean = value.trim();
  if (clean.length === 0) return loadLoginContactHistory(storage);
  const current = loadLoginContactHistory(storage);
  const nextList = [
    clean,
    ...current[method].filter((entry) => entry.toLowerCase() !== clean.toLowerCase()),
  ].slice(0, MAX_PER_METHOD);
  const next: LoginContactHistory = { ...current, [method]: nextList };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private browsing / quota — suggestions just won't persist */
  }
  return next;
}

/** Prefix match after ≥1 character (case-insensitive). */
export function suggestLoginContacts(
  history: LoginContactHistory,
  method: LoginContactMethod,
  query: string,
): readonly string[] {
  const q = query.trim().toLowerCase();
  if (q.length < 1) return [];
  const starts = history[method].filter((entry) => entry.toLowerCase().startsWith(q));
  if (starts.length > 0) return starts.slice(0, 8);
  return history[method].filter((entry) => entry.toLowerCase().includes(q)).slice(0, 8);
}

function sanitizeList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const clean = entry.trim();
    if (clean.length === 0) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_PER_METHOD) break;
  }
  return out;
}
