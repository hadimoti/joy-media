import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');

describe('README examples', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  it('references scripts that exist in the selected workspace package', () => {
    const examples = [...readme.matchAll(/pnpm --filter\s+(\S+)\s+(\S+)/g)];

    expect(examples.length).toBeGreaterThan(0);
    for (const [, packageName, scriptName] of examples) {
      const packageJson = [...walkPackageJsonFiles(root)].find((file) => {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string };
        return pkg.name === packageName;
      });
      expect(packageJson, `package ${packageName} exists`).toBeDefined();
      const pkg = JSON.parse(fs.readFileSync(packageJson!, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      expect(pkg.scripts?.[scriptName], `${packageName} has script ${scriptName}`).toBeDefined();
    }
  });

  it('describes the public JOY and Kilo model access accurately', () => {
    expect(readme.toLowerCase()).not.toContain('minimax');
    expect(readme.toLowerCase()).not.toContain('private repository');
    expect(readme).toContain('requires a signed-in JOY account with an active Pro subscription');
    expect(readme).toContain('bytedance-seed/seed-2.0-lite');
    expect(readme).toContain('deepseek/deepseek-v4-flash');
    expect(readme).toContain('anthropic/claude-sonnet-4.6');
    expect(readme).toContain('openai/gpt-4o-mini');
    expect(readme).toContain('https://api.kilo.ai/api/gateway');
    expect(readme).toContain('byteplus-coding/dola-seed-2.0-pro');
    expect(readme).toContain('byteplus-coding/dola-seed-2.0-lite');
    expect(readme).toContain('byteplus-coding/deepseek-v4-flash');
  });
});

function* walkPackageJsonFiles(directory: string): Generator<string> {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkPackageJsonFiles(fullPath);
    else if (entry.name === 'package.json') yield fullPath;
  }
}
