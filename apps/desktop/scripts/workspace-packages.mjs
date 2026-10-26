// Internal workspace packages that the packaged desktop app needs at runtime. The desktop manifest lists every internal
// dependency the main process imports, so the list is read from it. The Worker is not a desktop dependency, so its runtime
// closure is listed here: export-core and job-protocol import project-schema and render-ir.
export const WORKER_RUNTIME_PACKAGES = [
  'provider-sdk',
  'project-schema',
  'project-persistence',
  'export-core',
  'job-protocol',
  'render-ir',
];

const SCOPE = '@joy-media/';

export function internalPackageDirectories(desktopManifest) {
  const fromDesktop = Object.keys(desktopManifest.dependencies ?? {})
    .filter((name) => name.startsWith(SCOPE))
    .map((name) => name.slice(SCOPE.length));
  return [...new Set([...fromDesktop, ...WORKER_RUNTIME_PACKAGES])];
}
