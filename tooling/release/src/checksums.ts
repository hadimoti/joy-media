import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ChecksumEntry {
  readonly hash: string;
  readonly name: string;
  readonly line: number;
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function payloadNames(directory: string): { readonly names: string[]; readonly errors: string[] } {
  const names: string[] = [];
  const errors: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === 'SHA256SUMS.txt') continue;
    if (!entry.isFile()) {
      errors.push('staging contains a non-file payload entry: ' + entry.name);
      continue;
    }
    names.push(entry.name);
  }

  return { names, errors };
}

function readChecksumEntries(directory: string): {
  readonly entries: ChecksumEntry[];
  readonly errors: string[];
} {
  const checksumPath = join(directory, 'SHA256SUMS.txt');
  const entries: ChecksumEntry[] = [];
  const errors: string[] = [];

  let contents: string;
  try {
    contents = readFileSync(checksumPath, 'utf8');
  } catch {
    return { entries, errors: ['SHA256SUMS.txt is missing or unreadable'] };
  }

  const lines = contents.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) errors.push('SHA256SUMS.txt contains no entries');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const match = /^([a-fA-F0-9]{64}) {2}([^/\\]+)$/.exec(line);
    if (!match) {
      errors.push(
        'SHA256SUMS.txt:' +
          lineNumber +
          ': malformed entry; expected <64 hex>  <name> without path separators',
      );
      continue;
    }

    const name = match[2];
    if (name.toLowerCase() === 'sha256sums.txt') {
      errors.push('SHA256SUMS.txt:' + lineNumber + ': must not list SHA256SUMS.txt');
      continue;
    }
    entries.push({ hash: match[1].toLowerCase(), name, line: lineNumber });
  }

  return { entries, errors };
}

function verifyDirectory(directory: string): readonly string[] {
  let directoryStat;
  try {
    directoryStat = statSync(directory);
  } catch {
    return ['staging directory does not exist: ' + directory];
  }
  if (!directoryStat.isDirectory()) return ['staging path is not a directory: ' + directory];

  const payload = payloadNames(directory);
  const parsed = readChecksumEntries(directory);
  const errors = [...payload.errors, ...parsed.errors];
  const expectedNames = new Set(payload.names);
  const listedNames = new Set<string>();

  for (const entry of parsed.entries) {
    if (listedNames.has(entry.name)) {
      errors.push('SHA256SUMS.txt:' + entry.line + ': duplicate entry for ' + entry.name);
      continue;
    }
    listedNames.add(entry.name);

    if (!expectedNames.has(entry.name)) {
      errors.push(
        'SHA256SUMS.txt:' + entry.line + ': entry does not match payload file ' + entry.name,
      );
      continue;
    }

    const actualHash = sha256(join(directory, entry.name));
    if (actualHash !== entry.hash) {
      errors.push('SHA256SUMS.txt:' + entry.line + ': hash mismatch for ' + entry.name);
    }
  }

  for (const name of payload.names) {
    if (!listedNames.has(name)) errors.push('SHA256SUMS.txt: missing entry for ' + name);
  }

  return errors;
}

function writeDirectory(directory: string): readonly string[] {
  let directoryStat;
  try {
    directoryStat = statSync(directory);
  } catch {
    return ['staging directory does not exist: ' + directory];
  }
  if (!directoryStat.isDirectory()) return ['staging path is not a directory: ' + directory];

  const payload = payloadNames(directory);
  if (payload.errors.length > 0) return payload.errors;

  const content = payload.names
    .map((name) => sha256(join(directory, name)) + '  ' + name)
    .join('\n');
  writeFileSync(join(directory, 'SHA256SUMS.txt'), content ? content + '\n' : '', 'utf8');
  return verifyDirectory(directory);
}

function parseDirectoryArgument(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--dir' || !args[1]) {
    throw new Error('expected --dir <staging>');
  }
  return resolve(args[1]);
}

function runCli(args: readonly string[]): void {
  const [command, ...options] = args;
  if (command !== 'verify' && command !== 'write') {
    throw new Error('expected the verify or write subcommand');
  }

  const directory = parseDirectoryArgument(options);
  if (command === 'verify') {
    const errors = verifyDirectory(directory);
    if (errors.length > 0) {
      for (const error of errors) console.error(error);
      process.exitCode = 1;
      return;
    }
    const names = payloadNames(directory).names;
    console.log('verified ' + names.length + ' payload file' + (names.length === 1 ? '' : 's'));
    return;
  }

  const errors = writeDirectory(directory);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  const names = payloadNames(directory).names;
  console.log(
    'wrote SHA256SUMS.txt for ' + names.length + ' payload file' + (names.length === 1 ? '' : 's'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
