import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The installer's own record of its payload: one `<sha256>  <relative path>` line per file in the application
 * folder. The packager writes it beside the release archive, and the setup embeds it, so the setup checks every
 * extracted file against it before it replaces an installed version. The archive itself does not change.
 */
export const PAYLOAD_MANIFEST_NAME = 'payload-manifest.txt';

const PAYLOAD_LINE = /^([0-9a-f]{64}) {2}(.+)$/u;

/** A path inside the payload: forward slashes, no empty, dot or parent segments, and never absolute. */
export function isSafePayloadPath(path) {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export async function buildPayloadManifest(root) {
  const files = await listFiles(root);
  const lines = [`# JOY Media installer payload: ${files.length} files`];
  for (const path of files) {
    lines.push(`${await sha256File(join(root, ...path.split('/')))}  ${path}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Returns the expected SHA-256 for each payload path. Malformed, unsafe or duplicate lines are refused. */
export function parsePayloadManifest(text) {
  const entries = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/u, '');
    if (line === '' || line.startsWith('#')) continue;
    const match = PAYLOAD_LINE.exec(line);
    if (match === null || !isSafePayloadPath(match[2])) {
      throw new Error(`Malformed payload manifest line: ${line}`);
    }
    if (entries.has(match[2])) throw new Error(`Duplicate payload manifest entry: ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  if (entries.size === 0) throw new Error('The payload manifest lists no files.');
  return entries;
}

async function listFiles(root, prefix = '') {
  const found = [];
  const directory = prefix === '' ? root : join(root, ...prefix.split('/'));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(root, path)));
    else if (entry.isFile()) found.push(path);
    else throw new Error(`Unsupported entry in the payload: ${path}`);
  }
  return found.sort();
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
