import { describe, expect, it } from 'vitest';
import {
  isRetiredJoyAgentRoute,
  JOY_AGENT_RETIRED_ROUTE_RESPONSE,
} from './joy-agent-route-retirement.js';

describe('built-in JOY Agent route retirement', () => {
  it.each([
    '/v1/projects/project-1/creative-brief',
    '/v1/projects/project-1/joy-code/plans',
    '/v1/projects/project-1/creative-brief-opt-in',
    '/v1/projects/project-1/joy-code-opt-in',
  ])('identifies %s as retired', (pathname) => {
    expect(isRetiredJoyAgentRoute(pathname)).toBe(true);
  });

  it('does not catch unrelated project or media routes', () => {
    expect(isRetiredJoyAgentRoute('/v1/projects/project-1/document')).toBe(false);
    expect(isRetiredJoyAgentRoute('/v1/projects/project-1/jobs')).toBe(false);
    expect(JOY_AGENT_RETIRED_ROUTE_RESPONSE).toEqual({
      code: 'JOY_AGENT_BUILT_IN_REQUIRED',
      message: expect.stringContaining('built-in JOY Agent Engine'),
    });
  });
});
