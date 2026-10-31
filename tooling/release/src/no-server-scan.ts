import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_FORBIDDEN_STRINGS = [
  'joyst.ir/api',
  'joyst.ir/v1/auth',
  '/v1/entitlements',
  '/v1/billing',
  '/v1/releases',
  'getRemoteApiBaseUrl',
  'alchemy',
  'usdc',
];

const PACKAGED_FORBIDDEN_STRINGS = [
  'gpu-events.jsonl',
  'gpu-diagnostics.jsonl',
  '--joy-media-gpu-diagnostics',
  '--joy-media-test-user-data',
  'crashReporter',
];

interface AllowRule {
  readonly pattern: string;
  readonly reason: string;
  readonly matcher: RegExp;
}

interface ScanHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

interface ScanOptions {
  readonly root: string;
  readonly staged: string;
  readonly allowList: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function escapeRegexCharacter(character: string): string {
  return '\\^$+?.()|{}[]'.includes(character) ? '\\' + character : character;
}

function globMatcher(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*' && pattern[index + 2] === '/') {
      expression += '(?:.*/)?';
      index += 2;
    } else if (character === '*' && pattern[index + 1] === '*') {
      expression += '.*';
      index += 1;
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegexCharacter(character);
    }
  }
  return new RegExp(expression + '$');
}

function loadAllowRules(path: string): readonly AllowRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      'cannot read allow-list: ' + (error instanceof Error ? error.message : String(error)),
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).entries)
  ) {
    throw new Error('allow-list must contain an entries array');
  }

  const entries = (parsed as { entries: unknown[] }).entries;
  return entries.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('allow-list entry ' + (index + 1) + ' must be an object');
    }

    const rule = entry as Record<string, unknown>;
    if (typeof rule.pattern !== 'string' || rule.pattern.trim() === '') {
      throw new Error('allow-list entry ' + (index + 1) + ' must have a pattern');
    }
    if (typeof rule.reason !== 'string' || rule.reason.trim() === '') {
      throw new Error('allow-list entry ' + (index + 1) + ' has no non-empty reason');
    }

    return {
      pattern: rule.pattern,
      reason: rule.reason,
      matcher: globMatcher(rule.pattern),
    };
  });
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  if (!isDirectory(directory)) return files;

  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function listProjectSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const group of ['apps', 'packages']) {
    const groupPath = join(root, group);
    if (!isDirectory(groupPath)) continue;
    const projects = readdirSync(groupPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const project of projects) {
      files.push(...listFiles(join(groupPath, project.name, 'src')));
    }
  }
  return files;
}

function readTextFile(path: string): string | undefined {
  const content = readFileSync(path);
  if (content.includes(0)) return undefined;
  return content.toString('utf8');
}

function appendTextHits(
  path: string,
  contents: string,
  forbiddenStrings: readonly string[],
  hits: ScanHit[],
): void {
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const forbidden of forbiddenStrings) {
      if (line.includes(forbidden)) hits.push({ path, line: index + 1, text: line });
    }
  }
}

function walkStagedTree(directory: string, root: string, paths: string[], files: string[]): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    paths.push(normalizePath(relative(root, path)));
    if (entry.isDirectory()) {
      walkStagedTree(path, root, paths, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
}

function scanSources(root: string, allowRules: readonly AllowRule[], hits: ScanHit[]): number {
  let scannedTextFiles = 0;
  const sourceFiles = listProjectSourceFiles(root);
  if (sourceFiles.length === 0) {
    throw new Error('no files found under apps/*/src or packages/*/src');
  }

  for (const path of sourceFiles) {
    const relativePath = normalizePath(relative(root, path));
    if (allowRules.some((rule) => rule.matcher.test(relativePath))) continue;

    const contents = readTextFile(path);
    if (contents === undefined) continue;
    scannedTextFiles += 1;
    appendTextHits(relativePath, contents, SOURCE_FORBIDDEN_STRINGS, hits);
  }
  if (scannedTextFiles === 0) {
    throw new Error('no shipped source text files remain after applying the allow-list');
  }
  return scannedTextFiles;
}

function scanPackagedOutput(staged: string, hits: ScanHit[]): number {
  if (!isDirectory(staged)) throw new Error('staged package directory does not exist: ' + staged);

  const appDirectory = join(staged, 'resources', 'app');
  if (!isDirectory(appDirectory)) {
    hits.push({
      path: 'resources/app',
      line: 1,
      text: 'staged package is missing resources/app',
    });
  }

  const stagedPaths: string[] = [];
  const stagedFiles: string[] = [];
  walkStagedTree(staged, staged, stagedPaths, stagedFiles);

  for (const path of stagedPaths) {
    if (/(^|\/)test-instrumentation(?:\/|$)/i.test(path)) {
      hits.push({
        path,
        line: 1,
        text: 'staged path contains test-instrumentation',
      });
    }
    if (/(^|\/)packages\/test-control-plane(?:\/|$)/i.test(path)) {
      hits.push({
        path,
        line: 1,
        text: 'staged package contains packages/test-control-plane',
      });
    }
  }

  const appRelativeFiles = stagedFiles.filter((path) => {
    const relativePath = normalizePath(relative(staged, path));
    return relativePath.startsWith('resources/app/');
  });
  const cliBundlePath = join(appDirectory, 'cli', 'joy-media-bundle.mjs');
  if (!stagedFiles.includes(cliBundlePath)) {
    hits.push({
      path: 'resources/app/cli/joy-media-bundle.mjs',
      line: 1,
      text: 'staged package is missing the CLI bundle',
    });
  }

  let scannedTextFiles = 0;
  for (const path of appRelativeFiles) {
    const relativePath = normalizePath(relative(staged, path));
    const contents = readTextFile(path);
    if (contents === undefined) continue;
    scannedTextFiles += 1;
    appendTextHits(relativePath, contents, SOURCE_FORBIDDEN_STRINGS, hits);
    appendTextHits(relativePath, contents, PACKAGED_FORBIDDEN_STRINGS, hits);
  }
  return scannedTextFiles;
}

function parseOptions(args: readonly string[]): ScanOptions {
  if (args[0] !== 'scan') throw new Error('expected the scan subcommand');

  let root = resolve(import.meta.dirname, '../../..');
  let staged = '';
  let allowList = '';
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('missing value for ' + option);
    if (option === '--root') root = resolve(value);
    else if (option === '--staged') staged = resolve(value);
    else if (option === '--allow-list') allowList = resolve(value);
    else throw new Error('unknown option: ' + option);
    index += 1;
  }

  if (!staged) throw new Error('expected --staged <packaged-output>');
  return {
    root,
    staged,
    allowList: allowList || join(root, 'tooling/release/no-server-scan.allow.json'),
  };
}

function runCli(args: readonly string[]): void {
  const options = parseOptions(args);
  const allowRules = loadAllowRules(options.allowList);
  const hits: ScanHit[] = [];
  const sourceFiles = scanSources(options.root, allowRules, hits);
  const packagedFiles = scanPackagedOutput(options.staged, hits);

  for (const hit of hits) {
    console.error(hit.path + ':' + hit.line + ': ' + hit.text);
  }
  console.log(
    'Scanned ' +
      sourceFiles +
      ' source text files and ' +
      packagedFiles +
      ' packaged text files; ' +
      hits.length +
      ' hits.',
  );
  if (hits.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
