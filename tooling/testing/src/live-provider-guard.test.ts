import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { describe, expect, it } from 'vitest';
describe('live provider test guard', () => {
  it('blocks provider roots, subdomains, and trailing-dot hostnames', async () => {
    for (const url of [
      'https://openrouter.ai/v1/models',
      'https://gateway.openrouter.ai/v1/models',
      'https://gateway.openrouter.ai./v1/models',
      'https://api.anthropic.com/v1/messages',
    ])
      await expect(fetch(url)).rejects.toThrow('live provider call blocked in tests');
  });

  it('blocks fetch and Node request/get calls before any network request is made', async () => {
    await expect(fetch('https://api.openrouter.ai/v1/models')).rejects.toThrow(
      'live provider call blocked in tests',
    );
    expect(() => https.request({ hostname: 'api.openrouter.ai.' })).toThrow(
      'live provider call blocked in tests',
    );
    expect(() => https.get('https://v1.openrouter.ai/models')).toThrow(
      'live provider call blocked in tests',
    );
    expect(() => http.get({ protocol: 'https:', host: 'api.anthropic.com' })).toThrow(
      'live provider call blocked in tests',
    );
    expect(() => http.request('https://api.openai.com/v1/models')).toThrow(
      'live provider call blocked in tests',
    );
  });

  it('injects the guard into child Node processes and removes their provider keys', () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `fetch('https://subdomain.openrouter.ai/').then(() => process.exit(2)).catch((error) => {
          const credentialVariables = ${JSON.stringify([
            'OPENROUTER_API_KEY',
            'KILO_API_KEY',
            'OPENAI_API_KEY',
            'ANTHROPIC_API_KEY',
            'GEMINI_API_KEY',
            'JOY_MEDIA_OPENROUTER_API_KEY',
            'JOY_MEDIA_SESSION_TOKEN',
          ])};
          const clean = credentialVariables.every((key) => !process.env[key]);
          process.stdout.write(error.message === 'live provider call blocked in tests' && clean ? 'blocked|clean' : 'unexpected');
        });`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          OPENROUTER_API_KEY: 'sk-test-REDACTED-0000',
          KILO_API_KEY: 'sk-test-REDACTED-0000',
          OPENAI_API_KEY: 'sk-test-REDACTED-0000',
          ANTHROPIC_API_KEY: 'sk-test-REDACTED-0000',
          GEMINI_API_KEY: 'sk-test-REDACTED-0000',
          JOY_MEDIA_OPENROUTER_API_KEY: 'sk-test-REDACTED-0000',
          JOY_MEDIA_SESSION_TOKEN: 'sk-test-REDACTED-0000',
        },
      },
    );
    expect(result).toMatchObject({ status: 0, stdout: 'blocked|clean', stderr: '' });
    expect(result.stdout).toBe('blocked|clean');
    expect(result.stderr).toBe('');
  });
});
