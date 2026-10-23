import { describe, expect, it } from 'vitest';
import { parseChecksumFile, verifyArtifacts } from './artifact-integrity.mjs';

const CANDIDATE_SHA = 'c'.repeat(40);

describe('verifyArtifacts', () => {
  // The manifest check only means something when the caller names the artifacts the packager
  // records, so omitting the names must fail rather than skip the check.
  it('fails closed when the caller does not name the packaged artifacts', () => {
    const checksums = parseChecksumFile(`${'a'.repeat(64)}  joy-media.exe\n`);
    const releaseManifest = { targetCommit: CANDIDATE_SHA, artifacts: [] };
    const verify = (recordedNames: string[] | undefined) =>
      verifyArtifacts({
        artifacts: [],
        checksums,
        bytesByName: () => null,
        candidateSha: CANDIDATE_SHA,
        releaseManifest,
        recordedNames,
      });
    expect(() => verify(undefined)).toThrow(/packaged artifact names are required/u);
    expect(() => verify([])).toThrow(/packaged artifact names are required/u);
  });
});
