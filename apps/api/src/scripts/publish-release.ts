import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  createEd25519ReleaseSigner,
  readReleaseSigningKeyFromCredential,
} from '../release-signing.js';
import { ReleaseMetadataService } from '../release-metadata-service.js';
import { createReleasePublisher } from '../release-publish.js';
import { runReleasePublish } from '../release-publish-cli.js';

/**
 * The direct-call release publish pipeline `release-metadata-service.ts` and
 * `release-publish.ts` document — deliberately not an HTTP route (see their module docs).
 * Run only by an operator, only after the owner has provisioned both a real
 * `JOY_MEDIA_DATABASE_URL` and the `joy-media-release-signing-key` systemd credential:
 *
 *   pnpm --filter @joy-media/api release:publish path/to/release.json
 *
 * where `release.json` is `{id, channel, version, downloadUrl, sha256, minSupportedVersion?}`
 * (see `release-publish-cli.ts`'s `parseReleasePublishInput` for exact validation). This
 * worktree has neither a real database nor that credential, so this script has never been run
 * here — it exists so the wave 7 publish pipeline has an actual caller instead of dead code
 * with no path from a release artifact to a `release_metadata` row.
 *
 * Deliberately unmocked, untested wiring at the edge (real `pg.Pool`, real credential-file
 * read, real `process.argv`) — the same "thin, untested shell around tested logic" shape as
 * `server.ts` itself. All the logic that can be unit-tested without a live database or a real
 * key lives in `release-publish-cli.ts` and is tested there.
 */
async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (filePath === undefined) {
    console.error('Usage: pnpm --filter @joy-media/api release:publish <release-payload.json>');
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env['JOY_MEDIA_DATABASE_URL'];
  if (databaseUrl === undefined) {
    console.error('JOY_MEDIA_DATABASE_URL is not configured; refusing to publish a release.');
    process.exitCode = 1;
    return;
  }

  const signingKey = readReleaseSigningKeyFromCredential((path, encoding) =>
    readFileSync(path, encoding),
  );
  if (signingKey === undefined) {
    console.error(
      'The joy-media-release-signing-key systemd credential is not present; refusing to publish a release.',
    );
    process.exitCode = 1;
    return;
  }

  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const signer = createEd25519ReleaseSigner(signingKey);
    const metadata = new ReleaseMetadataService({ pool });
    const publisher = createReleasePublisher({ metadata, signer });
    const record = await runReleasePublish(raw, publisher);
    console.log(JSON.stringify(record, null, 2));
  } finally {
    await pool.end();
  }
}

await main();
