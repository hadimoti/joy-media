import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyKeyCheck,
  modelsCatalogIssue,
  parseSmokeArgs,
  requestGateway,
} from './smoke-gateway-lib.mjs';

describe('gateway smoke helpers', () => {
  it('parses local base, host, and pre-cutover mode', () => {
    assert.deepEqual(
      parseSmokeArgs([
        '--base-url',
        'https://127.0.0.1/api/v1/agent',
        '--host',
        'joy.test',
        '--edge-addr',
        '127.0.0.1',
      ]),
      {
        baseUrl: 'https://127.0.0.1/api/v1/agent',
        host: 'joy.test',
        edgeAddr: '127.0.0.1',
        caPath: undefined,
      },
    );
  });

  it('requires an IP literal edge address for HTTPS targets and rejects hostnames', () => {
    assert.throws(
      () => parseSmokeArgs([], { JOY_GATEWAY_BASE_URL: 'https://joyst.ir/api/v1/agent' }),
      /JOY_MEDIA_EDGE_ADDR/,
    );
    assert.throws(() => parseSmokeArgs(['--edge-addr', 'joyst.ir']), /IP address/);
    assert.equal(parseSmokeArgs(['--edge-addr', '82.115.8.224']).edgeAddr, '82.115.8.224');
    assert.equal(parseSmokeArgs(['--edge-addr', '[2001:db8::1]']).edgeAddr, '2001:db8::1');
  });

  it('requires an existing explicit CA file', () => {
    assert.throws(
      () => parseSmokeArgs(['--edge-addr', '127.0.0.1', '--ca', 'missing-ca.pem'], {}),
      /CA file does not exist/,
    );
  });

  it('classifies an unconfigured gateway as a missing OpenRouter key', async () => {
    const response = new globalThis.Response(
      JSON.stringify({ error: { code: 'JOY_AGENT_UNCONFIGURED' } }),
      {
        status: 503,
      },
    );
    assert.match(await classifyKeyCheck(response), /OpenRouter key missing/);
  });

  it('checks that /models returns a JSON catalog containing only openrouter/free', () => {
    assert.equal(modelsCatalogIssue({ models: [{ id: 'openrouter/free' }] }), undefined);
    assert.match(
      modelsCatalogIssue({ models: [{ id: 'anthropic/paid-model' }] }),
      /only openrouter\/free/,
    );
    assert.match(modelsCatalogIssue({}), /models array/);
    assert.match(modelsCatalogIssue(null), /models array/);
    assert.match(modelsCatalogIssue('<html>'), /not valid JSON/);
  });

  it('uses joyst.ir SNI and Host while verifying the loopback certificate', async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-gateway-tls-'));
    try {
      const keyPath = join(directory, 'leaf-key.pem');
      const certPath = join(directory, 'leaf-cert.pem');
      const caKeyPath = join(directory, 'root-key.pem');
      const caCertPath = join(directory, 'root-cert.pem');
      const wrongCaKeyPath = join(directory, 'wrong-root-key.pem');
      const wrongCaCertPath = join(directory, 'wrong-root-cert.pem');
      const csrPath = join(directory, 'leaf.csr');
      const extensionsPath = join(directory, 'leaf.ext');
      writeFileSync(
        extensionsPath,
        'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:joyst.ir\n',
      );
      const candidates = [
        process.env.OPENSSL_EXECUTABLE,
        'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
        'openssl',
      ].filter((candidate) => candidate !== undefined);
      let certificateGenerated = false;
      for (const candidate of candidates) {
        if (candidate !== 'openssl' && !existsSync(candidate)) continue;
        try {
          execFileSync(
            candidate,
            [
              'req',
              '-x509',
              '-newkey',
              'rsa:2048',
              '-nodes',
              '-keyout',
              caKeyPath,
              '-out',
              caCertPath,
              '-days',
              '1',
              '-subj',
              '/CN=Joy Test Root',
              '-addext',
              'basicConstraints=critical,CA:TRUE',
              '-addext',
              'keyUsage=critical,keyCertSign,cRLSign',
            ],
            { stdio: 'ignore' },
          );
          execFileSync(
            candidate,
            [
              'req',
              '-new',
              '-newkey',
              'rsa:2048',
              '-nodes',
              '-keyout',
              keyPath,
              '-out',
              csrPath,
              '-subj',
              '/CN=joyst.ir',
            ],
            { stdio: 'ignore' },
          );
          execFileSync(
            candidate,
            [
              'x509',
              '-req',
              '-in',
              csrPath,
              '-CA',
              caCertPath,
              '-CAkey',
              caKeyPath,
              '-CAcreateserial',
              '-out',
              certPath,
              '-days',
              '1',
              '-sha256',
              '-extfile',
              extensionsPath,
            ],
            { stdio: 'ignore' },
          );
          execFileSync(
            candidate,
            [
              'req',
              '-x509',
              '-newkey',
              'rsa:2048',
              '-nodes',
              '-keyout',
              wrongCaKeyPath,
              '-out',
              wrongCaCertPath,
              '-days',
              '1',
              '-subj',
              '/CN=Untrusted Test Root',
              '-addext',
              'basicConstraints=critical,CA:TRUE',
              '-addext',
              'keyUsage=critical,keyCertSign,cRLSign',
            ],
            { stdio: 'ignore' },
          );
          certificateGenerated = true;
          break;
        } catch {
          // Try the next supported OpenSSL location.
        }
      }
      if (!certificateGenerated) {
        context.skip('openssl is unavailable; runtime TLS certificate test skipped');
        return;
      }
      const server = createServer(
        { key: readFileSync(keyPath), cert: readFileSync(certPath) },
        (req, res) => {
          res.setHeader('x-request-host', req.headers.host ?? '');
          res.writeHead(200);
          res.end(JSON.stringify({ host: req.headers.host }));
        },
      );
      let observedServername;
      server.on('secureConnection', (socket) => {
        observedServername = socket.servername;
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const address = server.address();
        const baseUrl = `https://joyst.ir:${address.port}/api/v1/agent`;
        const response = await requestGateway(baseUrl, '/models', {}, 'joyst.ir', {
          ca: caCertPath,
          edgeAddr: '127.0.0.1',
        });
        assert.equal(response.status, 200);
        assert.equal(observedServername, 'joyst.ir');
        assert.equal(response.headers.get('x-request-host'), 'joyst.ir');
        const viaEnvCa = parseSmokeArgs([], {
          JOY_GATEWAY_BASE_URL: 'https://joyst.ir/api/v1/agent',
          JOY_MEDIA_EDGE_ADDR: '[127.0.0.1]',
          NODE_EXTRA_CA_CERTS: caCertPath,
        });
        assert.equal(viaEnvCa.caPath, caCertPath);
        const viaCaFlag = parseSmokeArgs(['--edge-addr', '127.0.0.1', '--ca', caCertPath], {});
        assert.equal(viaCaFlag.caPath, caCertPath);
        await requestGateway(baseUrl, '/models', {}, 'joyst.ir', {
          ca: viaEnvCa.caPath,
          edgeAddr: viaEnvCa.edgeAddr,
        });
        await requestGateway(baseUrl, '/models', {}, 'joyst.ir', {
          ca: viaCaFlag.caPath,
          edgeAddr: viaCaFlag.edgeAddr,
        });
        await assert.rejects(
          requestGateway(baseUrl, '/models', {}, 'joyst.ir', {
            ca: wrongCaCertPath,
            edgeAddr: '127.0.0.1',
          }),
          (error) =>
            error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
            error.code === 'SELF_SIGNED_CERT_IN_CHAIN',
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs deploy preflight before account-web is touched and drops the old-release pre-cutover smoke', async () => {
    const { readFileSync } = await import('node:fs');
    const script = readFileSync(
      new URL('../../deploy/deploy-control-plane.sh', import.meta.url),
      'utf8',
    );
    const preflight = script.indexOf('Step 1/6: Pre-flight checks');
    const accountWebBuild = script.indexOf('Step 3/6: Building @joy-media/account-web');
    const cutover = script.indexOf('bash "$CUTOVER_SCRIPT"');
    assert.ok(preflight >= 0);
    assert.ok(accountWebBuild >= 0);
    assert.ok(preflight < accountWebBuild, 'preflight starts before account-web build/swap');
    assert.ok(
      script.indexOf('nginx -t || die "nginx -t failed during preflight"') < accountWebBuild,
      'nginx syntax check runs during preflight',
    );
    assert.ok(script.indexOf('JOY_MEDIA_EDGE_ADDR must be an IP literal') < accountWebBuild);
    assert.ok(cutover >= 0, 'API cutover call is present');
    assert.ok(!script.includes('--pre-cutover'), 'old-live-release smoke gate is removed');
    const postflight = script.lastIndexOf('smoke-gateway.mjs');
    assert.ok(postflight > cutover, 'post-cutover smoke remains after API cutover');
  });

  it('keeps the Nginx update scoped to the agent location and edge probes bounded', async () => {
    const { readFileSync } = await import('node:fs');
    const apply = readFileSync(
      new URL('../../deploy/apply-nginx-cutover.sh', import.meta.url),
      'utf8',
    );
    const deploy = readFileSync(
      new URL('../../deploy/deploy-control-plane.sh', import.meta.url),
      'utf8',
    );
    assert.match(apply, /JOY_MEDIA_EDGE_ADDR/);
    assert.match(apply, /--resolve[\s\S]+?joyst\.ir:443:/);
    assert.match(apply, /--max-time\s+20/);
    assert.match(apply, /--cacert/);
    assert.match(apply, /agent location/i);
    assert.match(apply, /replacement = '''\s+location ~ \^\/api\/v1\/agent/);
    assert.doesNotMatch(apply, /replacement_block|server_name joyst\.ir/);
    assert.match(apply, /nginx -t/);
    assert.match(apply, /restore/);
    assert.match(deploy, /--resolve[\s\S]+?joyst\.ir:443:/);
    assert.match(deploy, /--max-time\s+20/);
    assert.match(deploy, /--cacert/);
    assert.match(deploy, /roll.?back|restore_previous/);
    assert.match(deploy, /cp -p "\$NGINX_ROLLBACK_FILE" "\$NGINX_CONF"/);
    assert.match(deploy, /ln -s -- "\$PREVIOUS_API_TARGET"/);
    assert.match(deploy, /systemctl restart/);
    const target = readFileSync(
      new URL('../../deploy/joy-media-account-web.nginx.conf', import.meta.url),
      'utf8',
    );
    const firstServer = target.indexOf('server {');
    const secondServer = target.indexOf('\nserver {', firstServer + 1);
    const joystBlock = target.slice(firstServer, secondServer);
    assert.match(joystBlock, /listen 82\.115\.8\.224:443 ssl;/);
    assert.match(joystBlock, /listen 46\.249\.103\.142:443 ssl;/);
    assert.match(joystBlock, /listen \[::\]:443 ssl;/);
    assert.doesNotMatch(joystBlock, /listen 443 ssl;/);
  });
});
