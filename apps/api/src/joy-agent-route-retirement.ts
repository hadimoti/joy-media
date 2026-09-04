/** Former server-side reasoning routes are intentionally retired after the
 * built-in browser Worker became the only JOY editing engine. */
const RETIRED_JOY_AGENT_ROUTE =
  /^\/v1\/projects\/[^/]+\/(?:creative-brief|joy-code\/plans|creative-brief-opt-in|joy-code-opt-in)$/;

export function isRetiredJoyAgentRoute(pathname: string): boolean {
  return RETIRED_JOY_AGENT_ROUTE.test(pathname);
}

export const JOY_AGENT_RETIRED_ROUTE_RESPONSE = Object.freeze({
  code: 'JOY_AGENT_BUILT_IN_REQUIRED',
  message: 'Use the built-in JOY Agent Engine configured in this browser session.',
});
