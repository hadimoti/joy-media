import { createHash } from 'node:crypto';

// Artifact integrity for the release gate. Expected digests come from an independent checksum file
// (SHA256SUMS.txt) that the packager wrote and the evidence store retained. The gate hashes the
// artifact bytes itself and never compares a digest with itself. A receipt's digest is only a
// cross-check against the checksum file, not a source of truth.

const CHECKSUM_LINE = /^([0-9a-f]{64}) [ *](.+)$/u;

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Parses `sha256sum` output: one `<64 hex> <name>` line per artifact, with `*` marking binary mode.
// A malformed line, a path instead of a bare file name, or a repeated name is an error.
export function parseChecksumFile(text) {
  const entries = new Map();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const match = CHECKSUM_LINE.exec(line);
    if (match === null) throw new Error(`checksum line is malformed: ${line}`);
    const [, digest, name] = match;
    if (name === '.' || name === '..' || /[\\/]/u.test(name)) {
      throw new Error(`checksum entry is not a bare file name: ${name}`);
    }
    if (entries.has(name)) throw new Error(`checksum file lists ${name} more than once`);
    entries.set(name, digest);
  }
  return entries;
}

// Verifies each required artifact against the independent checksum file and the artifact bytes.
// `bytesByName` returns the artifact's bytes, or null when the artifact is absent.
export function verifyArtifacts({ artifacts, checksums, bytesByName, candidateSha, manifest }) {
  if (manifest?.candidateSha !== candidateSha) {
    throw new Error(
      `artifact manifest is for a different candidate SHA (${String(manifest?.candidateSha)}); expected ${candidateSha}`,
    );
  }
  return artifacts.map(({ name, receiptSha256 }) => {
    const expectedSha256 = checksums.get(name);
    if (expectedSha256 === undefined) throw new Error(`no independent checksum for ${name}`);
    if (receiptSha256 !== expectedSha256) {
      throw new Error(
        `Windows receipt digest for ${name} does not match the independent checksum file`,
      );
    }
    const bytes = bytesByName(name);
    if (bytes === null || bytes === undefined) throw new Error(`artifact is missing: ${name}`);
    const observedSha256 = sha256Hex(bytes);
    if (observedSha256 !== expectedSha256) {
      throw new Error(
        `hash mismatch for ${name}: expected ${expectedSha256}, observed ${observedSha256}`,
      );
    }
    return { name, expectedSha256, observedSha256 };
  });
}
