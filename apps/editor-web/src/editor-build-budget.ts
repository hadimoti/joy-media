/** Minimal Vite manifest shape used by the editor's initial-JS budget check. */
export interface EditorManifestChunk {
  readonly file: string;
  readonly src?: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
}

export type EditorManifest = Readonly<Record<string, EditorManifestChunk>>;

/** Return the static-import closure of the HTML entry, excluding dynamic imports. */
export function initialEntryFiles(manifest: EditorManifest): readonly string[] {
  const entry = Object.entries(manifest).find(
    ([key, chunk]) =>
      (chunk.isEntry === true && (chunk.src === 'index.html' || key === 'index.html')) ||
      (chunk.src === 'index.html' && key === 'index.html'),
  );
  if (entry === undefined) return [];

  const files: string[] = [];
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (chunk === undefined) return;
    files.push(chunk.file);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(entry[0]);
  return files;
}
