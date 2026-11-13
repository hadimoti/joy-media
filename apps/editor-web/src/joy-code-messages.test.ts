import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREATIVE_SKILL_BLOCK_REASONS } from './joy-agent/skill-runner.js';
import { CREATIVE_SKILL_HOST_FAILURE_CODES } from './joy-agent/creative-skill-host-adapter.js';
import { JOY_AGENT_RUN_ERROR_CODES } from './joy-agent/run-events.js';
import {
  JOY_CODE_MESSAGES,
  JOY_CODE_UI_MESSAGE_KEYS,
  codesFromDiagnostics,
  isJoyCodeMessageKey,
  joyCodeCodeOfThrown,
  joyCodeKeyForBlockReason,
  joyCodeKeyForExecutionErrors,
  joyCodeKeyForHostFailure,
  joyCodeKeyForLookBlockReason,
  joyCodeKeyForRecipeStop,
  joyCodeKeyForRunError,
  joyCodeKeyForThrown,
  joyCodeMessageByKey,
  reportJoyCodeFailure,
  type JoyCodeMessage,
  type JoyCodeMessageKey,
} from './joy-code-messages.js';

// The runtime lists are the unions: a new reason or code added to any of them
// has to get an entry here, or the first test below fails.
const EVERY_KEY: readonly string[] = [
  ...CREATIVE_SKILL_BLOCK_REASONS,
  ...CREATIVE_SKILL_HOST_FAILURE_CODES,
  ...JOY_AGENT_RUN_ERROR_CODES,
  ...JOY_CODE_UI_MESSAGE_KEYS,
];

function messageFor(key: string): JoyCodeMessage {
  return JOY_CODE_MESSAGES[key as JoyCodeMessageKey];
}

