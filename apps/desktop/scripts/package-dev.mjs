import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
const output = resolve(import.meta.dirname, '../dist/joy-media-desktop-dev.json');
const manifest = {
  format: 'joy-media-desktop-dev-package/v1',
  appId: 'ir.joyteam.joy-media',
  platform: 'windows-x64',
  shell: 'electron-main-preload-bootstrap',
  runtime: { node: '>=22', nativeHost: 'electron@44 (unsigned, dev-only)' },
  signing: {
    status: 'blocked',
    reason: 'No owner-approved code-signing certificate/toolchain is declared (wave 7).',
  },
  boundaries: {
    origins: 'allowlisted',
    ipc: 'allowlisted-versioned-channels',
    files: 'opaque-references',
    deepLinks: 'joy://open/project/<uuid>',
    worker: 'supervised-child-process-status-and-preference',
  },
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
stdout.write(`Wrote unsigned development package manifest: ${output}\n`);
