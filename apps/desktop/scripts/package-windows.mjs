/* global process, URL */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signingConfiguration } from './sign-windows-artifacts.mjs';

// Validate before any build output is produced. The actual certificate remains in
// the owner-controlled Windows certificate store; tests can exercise this check
// with synthetic environment values and never need a real certificate.
signingConfiguration(process.env);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(command, ['--filter', '@joy-media/desktop', 'package:win'], {
  cwd: root,
  env: { ...process.env, JOY_MEDIA_REQUIRE_SIGNING: '1' },
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
