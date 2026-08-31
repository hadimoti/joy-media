import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const output = resolve(import.meta.dirname, '../dist/joy-media-desktop-dev.json');
const manifest = {
  format: 'joy-media-desktop-dev-package/v1',
  appId: 'ir.joyteam.joy-media',
  platform: 'windows-x64',
  shell: 'host-contract-only',
  runtime: { node: '>=22', nativeHost: 'not-selected' },
  signing: {
    status: 'blocked',
    reason: 'No owner-approved native runtime or code-signing certificate/toolchain is declared.',
  },
  boundaries: {
    origins: 'allowlisted',
    ipc: 'allowlisted-versioned-channels',
    files: 'opaque-references',
    deepLinks: 'joy://open/project/<uuid>',
    worker: 'status-and-preference-only',
  },
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote unsigned development package manifest: ${output}`);
