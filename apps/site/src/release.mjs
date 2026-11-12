// Release facts shared by the site renderer, the build script and the tests. Pure functions, no I/O.
// Rules follow PLAN-v4 section 7b: the payload is the release files except SHA256SUMS.txt, and each
// SHA256SUMS.txt line is "<64 lowercase hex>  <name>" with names equal to the payload set.

export const REPOSITORY_URL = 'https://github.com/hadimoti/joy-media';

/** Shown in place of a hash until a tag's SHA256SUMS.txt is supplied. It is never a real digest. */
export const PLACEHOLDER_HASH = 'PENDING';

/**
 * @param {string} tag
 * @returns {string} the tag, when it has the form v<major>.<minor>.<patch>
 */
export function assertReleaseTag(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`release tag must look like v1.2.3, got: ${tag}`);
  }
  return tag;
}

/**
 * @param {string} tag
 * @returns {string[]} the payload file names for a tag, in display order
 */
export function payloadNames(tag) {
  const version = assertReleaseTag(tag).slice(1);
  return [
    'joy-media-setup.exe',
    `joy-media-windows-x64-v${version}.zip`,
    'joy-media.exe',
    'joy-worker.exe',
    'joy-media-bundle.mjs',
    'joy-media-release-manifest.json',
  ];
}

/**
 * @param {string} tag
 * @param {string} name
 * @returns {string} the tag-specific GitHub download URL (never /latest/download/)
 */
export function downloadUrl(tag, name) {
  return `${REPOSITORY_URL}/releases/download/${assertReleaseTag(tag)}/${name}`;
}

/**
 * Parses a tag's SHA256SUMS.txt and checks it against the payload set.
 *
 * @param {string} text the file contents
 * @param {string} tag the release tag the file belongs to
 * @returns {Map<string, string>} file name to lowercase SHA-256 hex
 */
export function parseSha256Sums(text, tag) {
  const byName = new Map();
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  lines.forEach((line, index) => {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!match) {
      throw new Error(`SHA256SUMS.txt line ${index + 1} is not "<64 lowercase hex>  <name>"`);
    }
    const [, hash, name] = match;
    if (name === 'SHA256SUMS.txt') {
      throw new Error('SHA256SUMS.txt must not list itself');
    }
    if (byName.has(name)) {
      throw new Error(`SHA256SUMS.txt lists ${name} more than once`);
    }
    byName.set(name, hash);
  });
  const expected = [...payloadNames(tag)].sort().join('\n');
  const actual = [...byName.keys()].sort().join('\n');
  if (expected !== actual) {
    throw new Error(
      `SHA256SUMS.txt names do not match the payload set. Expected: ${expected.replace(/\n/g, ', ')}. Got: ${actual.replace(/\n/g, ', ')}`,
    );
  }
  return byName;
}
