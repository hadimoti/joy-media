import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const accountWeb = readFileSync(
  new URL('../../../deploy/joy-media-account-web.nginx.conf', import.meta.url),
  'utf8',
);
const joyMedia = readFileSync(
  new URL('../../../deploy/joy-media.nginx.conf', import.meta.url),
  'utf8',
);

describe('agent SSE nginx locations', () => {
  it('disables buffering on the account-web agent location before generic API proxy', () => {
    const agentIndex = accountWeb.indexOf('location ~ ^/api/v1/agent(?:/|$)');
    const genericIndex = accountWeb.indexOf('location ~ ^/api/v1/(?:auth|devices|account');
    expect(agentIndex).toBeGreaterThanOrEqual(0);
    expect(agentIndex).toBeLessThan(genericIndex);
    expect(accountWeb.slice(agentIndex, genericIndex)).toContain('proxy_buffering off;');
    expect(accountWeb.slice(genericIndex)).not.toMatch(/(?:auth\|devices\|account[^\n]*\|agent)/);
  });

  it('disables buffering on the JOY host agent location before the generic API proxy', () => {
    const agentIndex = joyMedia.indexOf('location ^~ /api/v1/agent/');
    const genericIndex = joyMedia.indexOf('location ^~ /api/ {');
    expect(agentIndex).toBeGreaterThanOrEqual(0);
    expect(agentIndex).toBeLessThan(genericIndex);
    expect(joyMedia.slice(agentIndex, genericIndex)).toContain('proxy_buffering off;');
  });
});
