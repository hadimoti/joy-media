import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

console.log('=== JOY Media Installer & Package Verification Suite ===');

const desktopDistDir = resolve('apps/desktop/dist');
const standaloneDir = resolve(desktopDistDir, 'joy-media-win32-x64');
const releasesDir = resolve(desktopDistDir, 'releases');

// 1. Verify Distribution Layout
console.log('1. Verifying distribution files in joy-media-win32-x64...');
const requiredFiles = [
  'joy-media.exe',
  'joy.cmd',
  'joy-media.cmd',
  'Setup-JoyMedia.ps1',
  'install.cmd',
  'uninstall.cmd',
  'resources/app/worker/joy-worker.exe',
  'resources/app/cli/joy-media-bundle.mjs',
  'resources/app/renderer/index.html',
  'resources/app/dist/main/electron-entry.js',
];

for (const relPath of requiredFiles) {
  const fullPath = resolve(standaloneDir, relPath);
  assert.ok(existsSync(fullPath), `Required distribution file missing: ${relPath}`);
}
console.log('✔ All required distribution files present.');

// 2. Test Packaged CLI Execution via joy.cmd
console.log('2. Testing packaged CLI execution (joy.cmd doctor)...');
const joyCmdPath = resolve(standaloneDir, 'joy.cmd');
const doctorResult = spawnSync(joyCmdPath, ['doctor'], {
  shell: true,
  encoding: 'utf8',
  timeout: 15000,
});
assert.strictEqual(doctorResult.status, 0, `joy.cmd doctor failed: ${doctorResult.stderr}`);
assert.ok(doctorResult.stdout.includes('JOY MEDIA CLI'), 'Doctor output missing banner');
assert.ok(
  doctorResult.stdout.includes('All core system diagnostics passed'),
  'Doctor diagnostics failed',
);
console.log('✔ Packaged CLI doctor passed cleanly.');

console.log('3. Testing packaged CLI project list...');
const projectResult = spawnSync(joyCmdPath, ['project', 'list'], {
  shell: true,
  encoding: 'utf8',
  timeout: 15000,
});
assert.strictEqual(projectResult.status, 0, `joy.cmd project list failed: ${projectResult.stderr}`);
assert.ok(projectResult.stdout.includes('Local Projects'), 'Project list output unexpected');
console.log('✔ Packaged CLI project list passed cleanly.');

// 4. Test Mock Installation with Setup-JoyMedia.ps1
console.log('4. Testing Setup-JoyMedia.ps1 non-elevated installation to temporary path...');
const tempInstallDir = mkdtempSync(join(tmpdir(), 'joy-install-test-'));
try {
  const installPs1 = resolve(standaloneDir, 'Setup-JoyMedia.ps1');
  const installResult = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      installPs1,
      '-InstallPath',
      tempInstallDir,
      '-Silent',
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.strictEqual(installResult.status, 0, `Setup-JoyMedia.ps1 failed: ${installResult.stderr}`);

  // Verify installed files
  assert.ok(existsSync(join(tempInstallDir, 'joy-media.exe')), 'Installed joy-media.exe missing');
  assert.ok(existsSync(join(tempInstallDir, 'joy.cmd')), 'Installed joy.cmd missing');
  assert.ok(
    existsSync(join(tempInstallDir, 'resources', 'app', 'cli', 'joy-media-bundle.mjs')),
    'Installed CLI bundle missing',
  );
  assert.ok(
    existsSync(join(tempInstallDir, 'resources', 'app', 'worker', 'joy-worker.exe')),
    'Installed joy-worker.exe missing',
  );

  // Verify installed CLI executes from destination
  const installedJoyCmd = join(tempInstallDir, 'joy.cmd');
  const testRun = spawnSync(installedJoyCmd, ['doctor'], {
    shell: true,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(testRun.status, 0, `Installed joy.cmd failed: ${testRun.stderr}`);
  console.log('✔ Setup-JoyMedia.ps1 installation verified cleanly.');
} finally {
  try {
    rmSync(tempInstallDir, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup
  }
}

// 5. Verify Release Artifacts & Manifest Parity
console.log('5. Verifying release manifest & SHA256 checksums...');
const manifestPath = resolve(releasesDir, 'joy-media-release-manifest.json');
const shaSumsPath = resolve(releasesDir, 'SHA256SUMS.txt');

assert.ok(existsSync(manifestPath), 'Release manifest missing');
assert.ok(existsSync(shaSumsPath), 'SHA256SUMS.txt missing');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.strictEqual(manifest.name, 'joy-media');
assert.strictEqual(manifest.platform, 'windows-x64');
assert.strictEqual(manifest.installer.environment.pathRegistered, true);

const shaSums = readFileSync(shaSumsPath, 'utf8');
for (const artifact of manifest.artifacts) {
  if (artifact.sha256) {
    assert.ok(
      shaSums.includes(artifact.sha256),
      `Artifact ${artifact.fileName} SHA256 ${artifact.sha256} not in SHA256SUMS.txt`,
    );
  }
}
console.log('✔ Release manifest & SHA256 checksums match perfectly.');

console.log('\n=== All Installer & Packaging Checks PASSED! ===');
