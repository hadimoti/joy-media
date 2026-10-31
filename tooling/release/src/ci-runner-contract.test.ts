import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const LINUX_DIR = join(REPO_ROOT, 'ops', 'self-hosted', 'linux-runner');

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

describe('JOY Media self-hosted runner contract (Linux Docker)', () => {
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

    it('README documents the service env names and persistent evidence mount safely', () => {
      for (const name of [
        'JOY_MEDIA_CI_DATABASE_URL',
        'JOY_MEDIA_CI_S3_ENDPOINT',
        'JOY_MEDIA_CI_S3_ACCESS_KEY',
        'JOY_MEDIA_CI_S3_SECRET_KEY',
        'JOY_MEDIA_CI_S3_HEALTHCHECK_URL',
        'JOY_MEDIA_CI_RELEASE_COMMAND',
        'JOY_MEDIA_CI_EVIDENCE_ROOT=/opt/joy-media-evidence',
      ]) {
        expect(readme).toContain(name);
      }
      expect(readme).toContain('--env-file /etc/joy-media/ci-runner.env');
      expect(readme).toContain('--add-host joyminio:127.0.0.1');
      expect(readme).toContain('joy-media-ci-linux-evidence');
      expect(readme).toContain('owned by runner uid 1001');
      expect(readme).toMatch(/no embedded\s+\n?\s*userinfo/);
    });
  });
});

function dockerpointUSERLine(dockerfile: string): string | null {
  const m = dockerfile.match(/^USER\s+(\S+)/m);
  return m ? m[1] : null;
}
