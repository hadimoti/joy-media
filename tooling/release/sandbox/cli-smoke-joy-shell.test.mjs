import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// Windows PowerShell adds .CPL to PATHEXT and the machine PATH (System32) comes before the user PATH, so in
// PowerShell `joy` resolves to System32\joy.cpl (Game Controllers) and never reaches the installed bin\joy.cmd.
// That made the Sandbox lifecycle check `joy --version` come back empty. The `joy` check therefore runs in
// Command Prompt, which uses the system PATHEXT. This test never launches joy.cpl.
const cliSmokePath = resolve(import.meta.dirname, 'cli-smoke.ps1');
const cliSmoke = readFileSync(cliSmokePath, 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `cli-smoke.ps1 must define ${name}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

test('the joy version check runs through Command Prompt, not PowerShell', () => {
  assert.match(cliSmoke, /\$joyVersion\s*=\s*Invoke-CommandPromptCli\s+'joy'\s+@\('--version'\)/);
  assert.doesNotMatch(cliSmoke, /Invoke-Cli\s+'joy'\s/);
  // joy-media has no Control Panel twin, so it stays a PowerShell check.
  assert.match(cliSmoke, /\$joyMediaVersion\s*=\s*Invoke-Cli\s+'joy-media'\s+@\('--version'\)/);
});

test(
  'Invoke-CommandPromptCli reaches bin\\joy.cmd even when System32 comes first on PATH',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-cmd-shell-'));
    try {
      writeFileSync(
        join(root, 'joy.cmd'),
        '@echo off\r\necho JOY Media CLI v9.9.9 %*\r\nexit /b 0\r\n',
        'utf8',
      );
      const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      const script = [
        extractFunction(cliSmoke, 'Invoke-CommandPromptCli'),
        // The scratch bin goes right after System32 and before everything else, so no installed JOY Media is reached.
        `$env:Path = '${system32};${root};' + $env:Path`,
        // Prove the precondition without running it: PowerShell picks joy.cpl first when it exists.
        `$first = @(Get-Command joy -All -ErrorAction SilentlyContinue)[0]`,
        `$r = Invoke-CommandPromptCli 'joy' @('--version')`,
        `[pscustomobject]@{ first = [string]$first.Source; exitCode = $r.exitCode; output = $r.output } | ConvertTo-Json -Compress`,
      ].join('\n');
      const run = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          timeout: 60000,
        },
      );
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout.trim());
      if (existsSync(join(system32, 'joy.cpl'))) assert.match(result.first, /joy\.cpl$/i);
      assert.equal(result.exitCode, 0);
      assert.equal(result.output, 'JOY Media CLI v9.9.9 --version');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
