import { resolveContentFontFamily } from '@joy-media/project-schema';

/** Keep a new Motion Studio layer aligned with the motion-core system fallback. */
export function resolveMotionStudioFontFamily(fontFamily: string | undefined): string {
  return resolveContentFontFamily(fontFamily ?? 'system-ui');
}
