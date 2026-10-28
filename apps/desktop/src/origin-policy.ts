// Local-only: the packaged renderer and the dev server are the only editor origins.
// No remote origin is trusted (PLAN-v4 §4a; ADR-0043).
export const ALLOWED_EDITOR_ORIGINS = [
  'joy-media-app://renderer',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;
export function isAllowedEditorOrigin(origin: string): boolean {
  return (ALLOWED_EDITOR_ORIGINS as readonly string[]).includes(origin);
}
export function assertAllowedEditorOrigin(origin: string): void {
  if (!isAllowedEditorOrigin(origin)) throw new Error(`Blocked editor origin: ${origin}`);
}
