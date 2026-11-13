import { describe, expect, it } from 'vitest';
import { CREATIVE_SKILL_BLOCK_REASONS } from './joy-agent/skill-runner.js';
import { CREATIVE_SKILL_HOST_FAILURE_CODES } from './joy-agent/creative-skill-host-adapter.js';
import { JOY_AGENT_RUN_ERROR_CODES } from './joy-agent/run-events.js';
import {
  JOY_CODE_MESSAGES,
  JOY_CODE_UI_MESSAGE_KEYS,
  joyCodeMessageForBlockReason,
  joyCodeMessageForHostFailure,
  joyCodeMessageForLookBlockReason,
  joyCodeMessageForRunError,
  joyCodeMessageForThrown,
  type JoyCodeMessage,
} from './joy-code-messages.js';

// The runtime lists are the unions: a new reason or code added to any of them
// has to get an entry here, or the first test below fails.
const EVERY_KEY: readonly string[] = [
  ...CREATIVE_SKILL_BLOCK_REASONS,
  ...CREATIVE_SKILL_HOST_FAILURE_CODES,
  ...JOY_AGENT_RUN_ERROR_CODES,
  ...JOY_CODE_UI_MESSAGE_KEYS,
];

describe('Joy Code plain messages', () => {
  it('has an entry for every reason, failure code and run error code', () => {
    for (const key of EVERY_KEY) {
      expect(JOY_CODE_MESSAGES, key).toHaveProperty([key]);
    }
    // No stray entries: the table holds exactly the keys the unions name.
    expect(new Set(Object.keys(JOY_CODE_MESSAGES))).toEqual(new Set(EVERY_KEY));
  });

  it('gives every entry a title, one sentence and one action', () => {
    for (const key of EVERY_KEY) {
      const message: JoyCodeMessage = JOY_CODE_MESSAGES[key as keyof typeof JOY_CODE_MESSAGES];
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
      const message = JOY_CODE_MESSAGES[key as keyof typeof JOY_CODE_MESSAGES];
      const text = `${message.title} ${message.sentence} ${message.action.label}`;
      expect(text, key).not.toMatch(rawCodePattern);
      // Internal reason words such as "stale-authority" or "adapter-failed" are codes too.
      for (const other of EVERY_KEY) {
        if (other.includes('-')) expect(text, key).not.toContain(other);
      }
    }
  });

  it('maps a thrown reason, code or Look reason through its own entry', () => {
    expect(joyCodeMessageForBlockReason('stale-authority')).toBe(
      JOY_CODE_MESSAGES['stale-authority'],
    );
    expect(joyCodeMessageForBlockReason('something-new')).toBe(
      JOY_CODE_MESSAGES['unexpected-failure'],
    );
    expect(joyCodeMessageForRunError('JOY_AGENT_TIMEOUT')).toBe(
      JOY_CODE_MESSAGES.JOY_AGENT_TIMEOUT,
    );
    expect(joyCodeMessageForRunError('JOY_AGENT_NEW_THING')).toBe(
      JOY_CODE_MESSAGES['unexpected-failure'],
    );
    // The reason after the colon is for the log; only the code picks the message.
    expect(joyCodeMessageForHostFailure('NO_PREPARED_CHANGE:some_reason')).toBe(
      JOY_CODE_MESSAGES.NO_PREPARED_CHANGE,
    );
    expect(joyCodeMessageForLookBlockReason('LOOK_COMPILE_BAKE_KEYS')).toBe(
      JOY_CODE_MESSAGES['look-compile-failed'],
    );
    expect(joyCodeMessageForLookBlockReason('staging-rejected')).toBe(
      JOY_CODE_MESSAGES['look-staging-failed'],
    );
    expect(joyCodeMessageForLookBlockReason('whatever')).toBe(JOY_CODE_MESSAGES['look-unknown']);
  });

  it('shows the message for a thrown run code, never the thrown text', () => {
    const refused = Object.assign(new Error('Provider said: sk-secret-looking-text'), {
      code: 'JOY_AGENT_BILLING_REQUIRED',
    });
    expect(joyCodeMessageForThrown(refused)).toBe(JOY_CODE_MESSAGES.JOY_AGENT_BILLING_REQUIRED);
    expect(joyCodeMessageForThrown(new Error('plain text'))).toBe(
      JOY_CODE_MESSAGES['unexpected-failure'],
    );
    expect(joyCodeMessageForThrown(undefined)).toBe(JOY_CODE_MESSAGES['unexpected-failure']);
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
  });
});
