import { describe, expect, it } from 'vitest';
import {
  loadLoginContactHistory,
  rememberLoginContact,
  suggestLoginContacts,
} from './login-contact-history.js';

function memoryStorage(seed: Record<string, string> = {}) {
  const data = { ...seed };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe('login-contact-history', () => {
  it('remembers contacts MRU and suggests after 1 character', () => {
    const storage = memoryStorage();
    rememberLoginContact(storage, 'gmail', 'alice@gmail.com');
    rememberLoginContact(storage, 'gmail', 'bob@gmail.com');
    rememberLoginContact(storage, 'telegram', 'joyuser');

    const history = loadLoginContactHistory(storage);
    expect(history.gmail[0]).toBe('bob@gmail.com');
    expect(suggestLoginContacts(history, 'gmail', 'a')).toEqual(['alice@gmail.com']);
    expect(suggestLoginContacts(history, 'gmail', 'bob')).toEqual(['bob@gmail.com']);
    expect(suggestLoginContacts(history, 'gmail', 'gmail.com')).toEqual([
      'bob@gmail.com',
      'alice@gmail.com',
    ]);
    expect(suggestLoginContacts(history, 'telegram', 'jo')).toEqual(['joyuser']);
    expect(suggestLoginContacts(history, 'gmail', '')).toEqual([]);
  });

  it('dedupes case-insensitively and moves to front', () => {
    const storage = memoryStorage();
    rememberLoginContact(storage, 'telegram', 'JoyUser');
    rememberLoginContact(storage, 'telegram', 'other');
    rememberLoginContact(storage, 'telegram', 'joyuser');
    expect(loadLoginContactHistory(storage).telegram).toEqual(['joyuser', 'other']);
  });
});
