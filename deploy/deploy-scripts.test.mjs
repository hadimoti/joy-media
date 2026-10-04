import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { runClientKeySmoke } from '../tooling/ops/smoke-client-key.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const applyScript = join(repoRoot, 'deploy', 'apply-nginx-cutover.sh');
const deployScript = join(repoRoot, 'deploy', 'deploy-control-plane.sh');
const cloudflareIps = join(repoRoot, 'deploy', 'cloudflare-ips.txt');
const refreshCloudflareScript = join(repoRoot, 'deploy', 'refresh-cloudflare-ips.sh');
const ensureProxyScript = join(repoRoot, 'deploy', 'ensure-trusted-proxy.py');

function findBash() {
  if (process.platform !== 'win32') {
    const found = spawnSync('bash', ['--version'], { encoding: 'utf8' });
    return found.status === 0 ? 'bash' : undefined;
  }
  const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe'];
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (execPath.status === 0) {
    const gitCore = execPath.stdout.trim();
    candidates.push(resolve(gitCore, '..', '..', '..', 'bin', 'bash.exe'));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

function toShellPath(path) {
  if (!path || process.platform !== 'win32') return path;
  const cygpath = 'C:\\Program Files\\Git\\usr\\bin\\cygpath.exe';
  const converted = existsSync(cygpath)
    ? spawnSync(cygpath, ['-u', path], { encoding: 'utf8' })
    : undefined;
  if (converted?.status === 0) return converted.stdout.trim();
  return path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, '/$1');
}

function shellPathList() {
  if (process.platform !== 'win32') return process.env.PATH;
  const cygpath = 'C:\\Program Files\\Git\\usr\\bin\\cygpath.exe';
  const converted = existsSync(cygpath)
    ? spawnSync(cygpath, ['-up', process.env.PATH], { encoding: 'utf8' })
    : undefined;
  return converted?.status === 0
    ? converted.stdout.trim()
    : process.env.PATH.split(';').map(toShellPath).join(':');
}

const bash = findBash();
const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

const fixture = `# shared nginx config\nserver {\n    listen 80;\n    server_name joyst.ir;\n    return 301 https://joyst.ir$request_uri;\n}\n\nserver {\n    listen 443 ssl;\n    server_name other.example;\n    ssl_certificate /tmp/other.pem;\n    location ~ ^/api/v1/agent(?:/|$) { return 418; }\n}\n\nserver {\n    listen 82.115.8.224:443 ssl;\n    server_name joyst.ir www.joyst.ir;\n    ssl_certificate /etc/ssl/joyst/origincertificate.pem;\n    ssl_certificate_key /etc/ssl/joyst/privatekey.pem;\n    location = /api/health { proxy_pass http://127.0.0.1:8790/health; }\n    location ~ ^/api/v1/(?:auth|devices|account|entitlements|releases|billing|agent)(?:/|$) {\n        proxy_pass http://127.0.0.1:8790;\n        proxy_read_timeout 180;\n        proxy_send_timeout 180;\n    }\n    location /api/ { return 404; }\n    location / { try_files $uri /index.html; }\n}\n`;

function parseLocations(serverBlock) {
  const locations = [];
  const directive = /^\s*location\s+(=\s+|\^~\s+|~\*?\s+)?([^\s{]+)[^\n]*\{/gm;
  for (const match of serverBlock.matchAll(directive)) {
    const open = match.index + match[0].lastIndexOf('{');
    let depth = 0;
    let end = open;
    for (; end < serverBlock.length; end += 1) {
      if (serverBlock[end] === '{') depth += 1;
      if (serverBlock[end] === '}' && --depth === 0) break;
    }
    locations.push({
      modifier: (match[1] ?? '').trim(),
      pattern: match[2],
      body: serverBlock.slice(open + 1, end),
    });
  }
  return locations;
}

function selectNginxLocation(locations, requestPath) {
  const exact = locations.find(
    (location) => location.modifier === '=' && location.pattern === requestPath,
  );
  if (exact) return exact;
  const prefixes = locations
    .filter(
      (location) =>
        !['~', '~*', '='].includes(location.modifier) && requestPath.startsWith(location.pattern),
    )
    .sort((left, right) => right.pattern.length - left.pattern.length);
  const longestPrefix = prefixes[0];
  if (longestPrefix?.modifier === '^~') return longestPrefix;
  const regex = locations.find((location) => {
    if (!['~', '~*'].includes(location.modifier)) return false;
    const expression = new RegExp(location.pattern, location.modifier === '~*' ? 'i' : '');
    return expression.test(requestPath);
  });
  return regex ?? longestPrefix;
}

function findJoystTlsBlock(source) {
  const nameIndex = source.indexOf('server_name joyst.ir www.joyst.ir;');
  const start = source.lastIndexOf('server {', nameIndex);
  const end = source.indexOf('\n}', nameIndex) + 2;
  return start >= 0 && end >= 2 ? source.slice(start, end) : undefined;
}

function putExecutable(path, source) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${source}\n`);
  chmodSync(path, 0o755);
}

function createSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'joy-deploy-scripts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stubs = join(root, 'stubs');
  const repo = join(root, 'repo');
  const releaseRoot = join(root, 'releases');
  const backupDir = join(root, 'backups');
  const accountTarget = join(root, 'account-web');
  const conf = join(root, 'joy-wg-bot.conf');
  const ca = join(root, 'test-ca.pem');
  const apiEnv = join(root, 'api.env');
  const ips = join(root, 'cloudflare-ips.txt');
  const deployState = join(root, 'deploy-state');
  const log = join(root, 'commands.log');
  const curlCount = join(root, 'curl-count');
  mkdirSync(stubs);
  mkdirSync(join(repo, 'apps', 'account-web', 'dist'), { recursive: true });
  mkdirSync(releaseRoot);
  mkdirSync(accountTarget);
  writeFileSync(join(repo, 'apps', 'account-web', 'dist', 'index.html'), 'built test page');
  writeFileSync(join(accountTarget, 'old.html'), 'old account page');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfile fixture');
  writeFileSync(conf, fixture);
  writeFileSync(ca, 'test CA placeholder');
  writeFileSync(
    apiEnv,
    'JOY_MEDIA_RELEASE_SCHEMA_VERSION=9\nJOY_MEDIA_TEST_SENTINEL=original\nJOY_MEDIA_TRUSTED_PROXY_ADDRESSES=10.0.0.2\n',
  );
  writeFileSync(ips, readFileSync(cloudflareIps, 'utf8'));
  const oldRelease = join(releaseRoot, 'old-release');
  const nextRelease = join(releaseRoot, 'next-release');
  mkdirSync(oldRelease);
  mkdirSync(nextRelease);
  const current = join(releaseRoot, 'current-api');
  const cutover = join(root, 'cutover.sh');
  const linkHelper = join(root, 'link-helper.mjs');
  writeFileSync(
    linkHelper,
    "import { renameSync, rmSync, symlinkSync } from 'node:fs';\nconst [operation, first, second] = process.argv.slice(2);\nif (operation === 'link') symlinkSync(first, second, process.platform === 'win32' ? 'junction' : 'dir');\nelse if (operation === 'move') { rmSync(second, { recursive: true, force: true }); renameSync(first, second); }\nelse process.exit(2);\n",
  );
  writeFileSync(
    cutover,
    '#!/usr/bin/env bash\nset -e\nprintf \'cutover\\n\' >> "$JOY_STUB_LOG"\ncp -p "$JOY_MEDIA_API_ENV_FILE" "${JOY_MEDIA_API_ENV_FILE}.before-next-release.env"\nprintf \'JOY_MEDIA_RELEASE_SCHEMA_VERSION=11\\nJOY_MEDIA_TEST_SENTINEL=deployed\\nJOY_MEDIA_TRUSTED_PROXY_ADDRESSES=10.0.0.2,127.0.0.1\\n\' > "${JOY_MEDIA_API_ENV_FILE}.next"\nmv -Tf -- "${JOY_MEDIA_API_ENV_FILE}.next" "$JOY_MEDIA_API_ENV_FILE"\nprintf \'next-release\\t%s\\n\' "${JOY_MEDIA_API_ENV_FILE}.before-next-release.env" > "$JOY_MEDIA_DEPLOY_STATE_FILE"\nln -s -- "$JOY_TEST_NEXT_RELEASE" "${JOY_MEDIA_CURRENT_API_LINK}.next"\nmv -Tf -- "${JOY_MEDIA_CURRENT_API_LINK}.next" "$JOY_MEDIA_CURRENT_API_LINK"\n',
  );
  chmodSync(cutover, 0o755);
  symlinkSync(oldRelease, current, process.platform === 'win32' ? 'junction' : 'dir');

  const logger = `printf '%s' "$(basename -- "$0")" >> "$JOY_STUB_LOG"\nfor arg in "$@"; do printf '\\t%s' "$arg" >> "$JOY_STUB_LOG"; done\nprintf '\\n' >> "$JOY_STUB_LOG"`;
  for (const command of ['nginx', 'systemctl', 'pnpm', 'pg_dump', 'node', 'su', 'gzip', 'du']) {
    putExecutable(
      join(stubs, command),
      `${logger}\n${command === 'nginx' ? 'if [[ "${1:-}" == -t && "${STUB_NGINX_FAIL_TEST:-}" == 1 ]]; then exit 1; fi' : ''}\n${command === 'node' ? 'exit "${STUB_NODE_EXIT:-0}"' : ''}\n${command === 'pnpm' ? 'exit "${STUB_PNPM_EXIT:-0}"' : ''}\n${command === 'systemctl' ? 'exit "${STUB_SYSTEMCTL_EXIT:-0}"' : ''}\n${command === 'du' ? 'echo "0 test"' : ''}\nexit 0`,
    );
  }
  putExecutable(
    join(stubs, 'mv'),
    `${logger}\nif [[ "\${1:-}" == -Tf ]]; then\n  shift\n  [[ "\${1:-}" == -- ]] && shift\n  "$JOY_TEST_NODE" "$JOY_TEST_LINK_HELPER" move "$1" "$2"\nelse\n  /usr/bin/mv "$@"\nfi`,
  );
  putExecutable(
    join(stubs, 'ln'),
    `${logger}\n[[ "\${1:-}" == -s ]] || exit 2\nshift\n[[ "\${1:-}" == -- ]] && shift\n"$JOY_TEST_NODE" "$JOY_TEST_LINK_HELPER" link "$1" "$2"`,
  );
  putExecutable(
    join(stubs, 'curl'),
    `${logger}
count=0
if [[ -f "$JOY_STUB_CURL_COUNT" ]]; then count="$(<"$JOY_STUB_CURL_COUNT")"; fi
count=$((count + 1))
printf '%s' "$count" > "$JOY_STUB_CURL_COUNT"
if [[ "\${STUB_CURL_FAIL_AT:-}" == "$count" ]]; then exit "\${STUB_CURL_EXIT:-22}"; fi
url="\${@: -1}"
if [[ -n "\${STUB_CURL_HTTP_CODE:-}" ]]; then echo "$STUB_CURL_HTTP_CODE"; else
  case "$url" in
    */ready)
      target="$(readlink -f -- "$JOY_MEDIA_CURRENT_API_LINK")"
      if [[ "$target" == "$JOY_TEST_OLD_RELEASE" ]] && grep -q '^JOY_MEDIA_RELEASE_SCHEMA_VERSION=9$' "$JOY_MEDIA_API_ENV_FILE"; then echo 200
      elif [[ "$target" == "$JOY_TEST_NEXT_RELEASE" ]] && grep -q '^JOY_MEDIA_RELEASE_SCHEMA_VERSION=11$' "$JOY_MEDIA_API_ENV_FILE"; then echo 200
      else echo 503; fi ;;
    */api/health|*/) echo 200 ;;
    *) echo 404 ;;
  esac
