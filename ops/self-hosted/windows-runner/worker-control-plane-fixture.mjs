#!/usr/bin/env node
/* global Buffer, URL, process */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = parseArguments(process.argv.slice(2));
const readyPath = requiredArgument(args, 'ready-file');
const eventsPath = requiredArgument(args, 'events-file');
const maxBodyBytes = 256 * 1024;
const pairingToken = `fixture-session-${randomUUID()}`;
const pendingOffers = new Map();
const pairedWorkerIds = new Set();
let lastWorkerId;
let closed = false;
const counters = {
  offers: 0,
  claims: 0,
  hello: 0,
  leases: 0,
  previews: 0,
  authenticatedRequests: 0,
};

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--') || values[index + 1] === undefined)
      throw new Error('fixture arguments must be named pairs');
    parsed[value.slice(2)] = values[index + 1];
    index += 1;
  }
  return parsed;
}

function requiredArgument(values, name) {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeSnapshot(status = 'running') {
  mkdirSync(dirname(eventsPath), { recursive: true });
  const snapshot = {
    schemaVersion: 1,
    status,
    paired: pairedWorkerIds.size > 0,
    workerId: lastWorkerId,
    counters: { ...counters },
  };
  writeFileSync(eventsPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  try {
    chmodSync(eventsPath, 0o600);
  } catch {
    // Windows ACLs are controlled by the runner account; chmod is best effort.
  }
}

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store',
  });
  response.end(encoded);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return {};
  const value = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('request body must be an object');
  return value;
}

function pathFrom(request) {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`).pathname;
}

function workerPath(pathname, suffix) {
  return pathname.startsWith(`/api/v1/workers/`) && pathname.endsWith(suffix);
}

const server = createServer(async (request, response) => {
  try {
    const pathname = pathFrom(request);
    if (request.method === 'GET' && pathname === '/__joy_media_fixture/health') {
      sendJson(response, 200, { ok: true, ...JSON.parse(readSnapshot()) });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    const body = await readJson(request);
    if (pathname === '/api/v1/worker-pair/offers') {
      if (typeof body.workerId !== 'string' || typeof body.pairingCode !== 'string') {
        sendJson(response, 400, { error: 'invalid_pairing_offer' });
        return;
      }
      lastWorkerId = body.workerId;
      pendingOffers.set(body.workerId, {
        code: body.pairingCode,
        expiresAt: Date.now() + 300_000,
      });
      counters.offers += 1;
      writeSnapshot();
      sendJson(response, 200, {
        data: { expiresAt: pendingOffers.get(body.workerId).expiresAt },
      });
      return;
    }
    if (pathname === '/api/v1/worker-pair/claim') {
      const offer =
        typeof body.workerId === 'string' ? pendingOffers.get(body.workerId) : undefined;
      const accepted =
        typeof body.workerId === 'string' &&
        typeof body.pairingCode === 'string' &&
        offer !== undefined &&
        body.pairingCode === offer.code &&
        Date.now() < offer.expiresAt;
      if (!accepted) {
        sendJson(response, 403, { error: 'pairing_pending' });
        return;
      }
      counters.claims += 1;
      pairedWorkerIds.add(body.workerId);
      pendingOffers.delete(body.workerId);
      lastWorkerId = body.workerId;
      writeSnapshot();
      sendJson(response, 200, { data: { sessionToken: pairingToken } });
      return;
    }
    if (
      !workerPath(pathname, '/hello') &&
      !workerPath(pathname, '/leases') &&
      !workerPath(pathname, '/preview/next')
    ) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (request.headers.authorization !== `Bearer ${pairingToken}`) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    counters.authenticatedRequests += 1;
    if (pathname.endsWith('/hello')) counters.hello += 1;
    else if (pathname.endsWith('/leases')) counters.leases += 1;
    else counters.previews += 1;
    writeSnapshot();
    sendJson(response, 200, {
      data:
        pathname.endsWith('/leases') || pathname.endsWith('/preview/next') ? null : { ok: true },
    });
  } catch {
    sendJson(response, 400, { error: 'invalid_fixture_request' });
  }
});

function readSnapshot() {
  return JSON.stringify({
    schemaVersion: 1,
    status: closed ? 'stopped' : 'running',
    paired: pairedWorkerIds.size > 0,
    workerId: lastWorkerId,
    counters: { ...counters },
  });
}

function stop(signal) {
  if (closed) return;
  closed = true;
  writeSnapshot('stopped');
  server.close(() => process.exit(signal === undefined ? 0 : 0));
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('uncaughtException', () => stop('uncaughtException'));

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('fixture did not bind a TCP port');
  mkdirSync(dirname(readyPath), { recursive: true });
  writeFileSync(
    readyPath,
    `${JSON.stringify({ schemaVersion: 1, pid: process.pid, port: address.port, baseUrl: `http://127.0.0.1:${address.port}/api` })}\n`,
    { mode: 0o600 },
  );
  try {
    chmodSync(readyPath, 0o600);
  } catch {
    // Best-effort permissions; the fixture runs under the isolated CI account.
  }
  writeSnapshot();
});
