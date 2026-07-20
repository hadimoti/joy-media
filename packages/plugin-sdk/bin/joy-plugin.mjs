#!/usr/bin/env node
/** Developer CLI wrapper; package creation I/O stays here, SDK logic stays pure. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPluginScaffold } from '../dist/index.js';

const [command, target, id, name, publisher] = process.argv.slice(2);
if (command !== 'init' || !target || !id || !name || !publisher) {
  console.error('usage: joy-plugin init <directory> <reverse-dns-id> <name> <publisher>');
  process.exitCode = 2;
} else {
  const scaffold = createPluginScaffold({ id, name, publisher, kind: 'panel' });
  const directory = resolve(target);
  mkdirSync(directory, { recursive: true });
  for (const [path, contents] of Object.entries(scaffold.files)) {
    const output = resolve(directory, path);
    mkdirSync(resolve(output, '..'), { recursive: true });
    writeFileSync(output, contents, 'utf8');
  }
  console.log(`created ${scaffold.manifest.id} in ${directory}`);
}