fi
`,
  );

  const env = {
    ...process.env,
    PATH: shellPathList(),
    JOY_TEST_STUB_PATH: toShellPath(stubs),
    JOY_TEST_BASH: toShellPath(bash),
    JOY_TEST_NODE: toShellPath(process.execPath),
    JOY_TEST_LINK_HELPER: toShellPath(linkHelper),
    TMPDIR: toShellPath(root),
    JOY_STUB_LOG: toShellPath(log),
    JOY_STUB_CURL_COUNT: toShellPath(curlCount),
    JOY_TEST_NEXT_RELEASE: toShellPath(nextRelease),
    JOY_TEST_OLD_RELEASE: toShellPath(oldRelease),
    JOY_DEPLOY_TEST_MODE: '1',
    JOY_DEPLOY_TEST_ROOT_OK: '1',
    JOY_MEDIA_REPO_DIR: toShellPath(repo),
    JOY_MEDIA_BACKUP_DIR: toShellPath(backupDir),
    JOY_MEDIA_ACCOUNT_WEB_TARGET: toShellPath(accountTarget),
    JOY_MEDIA_API_RELEASE_ROOT: toShellPath(releaseRoot),
    JOY_MEDIA_CURRENT_API_LINK: toShellPath(current),
    JOY_MEDIA_API_ENV_FILE: toShellPath(apiEnv),
    JOY_MEDIA_DEPLOY_STATE_FILE: toShellPath(deployState),
    JOY_MEDIA_NGINX_CONF: toShellPath(conf),
    JOY_MEDIA_NGINX_BACKUP_DIR: toShellPath(backupDir),
    JOY_MEDIA_CLOUDFLARE_IPS_FILE: toShellPath(ips),
    JOY_MEDIA_CA_FILE: toShellPath(ca),
    JOY_MEDIA_EDGE_ADDR: '82.115.8.224',
    JOY_MEDIA_CUTOVER_SCRIPT: toShellPath(cutover),
    JOY_MEDIA_API_SYSTEMD_UNIT: 'joy-media-test@api',
  };
  const resolvedCurl = spawnSync(
    bash,
    ['-c', 'export PATH="$JOY_TEST_STUB_PATH:$PATH"; command -v curl'],
    { env, encoding: 'utf8' },
  );
  if (resolvedCurl.status !== 0 || !resolvedCurl.stdout.trim().endsWith('/stubs/curl')) {
    throw new Error(
      `curl stub was not first on PATH: ${resolvedCurl.stdout.trim()} ${resolvedCurl.stderr.trim()} (PATH=${env.PATH})`,
    );
  }
  return {
    root,
    repo,
    releaseRoot,
    backupDir,
    accountTarget,
    conf,
    ca,
    log,
    curlCount,
    current,
    apiEnv,
    ips,
    deployState,
    oldRelease,
    nextRelease,
    cutover,
    stubs,
    env,
  };
}

function runBash(script, args = [], env = process.env, cwd = repoRoot) {
  return spawnSync(
    bash,
    [
      '-c',
      'export PATH="$JOY_TEST_STUB_PATH:$PATH"; exec "$JOY_TEST_BASH" "$@"',
      '--',
      toShellPath(script),
      ...args,
    ],
    {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
}

function commandLog(sandbox) {
  return existsSync(sandbox.log)
    ? readFileSync(sandbox.log, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    : [];
}

function assertCurlSafety(lines, caPath, edgeAddr) {
  const curlLines = lines.filter((line) => line.startsWith('curl\t'));
  assert.ok(curlLines.length > 0, 'expected curl probes');
  for (const line of curlLines) {
    const argv = line.split('\t').slice(1);
    assert.ok(!argv.includes('-k') && !argv.includes('--insecure'), `insecure TLS flag in ${line}`);
    const resolveIndex = argv.indexOf('--resolve');
    assert.notEqual(resolveIndex, -1, `--resolve missing in ${line}`);
    const resolved = argv[resolveIndex + 1];
    assert.equal(resolved, `joyst.ir:443:${edgeAddr.includes(':') ? `[${edgeAddr}]` : edgeAddr}`);
    const caIndex = argv.indexOf('--cacert');
    assert.notEqual(caIndex, -1, `--cacert missing in ${line}`);
    assert.equal(argv[caIndex + 1], caPath);
    const maxIndex = argv.indexOf('--max-time');
    assert.notEqual(maxIndex, -1, `--max-time missing in ${line}`);
    assert.ok(Number(argv[maxIndex + 1]) <= 90, `unbounded curl timeout in ${line}`);
  }
}

describe(
  'deploy scripts',
  { skip: !bash ? 'bash/Git Bash not found; shell integration tests skipped' : undefined },
  () => {
    it('adds the loopback trusted proxy while preserving the existing list', (t) => {
      if (!hasPython) return t.skip('python3 is unavailable; api.env staging test needs Python');
      const sandbox = createSandbox(t);
      const result = spawnSync('python3', [ensureProxyScript, sandbox.apiEnv], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(
        readFileSync(sandbox.apiEnv, 'utf8'),
        /^JOY_MEDIA_TRUSTED_PROXY_ADDRESSES=10\.0\.0\.2,127\.0\.0\.1$/mu,
      );
      writeFileSync(sandbox.apiEnv, 'JOY_MEDIA_RELEASE_SCHEMA_VERSION=9\n');
      const missing = spawnSync('python3', [ensureProxyScript, sandbox.apiEnv], {
        encoding: 'utf8',
      });
      assert.equal(missing.status, 0, `${missing.stdout}\n${missing.stderr}`);
      assert.match(
        readFileSync(sandbox.apiEnv, 'utf8'),
        /^JOY_MEDIA_TRUSTED_PROXY_ADDRESSES=127\.0\.0\.1$/mu,
      );
    });

    it('patches the agent ahead of matching regexes and preserves the other joyst routes', (t) => {
      if (!hasPython)
        return t.skip('python3 is unavailable; Nginx patch integration needs real Python');
      const sandbox = createSandbox(t);
      const result = runBash(applyScript, [], {
        ...sandbox.env,
        JOY_MEDIA_EDGE_ADDR: '2001:db8::25',
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const updated = readFileSync(sandbox.conf, 'utf8');
      assert.ok(updated.includes('listen 82.115.8.224:443 ssl;'));
      assert.ok(updated.includes('proxy_pass http://127.0.0.1:8790;'));
      const updatedOther = updated.match(
        /server \{\n\s{4}listen 443 ssl;\n\s{4}server_name other\.example;[\s\S]*?\n\}/,
      )?.[0];
      const originalOther = fixture.match(
        /server \{\n\s{4}listen 443 ssl;\n\s{4}server_name other\.example;[\s\S]*?\n\}/,
      )?.[0];
      assert.equal(updatedOther, originalOther, 'another site remains byte-identical');
      const joyst = findJoystTlsBlock(updated);
      assert.ok(joyst);
      const locations = parseLocations(joyst);
      assert.equal(selectNginxLocation(locations, '/api/health').pattern, '/api/health');
      for (const path of [
        '/api/v1/agent/chat/completions',
        '/api/v1/agent/models',
        '/api/v1/agent',
      ]) {
        const selected = selectNginxLocation(locations, path);
        assert.match(selected.body, /proxy_buffering off;/);
        assert.match(selected.body, /proxy_read_timeout 90;/);
        assert.match(selected.body, /proxy_send_timeout 90;/);
      }
      for (const path of ['/api/v1/auth/request-otp', '/api/v1/billing/x']) {
        assert.match(
          selectNginxLocation(locations, path).pattern,
          /auth\|devices\|account\|entitlements\|releases\|billing/,
        );
      }
      const combinedApi = locations.find((location) => location.pattern.includes('auth|devices'));
      assert.ok(combinedApi);
      assert.doesNotMatch(combinedApi.pattern, /\|agent|agent\|/);
      for (const location of [
        selectNginxLocation(locations, '/api/v1/agent/models'),
        combinedApi,
      ]) {
        assert.match(location.body, /proxy_set_header X-Forwarded-For \$remote_addr;/);
        assert.match(location.body, /proxy_set_header X-Real-IP \$remote_addr;/);
        assert.doesNotMatch(
          location.body,
          /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/,
        );
      }
      const ranges = readFileSync(cloudflareIps, 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.replace(/^\uFEFF/u, '').trim())
        .filter((line) => line && !line.startsWith('#'));
      assert.equal(ranges.length, 22);
      assert.match(
        joyst,
        /# BEGIN joy-media realip \(managed\)[\s\S]*real_ip_header CF-Connecting-IP;[\s\S]*# END joy-media realip \(managed\)/,
      );
      for (const range of ranges) assert.ok(joyst.includes(`set_real_ip_from ${range};`));
      assert.match(joyst, /location \/internal\/ \{\s*return 404;\s*\}/);
      assert.equal(
        selectNginxLocation(locations, '/internal/client-key').body.trim(),
        'return 404;',
        'the public server rejects the loopback-only diagnostic path',
      );
      assert.equal(selectNginxLocation(locations, '/api/v1/projects').body.trim(), 'return 404;');
      const once = updated;
      const second = runBash(applyScript, [], {
        ...sandbox.env,
        JOY_MEDIA_EDGE_ADDR: '2001:db8::25',
      });
      assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
      assert.equal(readFileSync(sandbox.conf, 'utf8'), once, 'patch is idempotent');
      const lines = commandLog(sandbox);
      assertCurlSafety(lines, sandbox.env.JOY_MEDIA_CA_FILE, '2001:db8::25');
    });

    it('rejects invalid Cloudflare CIDRs and restores the original Nginx file', (t) => {
      if (!hasPython)
        return t.skip('python3 is unavailable; Nginx patch integration needs real Python');
      const sandbox = createSandbox(t);
      const invalidIps = '# fake range list\n192.0.2.0/24\nnot-a-cidr\n';
      writeFileSync(sandbox.ips, invalidIps);
      const result = runBash(applyScript, [], sandbox.env);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(
        readFileSync(sandbox.conf, 'utf8'),
        fixture,
        'original config restored after invalid CIDR',
      );
    });

    it('does not invoke the Cloudflare refresh tool from deployment scripts', () => {
      const scripts = [applyScript, deployScript, join(repoRoot, 'deploy', 'deploy-cutover.sh')]
        .map((path) => readFileSync(path, 'utf8'))
        .join('\n');
      assert.ok(existsSync(refreshCloudflareScript));
      assert.doesNotMatch(scripts, /refresh-cloudflare-ips\.sh|--refresh-cloudflare-ips/u);
    });

    it('checks distinct loopback diagnostic keys using bounded curl calls', () => {
      const requests = [];
      const result = runClientKeySmoke('http://127.0.0.1:8790', (command, argv) => {
        assert.equal(command, 'curl');
        requests.push(argv);
        const header = argv.includes('--header') ? argv[argv.indexOf('--header') + 1] : undefined;
        const key = header?.endsWith('198.51.100.71')
          ? 'a'.repeat(64)
          : header?.endsWith('198.51.100.72')
            ? 'b'.repeat(64)
            : 'c'.repeat(64);
        return JSON.stringify({ clientKey: key });
      });
      assert.equal(result, 'CLIENT_KEY_SMOKE_OK distinct loopback keys');
      assert.equal(requests.length, 4);
      for (const argv of requests) assert.ok(argv.includes('--max-time'));
      assert.equal(
        requests.filter((argv) => argv.some((arg) => arg.includes('198.51.100.'))).length,
        2,
      );
    });

    it('inserts an agent location when joyst.ir has none and restores on nginx -t failure', (t) => {
      if (!hasPython)
        return t.skip('python3 is unavailable; Nginx patch integration needs real Python');
      const sandbox = createSandbox(t);
      const noAgent = fixture.replace(
        /\s{4}location ~ \^\/api\/v1\/agent\(\?:\/\|\$\) \{\n\s{8}proxy_pass http:\/\/old-agent;\n\s{4}\}\n/,
        '',
      );
      writeFileSync(sandbox.conf, noAgent);
      const inserted = runBash(applyScript, [], sandbox.env);
      assert.equal(inserted.status, 0, `${inserted.stdout}\n${inserted.stderr}`);
      assert.match(readFileSync(sandbox.conf, 'utf8'), /location ~ \^\/api\/v1\/agent/);
      assert.ok(
        readFileSync(sandbox.conf, 'utf8').indexOf('location ~ ^/api/v1/agent') <
          readFileSync(sandbox.conf, 'utf8').indexOf('location /api/'),
      );

      writeFileSync(sandbox.conf, fixture);
      const failed = runBash(applyScript, [], { ...sandbox.env, STUB_NGINX_FAIL_TEST: '1' });
      assert.notEqual(failed.status, 0);
      assert.equal(
        readFileSync(sandbox.conf, 'utf8'),
        fixture,
        'original config restored after nginx -t failure',
      );
    });

    it('fails preflight before touching account-web for missing edge, invalid IP, or missing CA', (t) => {
      const sandbox = createSandbox(t);
      const original = readFileSync(join(sandbox.accountTarget, 'old.html'), 'utf8');
      for (const env of [
        { ...sandbox.env, JOY_MEDIA_EDGE_ADDR: '' },
        { ...sandbox.env, JOY_MEDIA_EDGE_ADDR: 'not-an-ip' },
        { ...sandbox.env, JOY_MEDIA_CA_FILE: join(sandbox.root, 'absent-ca.pem') },
      ]) {
        const result = runBash(deployScript, [], env, sandbox.repo);
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(join(sandbox.accountTarget, 'old.html'), 'utf8'), original);
        assert.ok(
          !commandLog(sandbox).some((line) => line.startsWith('pnpm\t') && line.includes('build')),
        );
      }
    });

    it('rolls back API symlink and Nginx config after a bounded step-6 failure', (t) => {
      if (!hasPython)
        return t.skip('python3 is unavailable; Nginx patch integration needs real Python');
      const sandbox = createSandbox(t);
      const baselineConfig = readFileSync(sandbox.conf, 'utf8');
      const result = runBash(
        deployScript,
        [],
        { ...sandbox.env, STUB_CURL_FAIL_AT: '6' },
        sandbox.repo,
      );
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(
        realpathSync(sandbox.current),
        realpathSync(sandbox.oldRelease),
        'previous API symlink target restored',
      );
      assert.equal(
        readFileSync(sandbox.conf, 'utf8'),
        baselineConfig,
        'pre-deploy Nginx config restored',
      );
      const lines = commandLog(sandbox);
      assert.ok(lines.some((line) => line === `cutover`));
      assert.ok(
        lines.some((line) => line.startsWith('systemctl\trestart\tjoy-media-test@api')),
        `API unit restarted during rollback; calls were:\n${lines.join('\n')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assertCurlSafety(lines, sandbox.env.JOY_MEDIA_CA_FILE, sandbox.env.JOY_MEDIA_EDGE_ADDR);
      assert.ok(
        lines.some(
          (line) =>
            line.startsWith('pnpm\t') && line.includes('account-web') && line.endsWith('\tbuild'),
        ),
      );
      assert.equal(
        readFileSync(sandbox.apiEnv, 'utf8'),
        'JOY_MEDIA_RELEASE_SCHEMA_VERSION=9\nJOY_MEDIA_TEST_SENTINEL=original\nJOY_MEDIA_TRUSTED_PROXY_ADDRESSES=10.0.0.2\n',
      );
      const readyCheck = spawnSync(
        bash,
        [
          '-c',
          'export PATH="$JOY_TEST_STUB_PATH:$PATH"; curl --silent --show-error --max-time 20 --cacert "$JOY_MEDIA_CA_FILE" --resolve "joyst.ir:443:$JOY_MEDIA_EDGE_ADDR" https://joyst.ir/ready',
        ],
        {
          env: {
            ...sandbox.env,
            JOY_STUB_CURL_COUNT: toShellPath(join(sandbox.root, 'post-rollback-curl-count')),
          },
          encoding: 'utf8',
        },
      );
      assert.equal(readyCheck.status, 0, readyCheck.stderr);
      assert.equal(readyCheck.stdout.trim(), '200', 'the old API is ready after rollback');
      assert.equal(
        readFileSync(join(sandbox.accountTarget, 'old.html'), 'utf8'),
        'old account page',
      );
      assert.equal(existsSync(join(sandbox.accountTarget, 'index.html')), false);
    });

    it('moves an existing agent location above a combined API regex', (t) => {
      if (!hasPython)
        return t.skip('python3 is unavailable; Nginx patch integration needs real Python');
      const sandbox = createSandbox(t);
      const below = fixture.replace(
        '    location /api/ { return 404; }',
        `    location ~ ^/api/v1/agent(?:/|$) {\n        proxy_pass http://old-agent;\n    }\n    location /api/ { return 404; }`,
      );
      writeFileSync(sandbox.conf, below);
      const result = runBash(applyScript, [], sandbox.env);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const joyst = findJoystTlsBlock(readFileSync(sandbox.conf, 'utf8'));
      assert.ok(joyst);
      const locations = parseLocations(joyst);
      assert.match(
        selectNginxLocation(locations, '/api/v1/agent/models').body,
        /proxy_buffering off;/,
      );
    });

    it('strips agent from the exact live combined regex in first, last, and only positions', (t) => {
      if (!hasPython)
        return t.skip('python3 is unavailable; Nginx patch integration needs real Python');
      const live =
        'location ~ ^/api/v1/(?:auth|devices|account|entitlements|releases|billing|agent)(?:/|$)';
      for (const replacement of [
        'location ~ ^/api/v1/(?:agent|auth|devices|account|entitlements|releases|billing)(?:/|$)',
        'location ~ ^/api/v1/(?:auth|devices|account|entitlements|releases|billing|agent)(?:/|$)',
        'location ~ ^/api/v1/(?:agent)(?:/|$)',
      ]) {
        const sandbox = createSandbox(t);
        writeFileSync(sandbox.conf, fixture.replace(live, replacement));
        const result = runBash(applyScript, [], sandbox.env);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const joyst = findJoystTlsBlock(readFileSync(sandbox.conf, 'utf8'));
        assert.ok(joyst);
        const locations = parseLocations(joyst);
        const selected = selectNginxLocation(locations, '/api/v1/agent/models');
        assert.match(selected.body, /proxy_buffering off;/);
        const combined = locations.find((location) => location.pattern.includes('auth|devices'));
        if (replacement.includes('auth|devices')) {
          assert.ok(combined);
          assert.doesNotMatch(combined.pattern, /agent/);
          assert.match(selectNginxLocation(locations, '/api/v1/auth/request-otp').pattern, /auth/);
        }
      }
    });

    it('restores account-web when step 5 fails', (t) => {
      const sandbox = createSandbox(t);
      const failNginx = join(sandbox.root, 'fail-nginx-apply.sh');
      writeFileSync(failNginx, '#!/usr/bin/env bash\nexit 1\n');
      chmodSync(failNginx, 0o755);
      const result = runBash(
        deployScript,
        [],
        { ...sandbox.env, JOY_MEDIA_NGINX_APPLY_SCRIPT: toShellPath(failNginx) },
        sandbox.repo,
      );
      assert.notEqual(result.status, 0);
      assert.equal(
        readFileSync(join(sandbox.accountTarget, 'old.html'), 'utf8'),
        'old account page',
      );
      assert.equal(existsSync(join(sandbox.accountTarget, 'index.html')), false);
      assert.equal(realpathSync(sandbox.current), realpathSync(sandbox.oldRelease));
      assert.equal(
        readFileSync(sandbox.apiEnv, 'utf8'),
        'JOY_MEDIA_RELEASE_SCHEMA_VERSION=9\nJOY_MEDIA_TEST_SENTINEL=original\nJOY_MEDIA_TRUSTED_PROXY_ADDRESSES=10.0.0.2\n',
      );
    });

    it('keeps joyst.ir templates bound only to the live TLS address', async () => {
      const { readFile } = await import('node:fs/promises');
      for (const name of ['joy-media-account-web.nginx.conf', 'joy-media.nginx.conf']) {
        const source = await readFile(join(repoRoot, 'deploy', name), 'utf8');
        const joyst = findJoystTlsBlock(source);
        assert.ok(joyst, `${name} has a joyst.ir server block`);
        assert.deepEqual(
          [...joyst.matchAll(/^\s*listen\s+([^;]+);/gm)].map((match) => match[1]),
          ['80', '82.115.8.224:443 ssl'],
        );
        const ranges = readFileSync(cloudflareIps, 'utf8')
          .split(/\r?\n/u)
          .map((line) => line.replace(/^\uFEFF/u, '').trim())
          .filter((line) => line && !line.startsWith('#'));
        for (const range of ranges) assert.ok(joyst.includes(`set_real_ip_from ${range};`));
        assert.match(joyst, /real_ip_header CF-Connecting-IP;/u);
        assert.match(joyst, /location \/internal\/ \{\s*return 404;\s*\}/u);
        for (const location of parseLocations(joyst).filter((item) =>
          /agent|auth\|devices/u.test(item.pattern),
        )) {
          assert.match(location.body, /proxy_set_header X-Forwarded-For \$remote_addr;/u);
          assert.match(location.body, /proxy_set_header X-Real-IP \$remote_addr;/u);
          assert.doesNotMatch(location.body, /\$proxy_add_x_forwarded_for/u);
        }
      }
    });

    it('invokes gateway smoke with the resolved edge address and CA', (t) => {
      if (!hasPython)
        return t.skip('python3 is unavailable; Nginx patch integration needs real Python');
      const sandbox = createSandbox(t);
      const result = runBash(deployScript, [], sandbox.env, sandbox.repo);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const lines = commandLog(sandbox);
      assert.match(
        readFileSync(sandbox.apiEnv, 'utf8'),
        /^JOY_MEDIA_TRUSTED_PROXY_ADDRESSES=10\.0\.0\.2,127\.0\.0\.1$/mu,
      );
      const smoke = lines.find(
        (line) => line.startsWith('node\t') && line.includes('smoke-gateway.mjs'),
      );
      assert.ok(
        smoke?.includes('--edge-addr\t82.115.8.224\t--ca\t'),
        `smoke receives edge address and CA; calls were:\n${lines.join('\n')}`,
      );
      const clientSmoke = lines.find(
        (line) => line.startsWith('node\t') && line.includes('smoke-client-key.mjs'),
      );
      assert.ok(clientSmoke?.includes('--origin\thttp://127.0.0.1:8790'));
      assert.match(
        readFileSync(join(repoRoot, 'tooling', 'ops', 'smoke-client-key.mjs'), 'utf8'),
        /--max-time/u,
      );
      assertCurlSafety(lines, sandbox.env.JOY_MEDIA_CA_FILE, sandbox.env.JOY_MEDIA_EDGE_ADDR);
    });
  },
);
