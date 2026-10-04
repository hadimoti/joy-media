import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyKeyCheck, parseSmokeArgs, requestGateway } from './smoke-gateway-lib.mjs';

describe('gateway smoke helpers', () => {
  it('parses local base, host, and pre-cutover mode', () => {
    assert.deepEqual(
      parseSmokeArgs([
        '--base-url',
        'https://127.0.0.1/api/v1/agent',
        '--host',
        'joy.test',
        '--pre-cutover',
      ]),
      { baseUrl: 'https://127.0.0.1/api/v1/agent', host: 'joy.test', preCutover: true },
    );
  });

  it('rejects remote smoke targets', () => {
    assert.throws(
      () => parseSmokeArgs([], { JOY_GATEWAY_BASE_URL: 'https://joyst.ir/api/v1/agent' }),
      /loopback/,
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

  it('uses joyst.ir SNI and Host while verifying the loopback certificate', async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-gateway-tls-'));
    try {
      const keyPath = join(directory, 'key.pem');
      const certPath = join(directory, 'cert.pem');
      const ipKeyPath = join(directory, 'ip-key.pem');
      const ipCertPath = join(directory, 'ip-cert.pem');
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
              keyPath,
              '-out',
              certPath,
              '-days',
              '1',
              '-subj',
              '/CN=joyst.ir',
              '-addext',
              'subjectAltName=DNS:joyst.ir',
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
              ipKeyPath,
              '-out',
              ipCertPath,
              '-days',
              '1',
              '-subj',
              '/CN=127.0.0.1',
              '-addext',
              'subjectAltName=IP:127.0.0.1',
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
        const baseUrl = `https://127.0.0.1:${address.port}/api/v1/agent`;
        const response = await requestGateway(baseUrl, '/models', {}, 'joyst.ir', {
          ca: readFileSync(certPath),
        });
        assert.equal(response.status, 200);
        assert.equal(observedServername, 'joyst.ir');
        assert.equal(response.headers.get('x-request-host'), 'joyst.ir');
        const ipOnlyServer = createServer(
          { key: readFileSync(ipKeyPath), cert: readFileSync(ipCertPath) },
          (_req, res) => res.end('unexpectedly accepted IP-only certificate'),
        );
        await new Promise((resolve, reject) => {
          ipOnlyServer.once('error', reject);
          ipOnlyServer.listen(0, '127.0.0.1', resolve);
        });
        const ipAddress = ipOnlyServer.address();
        const ipBaseUrl = `https://127.0.0.1:${ipAddress.port}/api/v1/agent`;
        try {
          await assert.rejects(
            requestGateway(ipBaseUrl, '/models', {}, 'joyst.ir', {
              ca: readFileSync(ipCertPath),
            }),
            (error) => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID',
          );
        } finally {
          await new Promise((resolve) => ipOnlyServer.close(resolve));
        }
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs the pre-cutover smoke before API cutover and retains the post-cutover smoke', async () => {
    const { readFileSync } = await import('node:fs');
    const script = readFileSync(
      new URL('../../deploy/deploy-control-plane.sh', import.meta.url),
      'utf8',
    );
    const preflight = script.indexOf('smoke-gateway.mjs" --pre-cutover');
    const cutover = script.indexOf('bash "$SCRIPT_DIR/deploy-cutover.sh"');
    assert.ok(preflight >= 0, 'pre-cutover smoke is present');
    assert.ok(cutover >= 0, 'API cutover call is present');
    assert.ok(preflight < cutover, 'pre-cutover smoke runs before API cutover');
    const postflight = script.lastIndexOf('smoke-gateway.mjs');
    assert.ok(postflight > cutover, 'post-cutover smoke remains after API cutover');
  });
});
