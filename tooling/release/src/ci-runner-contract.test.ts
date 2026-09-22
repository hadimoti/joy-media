import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const LINUX_DIR = join(REPO_ROOT, 'ops', 'self-hosted', 'linux-runner');
const WINDOWS_DIR = join(REPO_ROOT, 'ops', 'self-hosted', 'windows-runner');

function safeRead(p: string): string {
  if (!statSyncSafe(p)) return '';
  return readFileSync(p, 'utf8');
}

function statSyncSafe(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

describe('JOY Media self-hosted runner contract (Docker + Windows-container)', () => {
  describe('Linux Docker runner (ops/self-hosted/linux-runner)', () => {
    const dockerfile = safeRead(join(LINUX_DIR, 'Dockerfile'));
    const entrypoint = safeRead(join(LINUX_DIR, 'entrypoint.sh'));
    const readme = safeRead(join(LINUX_DIR, 'README.md'));

    it('has a Dockerfile, an entrypoint.sh, and a README.md', () => {
      expect(dockerfile.length).toBeGreaterThan(0);
      expect(entrypoint.length).toBeGreaterThan(0);
      expect(readme.length).toBeGreaterThan(0);
    });

    it('Dockerfile pins the Ubuntu base image to an explicit digest', () => {
      expect(dockerfile).toMatch(/^FROM\s+ubuntu:24\.04@sha256:[0-9a-f]{64}/m);
    });

    it('Dockerfile pins the GitHub Actions runner tarball to a SHA-256', () => {
      expect(dockerfile).toMatch(/ARG RUNNER_SHA256=[0-9a-f]{64}/);
      expect(dockerfile).toMatch(/sha256sum --check --strict/);
    });

    it('Dockerfile pins the Node.js tarball to a SHA-256', () => {
      expect(dockerfile).toMatch(/ARG NODE_SHA256=[0-9a-f]{64}/);
    });

    it('Dockerfile pins the MinIO client to a SHA-256', () => {
      expect(dockerfile).toMatch(/ARG MC_SHA256=[0-9a-f]{64}/);
    });

    it('Dockerfile installs FFmpeg and PostgreSQL client (real-services lane prereqs)', () => {
      expect(dockerfile).toMatch(/\bffmpeg\b/);
      expect(dockerfile).toMatch(/\bpostgresql-client\b/);
    });

    it('Dockerfile installs the Playwright Chromium system libraries', () => {
      // The acceptance lane runs Playwright against Chromium; headless
      // Chromium needs libnspr4, libnss3, libgtk-3, etc. If any of these
      // go missing the lane silently falls back to webkit and the gate
      // claim is unsound.
      for (const lib of [
        'libnspr4',
        'libnss3',
        'libgtk-3-0t64',
        'libgbm1',
        'libasound2t64',
        'libxshmfence1',
      ]) {
        expect(dockerfile, `expected Dockerfile to install ${lib}`).toContain(lib);
      }
    });

    it('Dockerfile drops root and runs as a dedicated non-login user', () => {
      expect(dockerfile).toMatch(/RUNNER_ALLOW_RUNASROOT=0/);
      expect(dockerfile).toMatch(/useradd.*--uid 1001.*joyci/);
      expect(dockerpointUSERLine(dockerfile)).toBe('joyci');
    });

    it('entrypoint.sh uses the registration token ONLY at first-time configure, never persists it', () => {
      // Token is read from $RUNNER_TOKEN, used in config.sh, then the long-
      // running container is started WITHOUT it. The script must NOT echo,
      // log, or write the token anywhere.
      expect(entrypoint).toMatch(/--token\s+"\$\{?RUNNER_TOKEN\}?"/);
      expect(entrypoint).not.toMatch(/echo\s+.*RUNNER_TOKEN/);
      expect(entrypoint).not.toMatch(/>>.*RUNNER_TOKEN/);
      // No path that persists the token inside the runner volume.
      expect(entrypoint).not.toMatch(/echo.*>\s*\.\.?\/.*RUNNER_TOKEN/);
    });

    it('entrypoint.sh points config.sh at the JOY Media repository and uses --replace', () => {
      expect(entrypoint).toContain('--url "https://github.com/hadimoti/joy-media"');
      expect(entrypoint).toContain('--replace');
      expect(entrypoint).toContain('--unattended');
    });

    it('entrypoint.sh short-circuits on --configure-only and execs run.sh for the long-running container', () => {
      expect(entrypoint).toContain('if [[ "${1:-}" == "--configure-only" ]]');
      expect(entrypoint).toContain('exec ./run.sh');
    });

    it('README documents the registration flow without committing any token', () => {
      expect(readme).toContain('registration-token');
      expect(readme).toContain('RUNNER_LABELS=self-hosted,linux,x64,joy-media-ci');
      expect(readme).toContain('--configure-only');
      expect(readme).toContain('joy-media-ci-linux-runner');
      // Token must only ever be referenced as a runtime variable.
      expect(readme).not.toMatch(/[A-Za-z0-9]{20,}/); // 20+ char string that is not a docker image tag
      expect(readme).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    });
  });

  describe('Windows Docker-container runner (ops/self-hosted/windows-runner)', () => {
    const dockerfile = safeRead(join(WINDOWS_DIR, 'Dockerfile.windows'));
    const installScript = safeRead(join(WINDOWS_DIR, 'install-windows-runner.ps1'));
    const artifactMirror = safeRead(join(WINDOWS_DIR, 'artifact-mirror.py'));
    const githubProxy = safeRead(join(WINDOWS_DIR, 'github-connect-proxy.py'));
    const entrypoint = safeRead(join(WINDOWS_DIR, 'windows-runner-entrypoint.ps1'));
    const provision = safeRead(join(WINDOWS_DIR, 'provision.ps1'));
    const containerAcceptance = safeRead(join(WINDOWS_DIR, 'worker-acceptance-container.ps1'));
    const readme = safeRead(join(WINDOWS_DIR, 'README.md'));
    const contract = safeRead(join(WINDOWS_DIR, 'contract.md'));

    it('has a Dockerfile.windows, an install script, an entrypoint, a contract, and a README', () => {
      expect(dockerfile.length).toBeGreaterThan(0);
      expect(installScript.length).toBeGreaterThan(0);
      expect(artifactMirror.length).toBeGreaterThan(0);
      expect(githubProxy.length).toBeGreaterThan(0);
      expect(entrypoint.length).toBeGreaterThan(0);
      expect(provision.length).toBeGreaterThan(0);
      expect(readme.length).toBeGreaterThan(0);
      expect(contract.length).toBeGreaterThan(0);
    });

    it('Dockerfile.windows is a digest-pinned Windows-container build', () => {
      // The base is captured as an ARG and resolved in FROM. Both the ARG
      // declaration and the FROM must point at a Windows-container base.
      expect(dockerfile).toMatch(/^ARG\s+WINDOWS_BASE=mcr\.microsoft\.com\/windows\/servercore/m);
      expect(dockerfile).toMatch(/^ARG\s+WINDOWS_BASE=.*@sha256:[0-9a-f]{64}/m);
      expect(dockerfile).toMatch(/^FROM\s+\$\{WINDOWS_BASE\}/m);
    });

    it('supports an optional host artifact mirror without persisting its URL in the image environment', () => {
      expect(dockerfile).toContain('ARG ARTIFACT_BASE_URL=');
      expect(dockerfile).toContain(
        'ENV JOY_MEDIA_WINDOWS_ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL}"',
      );
      expect(dockerfile).toContain('ENV JOY_MEDIA_WINDOWS_ARTIFACT_BASE_URL=""');
      expect(installScript).toContain('function Save-PinnedDownload');
      expect(installScript).toContain('$artifactBaseUrl');
    });

    it('keeps the host fallback local and restricted', () => {
      expect(artifactMirror).toContain('pnpm/11.15.0');
      expect(githubProxy).toContain('CONNECT');
      expect(githubProxy).toContain('api.github.com');
      expect(githubProxy).toContain('port != 443');
      expect(githubProxy).not.toMatch(/RUNNER_TOKEN|GH_TOKEN|Authorization/i);
    });

    it('the Windows image pins the GitHub Actions runner + Node tarball to SHA-256 hashes', () => {
      expect(dockerfile).toMatch(/ARG\s+RUNNER_SHA256=[0-9a-f]{64}/);
      expect(dockerfile).toMatch(/ARG\s+NODE_SHA256=[0-9a-f]{64}/);
      expect(installScript).toMatch(/Get-FileHash[\s\S]*SHA256/);
    });

    it('the Windows image installs the portable Worker toolchain without Chocolatey', () => {
      expect(installScript).toMatch(/\bffmpeg\b/);
      expect(installScript).toContain('MinGit');
      expect(installScript).toContain('jq');
      expect(`${dockerfile}\n${installScript}`).not.toMatch(/Chocolatey|choco/i);
    });

    it('entrypoint uses the registration token ONLY at first-time configure, never persists it', () => {
      expect(entrypoint).toMatch(/\$env:RUNNER_TOKEN/);
      // No `Write-Output … $env:RUNNER_TOKEN` or `>>` redirection of the token.
      expect(entrypoint).not.toMatch(/Write-Output\s+\$env:RUNNER_TOKEN/);
      expect(entrypoint).not.toMatch(/Set-Content[\s\S]*RUNNER_TOKEN/);
      expect(entrypoint).not.toMatch(/\\" >>.*RUNNER_TOKEN/);
      expect(entrypoint).not.toMatch(/RUNNER_TOKEN.*>/);
      // Long-running exec path does not pass the token into config.cmd.
      expect(entrypoint).toContain('& .\\run.cmd');
      expect(entrypoint).toContain('joy-media-worker-docker');
      expect(entrypoint).toContain('JOY_MEDIA_WINDOWS_IMAGE_DIGEST');
      expect(entrypoint).toContain('C:\\runner-base');
      expect(entrypoint).toContain('JOY_MEDIA_WINDOWS_WAIT_FOR_REGISTRATION');
      expect(dockerfile).toContain('C:\\runner-base');
    });

    it('entrypoint configures against the JOY Media repository in unattended mode with --replace', () => {
      expect(entrypoint).toContain("'https://github.com/hadimoti/joy-media'");
      expect(entrypoint).toContain('--unattended');
      expect(entrypoint).toContain('--replace');
    });

    it('entrypoint short-circuits on --configure-only and otherwise runs run.cmd', () => {
      expect(entrypoint).toMatch(/--configure-only/);
      expect(entrypoint).toMatch(/&\s+\.\\run\.cmd/);
    });

    it('container acceptance is container-local and forbids host-only APIs', () => {
      expect(containerAcceptance).toContain('windows-docker-container');
      expect(containerAcceptance).toContain('JOY_MEDIA_WINDOWS_CONTAINER_ID');
      expect(containerAcceptance).toContain('JOY_MEDIA_WINDOWS_IMAGE_DIGEST');
      expect(containerAcceptance).toContain(
        'Git metadata is unavailable inside the Windows acceptance container',
      );
      expect(containerAcceptance).toContain('does not match candidate SHA');
      expect(containerAcceptance).toContain('refusing to claim a clean worktree');
      expect(containerAcceptance).not.toMatch(
        /Register-ScheduledTask|Get-ScheduledTask|Win32_Process/,
      );
      expect(contract).toContain('container-local');
      expect(contract).toContain('Host-direct Windows runners are forbidden');
    });

    it('README declares only the Docker Windows runner label', () => {
      expect(readme).toContain('self-hosted,windows,x64,joy-media-worker-docker');
      expect(readme).not.toContain('self-hosted,windows,x64,joy-media-worker`');
      expect(readme).not.toContain('windows-latest');
    });

    /**
     * Producer-side determinism for the release gate contract. The behavioral
     * gate checks live in gate.test.ts; these assertions keep the PowerShell
     * producer and registration entrypoint aligned with that contract.
     */
    const DOCKER_RUNNER_LABEL = 'self-hosted,windows,x64,joy-media-worker-docker';
    const DOCKER_EXECUTION_LABEL = 'windows-docker-container';
    const LEGACY_EXECUTION_LABEL = 'windows-self-hosted-docker';

    it('pins the producer to the Docker-only runner contract', () => {
      const producerRunnerAssignments = [
        ...containerAcceptance.matchAll(/^\s*runner\s*=\s*['"]([^'"]+)['"]/gmu),
      ].map((match) => match[1]);
      expect(producerRunnerAssignments).toEqual([DOCKER_RUNNER_LABEL]);
      expect(containerAcceptance).toContain(`execution = '${DOCKER_EXECUTION_LABEL}'`);
      // The gate accepts this legacy enum for already captured evidence, but
      // new producer evidence must use the canonical container enum.
      expect(containerAcceptance).not.toContain(`execution = '${LEGACY_EXECUTION_LABEL}'`);
      expect(containerAcceptance).toContain('containerIdentity = [ordered]@{');
      expect(containerAcceptance).toContain('containerId = $containerId');
      expect(containerAcceptance).toContain('imageDigest = $imageDigest');
      expect(containerAcceptance).toContain('windowsPlatformVerified = $true');
    });

    it('windows-runner-entrypoint.ps1 requires the same Docker-only label the producer emits', () => {
      const expectedLabelAssignments = [
        ...entrypoint.matchAll(/^\s*\$expectedLabels\s*=\s*['"]([^'"]+)['"]/gmu),
      ].map((match) => match[1]);
      expect(expectedLabelAssignments).toEqual([DOCKER_RUNNER_LABEL]);
      // The token-leak guard must remain in force for the long-running run.cmd.
      expect(entrypoint).toContain('Remove-Item Env:\\RUNNER_TOKEN');
    });

    it('provision.ps1 pins the repository, runner name, labels, and MTU contract', () => {
      expect(provision).toContain(
        'repos/hadimoti/joy-media/actions/runners/registration-token',
      );
      expect(provision).toContain("[ValidateSet('joy-media-worker-docker')]");
      expect(provision).toContain("$RunnerName = 'joy-media-worker-docker'");
      expect(provision).toContain(
        "$runnerLabels = 'self-hosted,windows,x64,joy-media-worker-docker'",
      );
      expect(provision).toContain('[ValidateRange(0,1500)]');
      expect(provision).toContain('[int]$MtuBytes = 1240');
      expect(provision).toContain('MtuBytes -gt 0 -and $MtuBytes -lt 576');
      expect(provision).toContain('--labels self-hosted,windows,x64,joy-media-worker-docker');
    });

    it('provision.ps1 applies and verifies MTU inside the container', () => {
      expect(provision).toContain("'--entrypoint', 'powershell'");
      expect(provision).toContain('netsh interface ipv4 show subinterfaces');
      expect(provision).toContain('store=active');
      expect(provision).toContain('& C:\\joy-media-windows-runner.ps1');
      expect(provision).toMatch(/docker exec[\s\S]*mtuVerification/);
      expect(provision).toContain('Container MTU verification failed');
      expect(provision).toContain("'-EncodedCommand', (ConvertTo-EncodedCommand $startupWrapper)");
      expect(provision).toContain('-EncodedCommand $encodedMtuVerification');
      expect(provision).toContain('-EncodedCommand (ConvertTo-EncodedCommand $configure)');
      expect(provision).not.toMatch(/powershell -NoProfile -Command \$(startupWrapper|mtuVerification|configure)/);
      expect(provision).toContain('[long]`$Matches.mtu -gt $MtuBytes');
      expect(provision).toContain('runner not started');
    });

    it('provision.ps1 supplies the registration token only on docker exec stdin', () => {
      expect(provision).toContain('[Console]::In.ReadToEnd()');
      expect(provision).toMatch(/\$registrationToken\s*\|\s*&\s*docker exec -i/);
      expect(provision).not.toContain('RUNNER_TOKEN=');
      expect(provision).not.toContain('-e RUNNER_TOKEN');
      expect(provision).not.toMatch(/TLS_NO_VERIFY|HTTP_PROXY/i);
      expect(provision).not.toMatch(/(^|\s)-v\s/);
      expect(provision).toMatch(/--volume[\s\S]*\$\(\$Volume\)/);
    });

    it('contract.md no longer documents RUNNER_TOKEN registration', () => {
      expect(contract).not.toContain('-e RUNNER_TOKEN');
      expect(contract).toContain('provision.ps1');
      expect(contract).toContain('DPAPI');
      expect(contract).toContain('docker exec -i');
    });
  });
});

function dockerpointUSERLine(dockerfile: string): string | null {
  const m = dockerfile.match(/^USER\s+(\S+)/m);
  return m ? m[1] : null;
}
