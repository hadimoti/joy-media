import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Plan F3: the documentation in docs/ and plan/ must not carry infrastructure detail. The scan covers the current tree
// only, because git history keeps the older text. Placeholders such as <owner-profile>, <host-ip> and <vps-key-file>
// are the approved form. The scan reports the file, line and rule name, never the matched value.
const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const SCANNED_ROOTS = ['docs', 'plan'];
const SCANNED_EXTENSIONS = new Set(['.md', '.json', '.txt', '.yml', '.yaml']);
const ALLOWED_IPV4 = new Set(['127.0.0.1', '0.0.0.0', '1.1.1.1', '8.8.8.8', '10.0.26100.1']);

const RULES: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'owner profile path', pattern: /C:\\\\?Users\\\\?[A-Za-z0-9._-]+/iu },
  { name: 'owner profile path (POSIX form)', pattern: /\/c\/Users\/[A-Za-z0-9._-]+/iu },
  { name: 'private key file name', pattern: /(?:Joy-Vps-New|joy-vps|iran[12]-vps)\.pem/iu },
  { name: 'server login', pattern: /root@/u },
  { name: 'server home path', pattern: /\/root\// },
  { name: 'server application path', pattern: /\/opt\/joy-/u },
  { name: 'IPv4 address', pattern: /(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])/u },
];

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

function* documents(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* documents(path);
    else if (entry.isFile() && SCANNED_EXTENSIONS.has(extname(entry.name))) yield path;
  }
}

function scanTree(): Hit[] {
  const hits: Hit[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const path of documents(join(repoRoot, root))) {
      const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
      lines.forEach((line, index) => {
        for (const rule of RULES) {
          if (!rule.pattern.test(line)) continue;
          if (rule.name === 'IPv4 address') {
            // Only the addresses that are not infrastructure are allowed; every other match is a hit.
            const matches = line.match(new RegExp(rule.pattern.source, 'gu')) ?? [];
            if (matches.every((match) => ALLOWED_IPV4.has(match))) continue;
          }
          hits.push({
            file: path.slice(repoRoot.length + 1).replace(/\\/gu, '/'),
            line: index + 1,
            rule: rule.name,
          });
        }
      });
    }
  }
  return hits;
}

describe('privacy scan of the current documentation (F3)', () => {
  it('finds no owner profile paths, private key names, server logins or server paths, and no infrastructure addresses', () => {
    expect(scanTree()).toEqual([]);
  });

  it('still catches each rule (negative control: the patterns are not vacuous)', () => {
    const sample = [
      'C:\\Users\\example-user\\file',
      '/c/Users/example-user/file',
      'Joy-Vps-New.pem',
      'ssh root@host',
      'cd /root/app',
      'cd /opt/joy-media',
      'connect to 203.0.113.7',
    ];
    for (const line of sample) {
      expect(
        RULES.some((rule) => rule.pattern.test(line)),
        line,
      ).toBe(true);
    }
    // The Windows build string has a five-digit field, so it is not an IPv4 address under this rule.
    expect(
      RULES.find((rule) => rule.name === 'IPv4 address')?.pattern.test('build 10.0.26100.1'),
    ).toBe(false);
  });
});
