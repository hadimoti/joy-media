import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Release-plan gate only. The actual Windows signing certificate and packaging toolchain are
 * owner-provided operations; this script refuses to create a public release when either is
 * absent. `package:dev` remains the only unsigned local package command.
 */
const output = resolve(import.meta.dirname, '../dist/joy-media-release-plan.json');
const isStagingUnpacked = process.argv.includes('--staging') || process.argv.includes('--unpacked');

if (isStagingUnpacked) {
  // Staging/unpacked builds are not a public release: no certificate or release-signing key is
  // required, and the plan is explicitly marked unpacked so nothing downstream mistakes it for a
  // signed, distributable artifact.
  const plan = {
    format: 'joy-media-release-plan/v1',
    appId: 'ir.joyteam.joy-media',
    platform: 'windows-x64',
    status: 'staging-unpacked',
    signing: 'unsigned',
    reasons: [
      'staging/unpacked build requested via --staging/--unpacked; certificate and release-signing key checks are skipped',
      'not for distribution: unsigned, unpacked, staging-only artifact',
    ],
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  process.stderr.write(`Staging/unpacked release plan written to ${output}\n`);
  process.exitCode = 0;
} else {
  const certificatePath = process.env.JOY_MEDIA_WINDOWS_CERTIFICATE_PATH;
  const releasePublicKey = process.env.JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY;
  const blockedReasons = [
    ...(certificatePath === undefined
      ? ['JOY_MEDIA_WINDOWS_CERTIFICATE_PATH is not configured']
      : []),
    ...(releasePublicKey === undefined
      ? ['JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY is not configured']
      : []),
    'owner-approved Windows packaging/signing toolchain is not enabled by this scaffold',
  ];
  const plan = {
    format: 'joy-media-release-plan/v1',
    appId: 'ir.joyteam.joy-media',
    platform: 'windows-x64',
    status: 'blocked',
    signing: 'owner-gated',
    reasons: blockedReasons,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  process.stderr.write(`Release packaging is blocked; wrote evidence plan to ${output}\n`);
  process.exitCode = 2;
}
