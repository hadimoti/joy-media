import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve the per-user JOY Media data directory. */
export function getJoyMediaHome(): string {
  const configuredHome = process.env.JOY_MEDIA_HOME?.trim();
  return configuredHome || join(homedir(), '.joy-media');
}
