/**
 * VPS service retirement flag (JOY Media desktop migration, wave 6) — a coarser kill switch
 * than wave 4's `hosted-route-retirement.ts`. That module fails closed on 7 individually
 * enumerated routes with an explicit `410` migration response; this one is a single flag that,
 * when enabled, makes `options.authentication.authenticate` (the legacy actor identity every
 * project/worker/job route in `http-server.ts` requires) always return `undefined` — the
 * entire legacy hosted-editor control-plane surface stops authenticating in one step, the same
 * way it already behaves today whenever `durableControlPlane` is unconfigured.
 *
 * Defaults to `false`; this worktree never sets `JOY_MEDIA_LEGACY_EDITOR_RETIRED`. Flipping it
 * on a real deployment is reserved for Codex, same stop condition as every other retirement
 * flag in this migration (see the lead brief's "retire/restart VPS services" gate).
 */

export const LEGACY_EDITOR_RETIREMENT_ENV_VAR = 'JOY_MEDIA_LEGACY_EDITOR_RETIRED';

export function readLegacyEditorRetired(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[LEGACY_EDITOR_RETIREMENT_ENV_VAR] === 'true';
}
