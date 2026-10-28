// Which files `package-release.mjs` copies from the desktop build folder into a package (plan section 10d, G0 item 2; OA3).
// The test-only instrumentation folder is staged only into an instrumented package (the package-release option). Test files are never staged.

const INSTRUMENTATION_FOLDER = 'test-instrumentation';
const TEST_FILE = /\.test\.(js|d\.ts)(\.map)?$/;

/** True when the path names the test-only instrumentation folder or a file inside it. */
export function isTestInstrumentationPath(path) {
  return path.replaceAll('\\', '/').split('/').includes(INSTRUMENTATION_FOLDER);
}

/** True when `cp` should copy `source`, a path under the desktop build folder, into the package. */
export function keepDistPath(source, { instrumented }) {
  const normalised = source.replaceAll('\\', '/');
  if (TEST_FILE.test(normalised)) return false;
  if (isTestInstrumentationPath(normalised)) return instrumented;
  return true;
}
