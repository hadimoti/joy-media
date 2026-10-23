import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from './retain-release-artifacts.mjs';

const candidate = 'a'.repeat(40);
const runId = '12345';
const attempt = '2';
const setupName = 'joy-media-setup.exe';
const zipName = 'joy-media-windows-x64-v1.0.2.zip';
const workerName = 'standalone/resources/app/worker/joy-worker.exe';
const sumsName = 'SHA256SUMS.txt';

// Creating a symlink on Windows needs a privilege some hosts do not grant. Where it is denied, the
// symlink case is reported as skipped, never as passed.
const canSymlink = (() => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'retain-release-link-probe-'));
  try {
    writeFileSync(join(probeRoot, 'target'), '');
    symlinkSync(join(probeRoot, 'target'), join(probeRoot, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

// Builds a staged tree whose manifest lists every file in it, SHA256SUMS.txt included. `sumsText`
// replaces the checksum file's content, and `null` leaves the file out.
function buildStaged(root: string, sumsText: string | null | undefined = undefined): string {
  const staged = join(root, 'staged');
  const contents: Record<string, Buffer> = {
    [setupName]: Buffer.from('setup-bytes'),
    [zipName]: Buffer.from('zip-bytes'),
    [workerName]: Buffer.from('worker-bytes'),
  };
  if (sumsText !== null) {
    contents[sumsName] = Buffer.from(
      sumsText ??
        `${sha256(contents[setupName]!)}  ${setupName}\n${sha256(contents[zipName]!)}  ${zipName}\n`,
    );
  }
  for (const [name, bytes] of Object.entries(contents)) {
    const path = join(staged, ...name.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
  }
  const manifest = {
    format: 'joy-media-release-artifacts',
    candidateSha: candidate,
    runId: Number(runId),
    attempt: Number(attempt),
    version: '1.0.2',
    files: Object.entries(contents).map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  writeFileSync(join(staged, 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return staged;
}

async function withWork<T>(body: (work: string) => Promise<T> | T): Promise<T> {
  const work = mkdtempSync(join(tmpdir(), 'retain-release-'));
  try {
    return await body(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const retainedDir = (evidence: string): string =>
  join(evidence, candidate, `${runId}-${attempt}-release-artifacts`);

describe('retain-release-artifacts', () => {
  it('retains a verified tree byte for byte, and refuses a second write under the same run', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(work);
      const evidence = join(work, 'evidence');
      await run([staged, candidate, runId, attempt, evidence]);
      expect(readFileSync(join(retainedDir(evidence), setupName), 'utf8')).toBe('setup-bytes');
      expect(readFileSync(join(retainedDir(evidence), workerName), 'utf8')).toBe('worker-bytes');
      await expect(run([staged, candidate, runId, attempt, evidence])).rejects.toThrow(
        /write-once/u,
      );
    });
  });

  it('fails closed on a staged file that differs from its manifest digest, and retains nothing', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(work);
      // Same length as the original, so the size check passes and the digest check is the one that fails.
      writeFileSync(join(staged, setupName), 'SETUP-BYTES');
      const evidence = join(work, 'evidence');
      await expect(run([staged, candidate, runId, attempt, evidence])).rejects.toThrow(
        /sha256 mismatch for joy-media-setup\.exe/u,
      );
      expect(existsSync(join(evidence, candidate))).toBe(false);
    });
  });

  it('fails when the manifest lists a file that is missing', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(work);
      rmSync(join(staged, zipName));
      await expect(
        run([staged, candidate, runId, attempt, join(work, 'evidence')]),
      ).rejects.toThrow(/does not hold exactly the manifest's files/u);
    });
  });

  it('fails when the staged tree holds a file the manifest does not list', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(work);
      writeFileSync(join(staged, 'unlisted.exe'), 'extra');
      await expect(
        run([staged, candidate, runId, attempt, join(work, 'evidence')]),
      ).rejects.toThrow(/does not hold exactly the manifest's files/u);
    });
  });

  it('fails when the manifest names another candidate or another run', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(work);
      await expect(run([staged, 'b'.repeat(40), runId, attempt, join(work, 'a')])).rejects.toThrow(
        /candidateSha does not match/u,
      );
      await expect(run([staged, candidate, '999', attempt, join(work, 'b')])).rejects.toThrow(
        /run identity does not match/u,
      );
    });
  });

  it('fails when SHA256SUMS.txt disagrees with the file it names', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(work, `${'0'.repeat(64)}  ${setupName}\n`);
      await expect(
        run([staged, candidate, runId, attempt, join(work, 'evidence')]),
      ).rejects.toThrow(/SHA256SUMS\.txt disagrees with joy-media-setup\.exe/u);
    });
  });

  it('accepts a SHA256SUMS.txt written with CRLF line endings', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(
        work,
        `${sha256('setup-bytes')}  ${setupName}\r\n${sha256('zip-bytes')}  ${zipName}\r\n`,
      );
      await expect(
        run([staged, candidate, runId, attempt, join(work, 'evidence')]),
      ).resolves.toMatch(/retained and re-verified 4 file/u);
    });
  });

  it('refuses an evidence root inside the checkout, _work or _temp', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(work);
      await expect(
        run([staged, candidate, runId, attempt, join(work, '_work', 'evidence')]),
      ).rejects.toThrow(/must be outside the checkout/u);
      await expect(
        run([staged, candidate, runId, attempt, join(work, 'checkout'), '--verify-only'], {
          RUNNER_WORKSPACE: join(work, 'checkout'),
        }),
      ).rejects.toThrow(/must be outside the checkout/u);
    });
  });

  it.skipIf(!canSymlink)('refuses a staged symlink', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(work);
      symlinkSync(join(staged, setupName), join(staged, 'link.exe'));
      await expect(
        run([staged, candidate, runId, attempt, join(work, 'evidence')]),
      ).rejects.toThrow(/symlinks are not allowed/u);
    });
  });

  it('verifies a retained copy without writing to the store', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(work);
      const evidence = join(work, 'evidence');
      await run([staged, candidate, runId, attempt, evidence]);
      const before = readFileSync(join(retainedDir(evidence), 'artifact-manifest.json'), 'utf8');
      await expect(
        run(['-', candidate, runId, attempt, evidence, '--verify-only']),
      ).resolves.toMatch(/verified 4 retained file/u);
      expect(readFileSync(join(retainedDir(evidence), 'artifact-manifest.json'), 'utf8')).toBe(
        before,
      );
    });
  });

  it('fails verify mode when nothing is retained, or when the retained copy was altered', async () => {
    await withWork(async (work) => {
      const staged = buildStaged(work);
      const evidence = join(work, 'evidence');
      await expect(
        run(['-', candidate, runId, attempt, evidence, '--verify-only']),
      ).rejects.toThrow(/no retained release artifacts/u);
      await run([staged, candidate, runId, attempt, evidence]);
      writeFileSync(join(retainedDir(evidence), setupName), 'SETUP-BYTES');
      await expect(
        run(['-', candidate, runId, attempt, evidence, '--verify-only']),
      ).rejects.toThrow(/sha256 mismatch for joy-media-setup\.exe/u);
    });
  });
});
