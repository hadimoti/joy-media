// The pure assertions of tests/desktop/installer-package-check.mjs, kept here so unit tests can run them on
// fake archives, manifests and sources. The check script itself needs a real build, so it cannot run in vitest.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

/**
 * The entry names of a zip archive's bytes, read from its central directory. Nothing is extracted, so the
 * names are exactly what the archive stores.
 */
export function zipEntryNamesFromBuffer(data, label = 'zip') {
  const endRecord = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endRecord >= 0, `${label} has no end-of-central-directory record`);
  const entryCount = data.readUInt16LE(endRecord + 10);
  let offset = data.readUInt32LE(endRecord + 16);
  const names = [];
  for (let index = 0; index < entryCount; index++) {
    assert.strictEqual(data.readUInt32LE(offset), 0x02014b50, 'Bad central directory entry');
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    names.push(data.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** The entry names of a zip file on disk. */
export function zipEntryNames(zipPath) {
  return zipEntryNamesFromBuffer(readFileSync(zipPath), zipPath);
}

/**
 * Throws unless the zip has entries, none of them names a path with a backslash, and every name in
 * `requiredNames` is present. Windows PowerShell 5.1 `Compress-Archive` writes backslashes, which other
 * unzip tools then extract as one file name with backslashes in it.
 */
export function assertZipEntryNames(entries, requiredNames = []) {
  assert.ok(entries.length > 0, 'The release zip has no entries');
  assert.deepStrictEqual(
    entries.filter((name) => name.includes('\\')),
    [],
    'The release zip must use forward slashes in every entry name',
  );
  for (const name of requiredNames) {
    assert.ok(entries.includes(name), `The release zip does not contain ${name}`);
  }
}

/** The lowercase SHA-256 of a file's bytes, as SHA256SUMS.txt lists it. */
export function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * The digest that a SHA256SUMS.txt text lists for one file name, or undefined when it lists that name zero or
 * more than one time. Lines follow "<64 hex>  <name>"; a name that only ends the same way does not match.
 */
export function listedSha256(sumsText, fileName) {
  const digests = sumsText.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64}) {2}(.+)$/.exec(line);
    return match && match[2] === fileName ? [match[1].toLowerCase()] : [];
  });
  return digests.length === 1 ? digests[0] : undefined;
}

/** Throws unless the release manifest lists every named file with a digest. */
export function assertManifestListsFiles(manifest, fileNames) {
  for (const fileName of fileNames) {
    assert.ok(
      manifest.artifacts.some((artifact) => artifact.fileName === fileName && artifact.sha256),
      `The release manifest does not list ${fileName}`,
    );
  }
}

/**
 * Throws unless the source of package-release.mjs writes the plan status "unsigned-release" and never
 * "blocked". (The script does its work when imported, so the check reads its source.)
 */
export function assertReleasePlanUnsigned(releaseScriptSource) {
  assert.match(
    releaseScriptSource,
    /status: 'unsigned-release'/,
    'The release plan must say unsigned-release',
  );
  assert.doesNotMatch(
    releaseScriptSource,
    /status: 'blocked'/,
    'The release plan must not say blocked',
  );
}