describe('Joy Code plain messages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has an entry for every reason, failure code and run error code', () => {
    for (const key of EVERY_KEY) {
      expect(JOY_CODE_MESSAGES, key).toHaveProperty([key]);
    }
    // No stray entries: the table holds exactly the keys the unions name.
    expect(new Set(Object.keys(JOY_CODE_MESSAGES))).toEqual(new Set(EVERY_KEY));
  });

  it('gives every entry a title, one sentence and one action', () => {
    for (const key of EVERY_KEY) {
      const message = messageFor(key);
      expect(message.title.trim().length, `${key} title`).toBeGreaterThan(0);
      expect(message.sentence.trim().length, `${key} sentence`).toBeGreaterThan(0);
      expect(message.sentence, `${key} sentence ends with a full stop`).toMatch(/\.$/);
      expect(message.action.label.trim().length, `${key} action`).toBeGreaterThan(0);
      expect(['retry', 'open-settings', 'dismiss']).toContain(message.action.kind);
    }
  });

  it('never shows a raw code in the owner-facing text', () => {
    const rawCodePattern = /[A-Z]{2,}_[A-Z_]+|LOOK_|NO_PREPARED|JOY_/;
    for (const key of EVERY_KEY) {
      const message = messageFor(key);
      const text = `${message.title} ${message.sentence} ${message.action.label}`;
      expect(text, key).not.toMatch(rawCodePattern);
      // Internal reason words such as "stale-authority" or "adapter-failed" are codes too.
      for (const other of EVERY_KEY) {
        if (other.includes('-')) expect(text, key).not.toContain(other);
      }
    }
  });

  it('never shows a path, a separator or a long raw payload', () => {
    for (const key of EVERY_KEY) {
      const message = messageFor(key);
      for (const text of [message.title, message.sentence, message.action.label]) {
        expect(text, key).not.toMatch(/[\\/]/);
        expect(text, key).not.toMatch(/https?:|file:|sk-|Bearer /i);
        expect(text.length, key).toBeLessThan(240);
      }
    }
  });

  it('maps a block reason, run code or host code through its own key', () => {
    expect(joyCodeKeyForBlockReason('stale-authority')).toBe('stale-authority');
    expect(joyCodeKeyForBlockReason('something-new')).toBe('unexpected-failure');
    expect(joyCodeKeyForRunError('JOY_AGENT_TIMEOUT')).toBe('JOY_AGENT_TIMEOUT');
    expect(joyCodeKeyForRunError('JOY_AGENT_NEW_THING')).toBe('unexpected-failure');
    expect(joyCodeKeyForRunError(undefined)).toBe('unexpected-failure');
    expect(joyCodeKeyForLookBlockReason('LOOK_COMPILE_BAKE_KEYS')).toBe('look-compile-failed');
    expect(joyCodeKeyForLookBlockReason('staging-rejected')).toBe('look-staging-failed');
    expect(joyCodeKeyForLookBlockReason('whatever')).toBe('look-unknown');
  });

  it('maps each execution error to its run code, and unknown text to the generic entry', () => {
    expect(joyCodeKeyForExecutionErrors(['JOY_AGENT_STALE_REVISION'])).toBe(
      'JOY_AGENT_STALE_REVISION',
    );
    expect(
      joyCodeKeyForExecutionErrors([
        'Command failed at C:\\Users\\someone\\clip.json',
        'JOY_AGENT_TIMEOUT',
      ]),
    ).toBe('JOY_AGENT_TIMEOUT');
    expect(joyCodeKeyForExecutionErrors(['Provider said: SECRET-LOOKING-TEXT-123'])).toBe(
      'unexpected-failure',
    );
    expect(joyCodeKeyForExecutionErrors([])).toBe('unexpected-failure');
  });

  it('takes the host failure code from a thrown CODE:reason and never the reason', () => {
    expect(joyCodeKeyForHostFailure('NO_PREPARED_CHANGE:some_reason')).toBe('NO_PREPARED_CHANGE');
    expect(joyCodeKeyForHostFailure('PREVIEW_NOT_RENDERED')).toBe('PREVIEW_NOT_RENDERED');
    expect(joyCodeKeyForHostFailure('SOMETHING_ELSE:x')).toBe('unexpected-failure');
  });

  it('keeps the host or run code a recipe stop carries, ahead of the block reason', () => {
    expect(joyCodeKeyForRecipeStop('adapter-failed', 'NO_PREPARED_CHANGE')).toBe(
      'NO_PREPARED_CHANGE',
    );
    expect(joyCodeKeyForRecipeStop('adapter-failed', 'JOY_AGENT_TIMEOUT')).toBe(
      'JOY_AGENT_TIMEOUT',
    );
    expect(joyCodeKeyForRecipeStop('stale-authority', undefined)).toBe('stale-authority');
    expect(joyCodeKeyForRecipeStop('adapter-failed', 'NOT_A_CODE')).toBe('adapter-failed');
  });

  it('shows the entry for a thrown run code, never the thrown text', () => {
    const refused = Object.assign(new Error('Provider said: SECRET-LOOKING-TEXT-123'), {
      code: 'JOY_AGENT_BILLING_REQUIRED',
    });
    expect(joyCodeKeyForThrown(refused)).toBe('JOY_AGENT_BILLING_REQUIRED');
    expect(joyCodeCodeOfThrown(refused)).toBe('JOY_AGENT_BILLING_REQUIRED');
    expect(joyCodeKeyForThrown(new Error('plain text'))).toBe('unexpected-failure');
    expect(joyCodeKeyForThrown(undefined)).toBe('unexpected-failure');
  });

  it('looks up a stored key and falls back to the generic entry for anything else', () => {
    expect(isJoyCodeMessageKey('stale-authority')).toBe(true);
    expect(isJoyCodeMessageKey('__proto__')).toBe(false);
    expect(isJoyCodeMessageKey('constructor')).toBe(false);
    expect(joyCodeMessageByKey('JOY_AGENT_TIMEOUT')).toBe(JOY_CODE_MESSAGES.JOY_AGENT_TIMEOUT);
    expect(joyCodeMessageByKey('toString')).toBe(JOY_CODE_MESSAGES['unexpected-failure']);
    expect(joyCodeMessageByKey(undefined)).toBe(JOY_CODE_MESSAGES['unexpected-failure']);
  });

  it('logs only a code, and never a value that is not a plain code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reportJoyCodeFailure('JOY_AGENT_TIMEOUT');
    reportJoyCodeFailure('C:\\Users\\someone\\secret\\file.json');
    reportJoyCodeFailure('SECRET-LOOKING-TEXT-123 raw provider text');
    reportJoyCodeFailure(undefined);
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      '[joy-code] failure code: JOY_AGENT_TIMEOUT',
      '[joy-code] failure code: unrecognised',
      '[joy-code] failure code: unrecognised',
      '[joy-code] failure code: unrecognised',
    ]);
  });

  it('reads only the code-shaped tokens of a Look diagnostic', () => {
    expect(
      codesFromDiagnostics([
        'LOOK_COMPILE_BAKE_KEYS on binding 3 in C:\\Users\\someone\\look.json',
        'plain text with no code',
        'NO_PREPARED_CHANGE',
      ]),
    ).toEqual(['LOOK_COMPILE_BAKE_KEYS', 'NO_PREPARED_CHANGE']);
  });

  it('keeps the owner examples in plain words', () => {
    expect(JOY_CODE_MESSAGES['no-model'].sentence).toBe(
      'No AI model is connected. Connect one in Agent Settings to edit by describing what you want.',
    );
    expect(JOY_CODE_MESSAGES['no-model'].action.label).toBe('Connect a model');
    expect(JOY_CODE_MESSAGES['stale-authority'].sentence).toBe(
      'The project changed while Joy Code was working. No edits were applied.',
    );
    expect(JOY_CODE_MESSAGES.JOY_AGENT_CORS_OR_NETWORK.title).toBe('You are offline');
    expect(JOY_CODE_MESSAGES.JOY_AGENT_CORS_OR_NETWORK.action.label).toBe('Retry');
    expect(JOY_CODE_MESSAGES.JOY_AGENT_AUTH_FAILED.action.label).toBe('Sign in again');
    expect(JOY_CODE_MESSAGES['audio-not-prepared'].sentence).toBe(
      'Joy Code could not read the audio in this composition. No edits were applied.',
    );
  });
});
