export const ALLOWED_EDITOR_ORIGINS = [
  'https://joyst.ir',
  'https://www.joyst.ir',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;
export function isAllowedEditorOrigin(origin: string): boolean {
  return (ALLOWED_EDITOR_ORIGINS as readonly string[]).includes(origin);
}
export function assertAllowedEditorOrigin(origin: string): void {
  if (!isAllowedEditorOrigin(origin)) throw new Error(`Blocked editor origin: ${origin}`);
}
