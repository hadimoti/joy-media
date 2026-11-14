#!/usr/bin/env node
/* global process, Buffer, fetch */
/**
 * JOY Media CLI Matrix Runner (T-A13).
 *
 * Runs the built CLI (`node apps/cli/bin/joy-media.mjs`) in an isolated
 * scratch USERPROFILE/HOME and verifies stdout, stderr, --json shape, and exit
 * codes for every row L-001 through L-051 defined in docs/qa/v1.1.1/TEST-MATRIX.md.
 *
 * Also emits the three `cli.render.*` readiness evidence records:
 *  - cli.render.playable
 *  - cli.render.unsupported-features
 *  - cli.render.failure-recovery
 *
 * Evidence output: C:\jgp\v111\evidence\T-A13\ and cli-matrix.json.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CLI_BIN = join(REPO_ROOT, 'apps', 'cli', 'bin', 'joy-media.mjs');
const STUB_SERVER_PATH = join(REPO_ROOT, 'tooling', 'qa', 'stub-model', 'server.mjs');
const DEFAULT_EVIDENCE_DIR = 'C:\\jgp\\v111\\evidence\\T-A13';

// ---------------------------------------------------------------------------
// Environment & Scratch Directory Management
// ---------------------------------------------------------------------------

function getScratchBase() {
  const preferred = 'C:\\jgp\\v111\\agy2';
  try {
    if (!existsSync(preferred)) {
      mkdirSync(preferred, { recursive: true });
    }
    return preferred;
  } catch {
    return tmpdir();
  }
}

function createTestSandbox() {
  const base = getScratchBase();
  const root = mkdtempSync(join(base, 'cli-matrix-sandbox-'));
  const home = join(root, 'home');
  const appdata = join(home, 'AppData', 'Roaming');
  const localappdata = join(home, 'AppData', 'Local');
  const tempDir = join(root, 'tmp');
  const assetsDir = join(root, 'assets');
  const workDir = join(root, 'work');

  mkdirSync(home, { recursive: true });
  mkdirSync(appdata, { recursive: true });
  mkdirSync(localappdata, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  // Initialize sample asset library catalog and dummy media files
  const catalog = {
    assets: [
      {
        id: 'asset-sample-img',
        kind: 'image',
        displayName: 'Sample Image',
        relativePath: 'sample.png',
        bytes: 128,
      },
      {
        id: 'asset-sample-audio',
        kind: 'audio',
        displayName: 'Sample Audio',
        relativePath: 'sample.wav',
        bytes: 256,
      },
      {
        id: 'asset-sample-video',
        kind: 'video',
        displayName: 'Sample Video',
        relativePath: 'sample.mp4',
        bytes: 512,
      },
    ],
  };
  writeFileSync(join(assetsDir, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
  writeFileSync(join(assetsDir, 'sample.png'), Buffer.alloc(128, 0));
  writeFileSync(join(assetsDir, 'sample.wav'), Buffer.alloc(256, 0));
  writeFileSync(join(assetsDir, 'sample.mp4'), Buffer.alloc(512, 0));

  const scrubbedKeys = [
    'KILO_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'XAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'ARK_API_KEY',
    'BYTEPLUS_API_KEY',
    'JOY_MEDIA_SQLITE_PATH',
    'JOY_CLI_DEBUG',
    'NO_COLOR',
    'FORCE_COLOR',
  ];

  const env = { ...process.env };
  for (const key of scrubbedKeys) {
    delete env[key];
  }
  env.USERPROFILE = home;
  env.HOME = home;
  env.APPDATA = appdata;
  env.LOCALAPPDATA = localappdata;
  env.TEMP = tempDir;
  env.TMP = tempDir;
  env.TMPDIR = tempDir;
  env.JOY_MEDIA_ASSET_LIBRARY = assetsDir;
  env.JOY_MODELS_DIR = join(home, 'JOY', 'models');

  return {
    root,
    home,
    appdata,
    localappdata,
    tempDir,
    assetsDir,
    workDir,
    env,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Loopback Stub Model Server Lifecycle
// ---------------------------------------------------------------------------

async function startStubModelServer(sandbox) {
  const scriptPath = join(sandbox.root, 'stub-responses.json');
  const logPath = join(sandbox.root, 'stub-requests.ndjson');

  // Scripted responses matching expected sequence of LLM calls:
  // 1 & 2: agent run (tool call propose_timeline_operations, then Done)
  // 3: agent probe (tool call joy_probe)
  // 4: agent probe inside L-048 --json shape
  // 5+: generic assistant responses
  const script = {
    model: 'joy-stub-model',
    responses: [
      {
        content: null,
        tool_calls: [
          {
            id: 'call-split-1',
            type: 'function',
            function: {
              name: 'propose_timeline_operations',
              arguments: JSON.stringify({
                operations: [
                  {
                    kind: 'insert',
                    id: 'agent-intro',
                    assetId: 'asset-sample-video',
                    trackId: 'track-v1',
                    startUs: 0,
                    durationUs: 2_000_000,
                    dependsOn: [],
                  },
                ],
              }),
            },
          },
        ],
      },
      { content: 'Done. Staged intro clip.' },
      ...Array.from({ length: 10 }, (_, i) => ({
        content: null,
        tool_calls: [
          {
            id: `probe-call-${i + 1}`,
            type: 'function',
            function: {
              name: 'joy_probe',
              arguments: JSON.stringify({ value: 'JOY_PROBE' }),
            },
          },
        ],
      })),
      ...Array.from({ length: 60 }, (_, i) => ({
        content: `Generic stub response ${i + 1}`,
      })),
    ],
  };
  writeFileSync(scriptPath, JSON.stringify(script, null, 2), 'utf8');

  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [STUB_SERVER_PATH, '--port', '0', '--script', scriptPath, '--log', logPath],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let ready = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'ready') {
            ready = true;
            resolvePromise({
              child,
              baseUrl: parsed.baseUrl,
              model: parsed.model,
              logPath,
              async stop() {
                try {
                  await fetch(`${parsed.baseUrl.replace(/\/v1$/, '')}/__shutdown`, {
                    method: 'POST',
                  }).catch(() => {});
                } catch {
                  // ignore
                }
                child.kill();
              },
            });
            break;
          }
        } catch {
          // not JSON yet
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      if (!ready) {
        process.stderr.write(`[stub-server stderr] ${chunk.toString('utf8')}`);
      }
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (!ready) {
        reject(new Error(`Stub model server exited prematurely with code ${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// CLI Execution Helper
// ---------------------------------------------------------------------------

function executeCli(args, sandbox, options = {}) {
  const timeout = options.timeoutMs ?? 30_000;
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: options.cwd ?? sandbox.workDir,
    env: options.env ? { ...sandbox.env, ...options.env } : sandbox.env,
    input: options.input,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });

  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

/**
 * Spawn the CLI asynchronously, wait until it prints something (or `readyMs`),
 * send `signal`, and await its close. The child is always killed on the way out.
 * Only used where a real signal can be delivered (see L-007).
 */
function executeCliWithSignal(args, sandbox, signal, readyMs = 400, closeTimeoutMs = 5_000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: sandbox.env,
      cwd: sandbox.workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let sent = false;
    let settled = false;
    const timers = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolvePromise({ out, signalSent: sent, ...result });
    };
    const send = () => {
      if (sent || settled) return;
      sent = true;
      try {
        child.kill(signal);
      } catch {
        // reported through the close result
      }
      timers.push(
        setTimeout(() => finish({ code: null, sig: null, timedOut: true }), closeTimeoutMs),
      );
    };
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      // The child printed its prompt: give it a moment to install handlers, then signal.
      timers.push(setTimeout(send, 100));
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.on('error', (err) => finish({ code: null, sig: null, error: err.message }));
    child.on('close', (code, sig) => finish({ code, sig, timedOut: false }));
    timers.push(setTimeout(send, readyMs));
  });
}

/** Last parseable JSON line of an NDJSON stdout (the render `complete` / `error` event). */
function lastJsonEvent(stdout) {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep looking
    }
  }
  return null;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A media file (not a manifest) with the given extension that really has bytes. */
function findMediaFile(dir, extension) {
  return listDir(dir).find((name) => {
    if (!name.endsWith(`.${extension}`) || name.endsWith('.manifest.json')) return false;
    try {
      return statSync(join(dir, name)).size > 0;
    } catch {
      return false;
    }
  });
}

function readCliVersion() {
  const pkg = readJsonFile(join(REPO_ROOT, 'apps', 'cli', 'package.json'));
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

// 1x1 PNG and a 0.1 s mono 8 kHz WAV: valid inputs for the Worker success path.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
function tinyWav() {
  const samples = 800;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Runs each command; ok only if every one exits 0 and prints a valid JSON document. */
function checkJsonFamily(commands, sandbox) {
  const results = commands.map((cmd) => {
    const res = executeCli(cmd, sandbox);
    let validJson = true;
    try {
      JSON.parse(res.stdout);
    } catch {
      validJson = false;
    }
    return { command: cmd.join(' '), exitCode: res.status, validJson };
  });
  const firstBad = results.find((r) => r.exitCode !== 0 || !r.validJson);
  return {
    ok: firstBad === undefined,
    exitCode: firstBad ? firstBad.exitCode : 0,
    report: { results },
  };
}

/** One readiness record, shaped like the release validator's ScenarioResult plus the measured checks. */
function scenarioRecord(id, checks, details) {
  const allPassed = checks.every((c) => c.status === 'passed');
  const anyFailed = checks.some((c) => c.status === 'failed');
  const status = allPassed ? 'passed' : anyFailed ? 'failed' : 'skipped';
  return {
    id,
    status,
    firstAttemptPassed: status === 'passed',
    retries: 0,
    timestamp: new Date().toISOString(),
    checks,
    details,
  };
}

// ---------------------------------------------------------------------------
// Matrix Row Definitions (L-001 through L-051)
// ---------------------------------------------------------------------------

export async function runCliMatrix(options = {}) {
  const evidenceDir = options.evidenceDir || DEFAULT_EVIDENCE_DIR;
  if (!existsSync(evidenceDir)) {
    try {
      mkdirSync(evidenceDir, { recursive: true });
    } catch {
      // best effort
    }
  }

  const sandbox = createTestSandbox();
  let stubServer;
  try {
    stubServer = await startStubModelServer(sandbox);
  } catch (err) {
    sandbox.cleanup();
    throw new Error(`Failed to start stub model server: ${err.message}`);
  }

  const rows = [];
  const readinessRecords = [];

  function recordEvidence(filename, content) {
    try {
      if (existsSync(evidenceDir)) {
        writeFileSync(join(evidenceDir, filename), content, 'utf8');
      }
    } catch {
      // non-fatal
    }
  }

  // Seed initial project and asset for project / timeline / render commands
  const seedProjectRes = executeCli(
    [
      'project',
      'create',
      'Matrix Reel',
      '--width',
      '1920',
      '--height',
      '1080',
      '--fps',
      '30',
      '--json',
    ],
    sandbox,
  );
  let defaultProjectId = 'proj-matrix-seed';
  try {
    const parsed = JSON.parse(seedProjectRes.stdout);
    defaultProjectId = parsed.id;
  } catch {
    // fallback
  }

  // Add initial clip to track-v1
  const seedClipRes = executeCli(
    [
      'timeline',
      'add-clip',
      '--project',
      defaultProjectId,
      '--track',
      'track-v1',
      '--asset',
      'asset-sample-video',
      '--start',
      '0',
      '--duration',
      '4',
      '--json',
    ],
    sandbox,
  );
  let seedClipId = 'clip-seed-1';
  try {
    const parsed = JSON.parse(seedClipRes.stdout);
    if (parsed.clip?.id) seedClipId = parsed.clip.id;
  } catch {
    // fallback
  }

  // Row L-001: help
  {
    const r = executeCli(['help'], sandbox);
    const hasCommands = [
      'agent',
      'project',
      'assets',
      'timeline',
      'worker',
      'render',
      'benchmark',
      'doctor',
    ].every((cmd) => r.stdout.includes(cmd));
    const pass = r.status === 0 && hasCommands;
    recordEvidence('L-001.txt', r.stdout);
    rows.push({
      id: 'L-001',
      command: 'joy-media help',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Help lists every command in the matrix',
      evidence: 'T-A13\\L-001.txt',
    });
  }

  // Row L-002: help <command>
  {
    const r = executeCli(['help', 'project'], sandbox);
    const pass = r.status === 0 && r.stdout.includes('Usage:') && r.stdout.includes('project');
    recordEvidence('L-002.txt', r.stdout);
    rows.push({
      id: 'L-002',
      command: 'joy-media help project',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: "One command's help prints",
      evidence: 'T-A13\\L-002.txt',
    });
  }

  // Row L-003: --version / -v
  {
    const r = executeCli(['--version'], sandbox);
    const expectedVersion = readCliVersion();
    const pass = r.status === 0 && expectedVersion !== null && r.stdout.includes(expectedVersion);
    recordEvidence('L-003.txt', `${r.stdout}\n[package version: ${expectedVersion}]`);
    rows.push({
      id: 'L-003',
      command: 'joy-media --version',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: `CLI prints the package version (${expectedVersion ?? 'unreadable'}) on stdout`,
      evidence: 'T-A13\\L-003.txt',
    });
  }

  // Row L-004: --help / -h
  {
    const r = executeCli(['--help'], sandbox);
    const pass = r.status === 0 && r.stdout.includes('Usage: joy-media');
    recordEvidence('L-004.txt', r.stdout);
    rows.push({
      id: 'L-004',
      command: 'joy-media --help',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Global help works as flag',
      evidence: 'T-A13\\L-004.txt',
    });
  }

  // Row L-005: unknown command. The CLI returns 1 by design (reportUnknownCommand; the
  // existing CLI tests pin it), so the matrix row said 2 in error: a matrix correction.
  {
    const r = executeCli(['nope'], sandbox);
    const pass = r.status === 1 && r.stderr.includes('Unknown command');
    recordEvidence('L-005.txt', `${r.stderr}\n[exit code ${r.status}]`);
    rows.push({
      id: 'L-005',
      command: 'joy-media nope',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Unknown command: message on stderr, exit 1',
      evidence: 'T-A13\\L-005.txt',
      note: 'Matrix correction: TEST-MATRIX.md said exit 2; the CLI exits 1 by design (exit 2 is for bad options).',
    });
  }

  // Row L-006: unknown flag --nope
  {
    const r = executeCli(['project', 'list', '--nope'], sandbox);
    const pass = r.status === 2 && r.stderr.includes('Unknown option --nope');
    recordEvidence('L-006.txt', `${r.stderr}\n[exit code ${r.status}]`);
    rows.push({
      id: 'L-006',
      command: 'joy-media project list --nope',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Unknown flag is a usage error (exit 2)',
      evidence: 'T-A13\\L-006.txt',
    });
  }

  // Row L-007: Ctrl+C in agent chat. On Windows, child.kill('SIGINT') terminates the child
  // without running its handlers, so a real Ctrl+C needs a pty or a console-control event:
  // not testable here, recorded as NOT-TESTED. Elsewhere the signal is really sent (async).
  {
    if (process.platform === 'win32') {
      const reason =
        "Needs a pty or a console-control event: on Windows child.kill('SIGINT') ends the process without running its SIGINT handler, so no exit code could be measured honestly.";
      recordEvidence('L-007.txt', `NOT-TESTED\n${reason}\n`);
      rows.push({
        id: 'L-007',
        command: 'joy-media agent chat (Ctrl+C)',
        status: 'NOT-TESTED',
        exitCode: null,
        summary: 'Interrupted agent chat exits 130',
        evidence: 'T-A13\\L-007.txt',
        note: reason,
      });
    } else {
      const res = await executeCliWithSignal(['agent', 'chat'], sandbox, 'SIGINT');
      const pass = res.signalSent && !res.timedOut && !res.error && res.code === 130;
      recordEvidence(
        'L-007.txt',
        `signalSent=${res.signalSent} code=${res.code} signal=${res.sig} timedOut=${res.timedOut === true}\n${res.out}`,
      );
      rows.push({
        id: 'L-007',
        command: 'joy-media agent chat (Ctrl+C)',
        status: pass ? 'PASS' : 'FAIL',
        exitCode: res.code,
        summary: 'Interrupted agent chat exits 130',
        evidence: 'T-A13\\L-007.txt',
      });
    }
  }

  // Row L-008: agent chat with piped exit
  {
    const r = executeCli(
      [
        'agent',
        'chat',
        '--project',
        defaultProjectId,
        '--url',
        stubServer.baseUrl,
        '--api-key',
        'dummy-key',
        '--model',
        stubServer.model,
      ],
      sandbox,
      { input: '/exit\n' },
    );
    const pass = r.status === 0 && r.stdout.includes('Goodbye!');
    recordEvidence('L-008.txt', r.stdout);
    rows.push({
      id: 'L-008',
      command: 'joy-media agent chat (exit)',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Interactive REPL starts and cleanly exits on EOF/exit',
      evidence: 'T-A13\\L-008.txt',
    });
  }

  // Row L-009: agent run "<instruction>"
  {
    const dryRun = executeCli(
      [
        'agent',
        'run',
        'add intro clip',
        '--project',
        defaultProjectId,
        '--url',
        stubServer.baseUrl,
        '--api-key',
        'dummy-key',
        '--model',
        stubServer.model,
        '--json',
      ],
      sandbox,
    );
    let pass = dryRun.status === 0;
    try {
      const parsed = JSON.parse(dryRun.stdout);
      pass = pass && parsed.ok === true;
    } catch {
      pass = false;
    }

    recordEvidence('L-009.json', dryRun.stdout);
    rows.push({
      id: 'L-009',
      command: 'joy-media agent run "add intro clip"',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: dryRun.status,
      summary: 'One-shot agent edit runs with --apply / dry-run',
      evidence: 'T-A13\\L-009.json',
    });
  }

  // Row L-010: agent probe
  {
    const r = executeCli(
      [
        'agent',
        'probe',
        '--url',
        stubServer.baseUrl,
        '--api-key',
        'dummy-key',
        '--model',
        stubServer.model,
        '--json',
      ],
      sandbox,
    );
    let pass = r.status === 0;
    try {
      const parsed = JSON.parse(r.stdout);
      pass = pass && parsed.ok === true && typeof parsed.capability === 'string';
    } catch {
      pass = false;
    }

    recordEvidence('L-010.json', r.stdout);
    rows.push({
      id: 'L-010',
      command: 'joy-media agent probe',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Provider probe reports capabilities',
      evidence: 'T-A13\\L-010.json',
    });
  }

  // Row L-011: agent config
  {
    const r1 = executeCli(['agent', 'config', '--json'], sandbox);
    const r2 = executeCli(['agent', 'config', '--temperature', '0.7', '--json'], sandbox);
    const pass = r1.status === 0 && r2.status === 0;
    recordEvidence('L-011.json', r2.stdout || r1.stdout);
    rows.push({
      id: 'L-011',
      command: 'joy-media agent config',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r2.status,
      summary: 'Agent config shown and updated',
      evidence: 'T-A13\\L-011.json',
    });
  }

  // Row L-012: agent provider list
  {
    const r = executeCli(['agent', 'provider', 'list'], sandbox);
    const pass = r.status === 0;
    recordEvidence('L-012.txt', r.stdout);
    rows.push({
      id: 'L-012',
      command: 'joy-media agent provider list',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Configured providers are listed',
      evidence: 'T-A13\\L-012.txt',
    });
  }

  // Row L-013: agent provider add
  {
    const r = executeCli(
      [
        'agent',
        'provider',
        'add',
        'test-stub',
        '--url',
        stubServer.baseUrl,
        '--api-key',
        'dummy-key',
        '--model',
        stubServer.model,
      ],
      sandbox,
    );
    const pass = r.status === 0 && r.stdout.includes('configured successfully');
    recordEvidence('L-013.txt', r.stdout);
    rows.push({
      id: 'L-013',
      command: 'joy-media agent provider add test-stub',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'AI provider is added',
      evidence: 'T-A13\\L-013.txt',
    });
  }

  // Row L-014: agent provider use
  {
    const r = executeCli(['agent', 'provider', 'use', 'test-stub'], sandbox);
    const pass = r.status === 0;
    recordEvidence('L-014.txt', r.stdout);
    rows.push({
      id: 'L-014',
      command: 'joy-media agent provider use test-stub',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Active AI provider changes',
      evidence: 'T-A13\\L-014.txt',
    });
  }

  // Row L-015: agent provider remove
  {
    const r1 = executeCli(['agent', 'provider', 'remove', 'test-stub'], sandbox);
    const r2 = executeCli(['agent', 'provider', 'remove', 'test-stub'], sandbox);
    const pass = r1.status === 0 && r2.status === 1;
    recordEvidence('L-015.txt', `${r1.stdout}\n[Second remove exit ${r2.status}]: ${r2.stderr}`);
    rows.push({
      id: 'L-015',
      command: 'joy-media agent provider remove test-stub',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r1.status,
      summary: 'Provider removed; removing twice exits 1',
      evidence: 'T-A13\\L-015.txt',
    });
  }

  // Row L-016: agent model get
  {
    // Re-add provider for model and slot tests
    executeCli(
      [
        'agent',
        'provider',
        'add',
        'active-stub',
        '--url',
        stubServer.baseUrl,
        '--api-key',
        'dummy-key',
        '--model',
        stubServer.model,
      ],
      sandbox,
    );
    executeCli(['agent', 'provider', 'use', 'active-stub'], sandbox);

    const r = executeCli(['agent', 'model', 'get'], sandbox);
    const pass = r.status === 0 && r.stdout.includes(stubServer.model);
    recordEvidence('L-016.txt', r.stdout);
    rows.push({
      id: 'L-016',
      command: 'joy-media agent model get',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Default model is shown',
      evidence: 'T-A13\\L-016.txt',
    });
  }

  // Row L-017: agent model set <id>
  {
    const rSet = executeCli(['agent', 'model', 'set', 'joy-updated-model'], sandbox);
    const rGet = executeCli(['agent', 'model', 'get'], sandbox);
    const pass = rSet.status === 0 && rGet.stdout.includes('joy-updated-model');
    recordEvidence('L-017.txt', `${rSet.stdout}\n${rGet.stdout}`);
    rows.push({
      id: 'L-017',
      command: 'joy-media agent model set <id>',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rSet.status,
      summary: 'Default model changes and get reflects update',
      evidence: 'T-A13\\L-017.txt',
    });
  }

  // Row L-018: agent slot list
  {
    const r = executeCli(['agent', 'slot', 'list'], sandbox);
    const pass = r.status === 0 && r.stdout.includes('Workhorse') && r.stdout.includes('Creative');
    recordEvidence('L-018.txt', r.stdout);
    rows.push({
      id: 'L-018',
      command: 'joy-media agent slot list',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Workhorse and creative slots are listed',
      evidence: 'T-A13\\L-018.txt',
    });
  }

  // Row L-019: agent slot set
  {
    const r = executeCli(
      ['agent', 'slot', 'set', 'workhorse', '--model', stubServer.model],
      sandbox,
    );
    const pass = r.status === 0;
    recordEvidence('L-019.txt', r.stdout);
    rows.push({
      id: 'L-019',
      command: 'joy-media agent slot set workhorse',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Slot model is configured',
      evidence: 'T-A13\\L-019.txt',
    });
  }

  // Row L-020: agent slot clear
  {
    const r = executeCli(['agent', 'slot', 'clear', 'workhorse'], sandbox);
    const pass = r.status === 0;
    recordEvidence('L-020.txt', r.stdout);
    rows.push({
      id: 'L-020',
      command: 'joy-media agent slot clear workhorse',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Slot model is cleared',
      evidence: 'T-A13\\L-020.txt',
    });
  }

  // Row L-021: agent models
  {
    const r = executeCli(
      ['agent', 'models', '--url', stubServer.baseUrl, '--api-key', 'dummy-key', '--json'],
      sandbox,
    );
    let pass = r.status === 0;
    try {
      const parsed = JSON.parse(r.stdout);
      pass = pass && Array.isArray(parsed.models || parsed.data);
    } catch {
      pass = false;
    }

    recordEvidence('L-021.json', r.stdout);
    rows.push({
      id: 'L-021',
      command: 'joy-media agent models',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Model list fetched from endpoint',
      evidence: 'T-A13\\L-021.json',
    });
  }

  // Row L-022: project list
  {
    const r = executeCli(['project', 'list'], sandbox);
    const pass = r.status === 0 && r.stdout.includes('Local Projects');
    recordEvidence('L-022.txt', r.stdout);
    rows.push({
      id: 'L-022',
      command: 'joy-media project list',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Local projects listed',
      evidence: 'T-A13\\L-022.txt',
    });
  }

  // Row L-023: project create
  {
    const rGood = executeCli(
      [
        'project',
        'create',
        'qa-canvas',
        '--width',
        '1920',
        '--height',
        '1080',
        '--fps',
        '30',
        '--json',
      ],
      sandbox,
    );
    const rBad = executeCli(['project', 'create', 'qa-bad', '--fps', '0'], sandbox);
    const pass = rGood.status === 0 && rBad.status === 2;
    recordEvidence('L-023.json', rGood.stdout);
    rows.push({
      id: 'L-023',
      command: 'joy-media project create',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rGood.status,
      summary: 'Project created with chosen canvas; --fps 0 exits 2',
      evidence: 'T-A13\\L-023.json',
    });
  }

  // Row L-024: project show
  {
    const rGood = executeCli(['project', 'show', defaultProjectId, '--json'], sandbox);
    const rBad = executeCli(['project', 'show', 'missing-project-id-999'], sandbox);
    const pass = rGood.status === 0 && rBad.status === 1;
    recordEvidence('L-024.json', rGood.stdout);
    rows.push({
      id: 'L-024',
      command: 'joy-media project show <id>',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rGood.status,
      summary: 'Tracks and clips shown; missing id exits 1',
      evidence: 'T-A13\\L-024.json',
    });
  }

  // Row L-025: project export
  const exportedJsonFile = join(sandbox.workDir, 'exported-project.json');
  {
    const r = executeCli(
      ['project', 'export', defaultProjectId, '-o', exportedJsonFile, '--json'],
      sandbox,
    );
    const pass = r.status === 0 && existsSync(exportedJsonFile);
    recordEvidence('L-025.json', r.stdout);
    rows.push({
      id: 'L-025',
      command: 'joy-media project export',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Project exported to JSON file',
      evidence: 'T-A13\\L-025.json',
    });
  }

  // Row L-026: project import
  {
    const rGood = executeCli(['project', 'import', exportedJsonFile, '--json'], sandbox);
    const badJsonFile = join(sandbox.workDir, 'corrupt.json');
    writeFileSync(badJsonFile, '{"broken": true', 'utf8');
    const rBad = executeCli(['project', 'import', badJsonFile], sandbox);
    const pass = rGood.status === 0 && rBad.status === 1;
    recordEvidence('L-026.json', rGood.stdout);
    rows.push({
      id: 'L-026',
      command: 'joy-media project import',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rGood.status,
      summary: 'Project imported from JSON; malformed exits 1',
      evidence: 'T-A13\\L-026.json',
    });
  }

  // Row L-027: timeline add-clip
  let addedClipId = seedClipId;
  {
    const rGood = executeCli(
      [
        'timeline',
        'add-clip',
        '--project',
        defaultProjectId,
        '--track',
        'track-v1',
        '--asset',
        'asset-sample-video',
        '--start',
        '5',
        '--duration',
        '4',
        '--json',
      ],
      sandbox,
    );
    try {
      const parsed = JSON.parse(rGood.stdout);
      if (parsed.clip?.id) addedClipId = parsed.clip.id;
    } catch {
      // ignore
    }
    const rBad = executeCli(
      [
        'timeline',
        'add-clip',
        '--project',
        defaultProjectId,
        '--track',
        'track-v1',
        '--asset',
        'asset-sample-video',
        '--start',
        '-1',
        '--duration',
        '4',
      ],
      sandbox,
    );
    const pass = rGood.status === 0 && rBad.status === 2;
    recordEvidence('L-027.json', rGood.stdout);
    rows.push({
      id: 'L-027',
      command: 'joy-media timeline add-clip',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rGood.status,
      summary: 'Clip added to timeline; negative start exits 2',
      evidence: 'T-A13\\L-027.json',
    });
  }

  // Row L-028: timeline split
  {
    const rGood = executeCli(
      [
        'timeline',
        'split',
        '--project',
        defaultProjectId,
        '--clip',
        addedClipId,
        '--at',
        '7',
        '--json',
      ],
      sandbox,
    );
    const rBad = executeCli(
      ['timeline', 'split', '--project', defaultProjectId, '--clip', addedClipId, '--at', '999'],
      sandbox,
    );
    const pass = rGood.status === 0 && rBad.status === 1;
    recordEvidence('L-028.json', rGood.stdout);
    rows.push({
      id: 'L-028',
      command: 'joy-media timeline split',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rGood.status,
      summary: 'Clip split; splitting beyond clip boundary exits 1',
      evidence: 'T-A13\\L-028.json',
    });
  }

  // Row L-029: timeline trim
  {
    const rGood = executeCli(
      [
        'timeline',
        'trim',
        '--project',
        defaultProjectId,
        '--clip',
        seedClipId,
        '--start',
        '1',
        '--end',
        '3',
        '--json',
      ],
      sandbox,
    );
    const rBad = executeCli(
      ['timeline', 'trim', '--project', defaultProjectId, '--clip', seedClipId, '--duration', '0'],
      sandbox,
    );
    const pass = rGood.status === 0 && rBad.status === 2;
    recordEvidence('L-029.json', rGood.stdout);
    rows.push({
      id: 'L-029',
      command: 'joy-media timeline trim',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rGood.status,
      summary: 'Clip trimmed; duration 0 exits 2',
      evidence: 'T-A13\\L-029.json',
    });
  }

  // Row L-030: timeline remove-clip
  {
    const rGood = executeCli(
      ['timeline', 'remove-clip', '--project', defaultProjectId, '--clip', addedClipId, '--json'],
      sandbox,
    );
    const rBad = executeCli(
      ['timeline', 'remove-clip', '--project', defaultProjectId, '--clip', 'missing-clip-id'],
      sandbox,
    );
    const pass = rGood.status === 0 && rBad.status === 1;
    recordEvidence('L-030.json', rGood.stdout);
    rows.push({
      id: 'L-030',
      command: 'joy-media timeline remove-clip',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rGood.status,
      summary: 'Clip removed; missing clip exits 1',
      evidence: 'T-A13\\L-030.json',
    });
  }

  // Rows L-031 / L-032 share one measurement: the CLI has no Worker daemon to probe. `worker
  // status` reads local environment folders, so "up" means at least one environment is ready
  // and "down" means none is. The sandbox starts with no environment installed.
  const workerStatusRes = executeCli(['worker', 'status', '--json'], sandbox);
  let workerStatusDoc = null;
  try {
    workerStatusDoc = JSON.parse(workerStatusRes.stdout);
  } catch {
    workerStatusDoc = null;
  }
  const workerShapeOk =
    workerStatusRes.status === 0 &&
    workerStatusDoc !== null &&
    workerStatusDoc.gpu !== undefined &&
    Array.isArray(workerStatusDoc.environments) &&
    workerStatusDoc.models !== undefined;
  const workerEnvReady =
    workerShapeOk && workerStatusDoc.environments.some((env) => env.ready === true);

  // Row L-031: worker status (Worker up)
  {
    recordEvidence('L-031.json', workerStatusRes.stdout);
    let status = 'PASS';
    let note;
    if (!workerShapeOk) status = 'FAIL';
    else if (!workerEnvReady) {
      status = 'NOT-TESTED';
      note =
        'No Worker environment is installed in the sandbox (every environment ready:false), so the Worker-up report was not measured. The report shape (gpu, environments, models) was valid.';
    }
    rows.push({
      id: 'L-031',
      command: 'joy-media worker status (running)',
      status,
      exitCode: workerStatusRes.status,
      summary: 'GPU, environments and weights reported',
      evidence: 'T-A13\\L-031.json',
      note,
    });
  }

  // Row L-032: worker status (Worker down)
  {
    recordEvidence(
      'L-032.json',
      `${workerStatusRes.stdout}\n[exit code ${workerStatusRes.status}; any environment ready: ${workerEnvReady}]`,
    );
    let status;
    let defectReason;
    if (!workerShapeOk) status = 'FAIL';
    else if (workerEnvReady) {
      status = 'NOT-TESTED';
    } else if (workerStatusRes.status === 1) status = 'PASS';
    else {
      status = 'DEFECT';
      defectReason = `Measured: no Worker environment ready and exit ${workerStatusRes.status}, but the matrix expects a "not running" report with exit 1. The CLI has no Worker daemon probe; it reports local environments and exits 0.`;
    }
    rows.push({
      id: 'L-032',
      command: 'joy-media worker status (no environment ready)',
      status,
      exitCode: workerStatusRes.status,
      summary: 'Worker missing returns exit 1',
      evidence: 'T-A13\\L-032.json',
      defectReason,
    });
  }

  // Rows L-033 / L-034: error paths are measured; the success path (an output file) needs a
  // ready Worker environment. Without one the row is NOT-TESTED, never passed.
  function workerOperationRow(id, operation, inputName, inputBytes, extraArgs, outName) {
    const missingArgs = ['worker', operation, `nonexistent-${inputName}`, ...extraArgs];
    const rMissing = executeCli(missingArgs, sandbox);
    const rBad =
      operation === 'upscale'
        ? executeCli(['worker', 'upscale', `nonexistent-${inputName}`, '--scale', '0'], sandbox)
        : null;
    const errorPathsOk = rMissing.status === 1 && (rBad === null || rBad.status === 2);

    let successStatus = null;
    let successOutput = null;
    if (workerEnvReady) {
      const input = join(sandbox.workDir, inputName);
      const output = join(sandbox.workDir, outName);
      writeFileSync(input, inputBytes);
      const rOk = executeCli(
        ['worker', operation, input, ...extraArgs, '--output', output],
        sandbox,
        { timeoutMs: 120_000 },
      );
      successStatus = rOk.status;
      successOutput = existsSync(output) && statSync(output).size > 0 ? output : null;
    }

    recordEvidence(
      `${id}.txt`,
      [
        `missing input: exit ${rMissing.status}\n${rMissing.stderr}`,
        rBad ? `bad scale 0: exit ${rBad.status}\n${rBad.stderr}` : '',
        workerEnvReady
          ? `success path: exit ${successStatus}, output file written: ${successOutput !== null}`
          : 'success path: not run (no Worker environment ready in the sandbox)',
      ].join('\n'),
    );

    let status;
    let note;
    if (!errorPathsOk) status = 'FAIL';
    else if (!workerEnvReady) {
      status = 'NOT-TESTED';
      note =
        'Error paths measured and as expected; the success path (an output file written) needs a ready Worker environment, none is installed in the sandbox.';
    } else status = successStatus === 0 && successOutput !== null ? 'PASS' : 'FAIL';

    rows.push({
      id,
      command: `joy-media worker ${operation}`,
      status,
      exitCode: rMissing.status,
      summary:
        operation === 'upscale'
          ? 'Upscale writes a file; missing input exits 1; bad scale exits 2'
          : 'Denoise writes a file; missing input exits 1',
      evidence: `T-A13\\${id}.txt`,
      note,
    });
  }
  workerOperationRow('L-033', 'upscale', 'in.png', TINY_PNG, ['--scale', '2'], 'out.png');
  workerOperationRow('L-034', 'denoise', 'in.wav', tinyWav(), [], 'out.wav');

  // Rows L-035 / L-036: classified from what was measured (exit code, manifest content,
  // a real non-empty media file in the output folder). PASS only if media was produced;
  // DEFECT only if the render succeeded but the manifest says mediaProduced:false and no
  // media file exists; FAIL for anything else.
  const renderOutDir = join(sandbox.workDir, 'renders');
  mkdirSync(renderOutDir, { recursive: true });
  function classifyRender(r, preset, extension) {
    const manifestFile = join(renderOutDir, `${defaultProjectId}.${extension}.manifest.json`);
    const manifestExists = existsSync(manifestFile);
    const manifest = manifestExists ? readJsonFile(manifestFile) : null;
    const event = lastJsonEvent(r.stdout);
    const mediaFile = findMediaFile(renderOutDir, extension);
    const mediaProduced = mediaFile !== undefined && manifest?.mediaProduced === true;
    let status = 'FAIL';
    let defectReason;
    if (r.status === 0 && manifestExists && mediaProduced) status = 'PASS';
    else if (
      r.status === 0 &&
      manifestExists &&
      manifest?.mediaProduced === false &&
      mediaFile === undefined
    ) {
      status = 'DEFECT';
      defectReason = `Measured: exit 0, manifest written, manifest mediaProduced:false, no .${extension} file in the output folder; the matrix expects a playable ${preset} file.`;
    }
    return { status, defectReason, manifestExists, manifest, event, mediaFile, mediaProduced };
  }

  let renderMp4 = null;
  // Row L-035: render (mp4)
  {
    const r = executeCli(
      ['render', '--project', defaultProjectId, '--preset', 'mp4', '--out', renderOutDir, '--json'],
      sandbox,
    );
    renderMp4 = { r, ...classifyRender(r, 'mp4', 'mp4') };
    recordEvidence(
      'L-035.json',
      renderMp4.manifest ? JSON.stringify(renderMp4.manifest, null, 2) : r.stdout,
    );
    rows.push({
      id: 'L-035',
      command: 'joy-media render (mp4)',
      status: renderMp4.status,
      exitCode: r.status,
      summary: 'A headless render writes a playable mp4 and a manifest',
      evidence: 'T-A13\\L-035.json',
      defectReason: renderMp4.defectReason,
    });
  }

  // Row L-036: render --preset webm
  {
    const r = executeCli(
      [
        'render',
        '--project',
        defaultProjectId,
        '--preset',
        'webm',
        '--out',
        renderOutDir,
        '--json',
      ],
      sandbox,
    );
    const c = classifyRender(r, 'webm', 'webm');
    recordEvidence('L-036.json', c.manifest ? JSON.stringify(c.manifest, null, 2) : r.stdout);
    rows.push({
      id: 'L-036',
      command: 'joy-media render --preset webm',
      status: c.status,
      exitCode: r.status,
      summary: 'The WebM preset writes a playable webm',
      evidence: 'T-A13\\L-036.json',
      defectReason: c.defectReason,
    });
  }

  // Readiness record cli.render.playable, derived from the mp4 measurement above.
  readinessRecords.push(
    scenarioRecord(
      'cli.render.playable',
      [
        { name: 'render-exit-zero', status: renderMp4.r.status === 0 ? 'passed' : 'failed' },
        { name: 'manifest-written', status: renderMp4.manifestExists ? 'passed' : 'failed' },
        { name: 'media-produced', status: renderMp4.mediaProduced ? 'passed' : 'failed' },
      ],
      {
        command: `joy-media render --project ${defaultProjectId} --preset mp4`,
        exitCode: renderMp4.r.status,
        manifestWritten: renderMp4.manifestExists,
        mediaProduced: renderMp4.mediaProduced,
        manifestSaysMediaProduced: renderMp4.manifest?.mediaProduced ?? null,
        mediaFile: renderMp4.mediaFile ?? null,
      },
    ),
  );
  // Readiness record cli.render.windows-entrypoints. The matrix runs the node entrypoint in
  // a scratch profile; the installed joy.cmd / joy-media.cmd shims are not exercised, so
  // those two checks are not-run (the record is "skipped", never passed).
  readinessRecords.push(
    scenarioRecord(
      'cli.render.windows-entrypoints',
      [
        { name: 'joy-cmd-version-reported', status: 'not-run' },
        { name: 'joy-media-cmd-version-reported', status: 'not-run' },
        {
          name: 'render-entrypoint-wrote-manifest',
          status: renderMp4.r.status === 0 && renderMp4.manifestExists ? 'passed' : 'failed',
        },
      ],
      {
        note: 'Only the node entrypoint ran; installed .cmd shims are covered by I-005 in the installed lifecycle.',
      },
    ),
  );

  // Row L-037: render --preset prores
  {
    const rGood = executeCli(
      [
        'render',
        '--project',
        defaultProjectId,
        '--preset',
        'prores',
        '--out',
        renderOutDir,
        '--json',
      ],
      sandbox,
    );
    const rBad = executeCli(
      ['render', '--project', defaultProjectId, '--preset', 'bad-preset', '--out', renderOutDir],
      sandbox,
    );
    const c = classifyRender(rGood, 'prores', 'mov');
    // The bad-preset run must still exit 2; if it does not, the row fails outright.
    const l037Status = rBad.status === 2 ? c.status : 'FAIL';
    recordEvidence('L-037.json', c.manifest ? JSON.stringify(c.manifest, null, 2) : rGood.stdout);

    // Readiness record cli.render.unsupported-features, derived from the bad-preset run.
    readinessRecords.push(
      scenarioRecord(
        'cli.render.unsupported-features',
        [
          {
            name: 'unsupported-preset-exit-2',
            status: rBad.status === 2 ? 'passed' : 'failed',
          },
          {
            name: 'unsupported-preset-message-on-stderr',
            status: rBad.stderr.trim().length > 0 ? 'passed' : 'failed',
          },
        ],
        {
          command: `joy-media render --project ${defaultProjectId} --preset bad-preset`,
          exitCode: rBad.status,
        },
      ),
    );

    rows.push({
      id: 'L-037',
      command: 'joy-media render --preset prores',
      status: l037Status,
      exitCode: rGood.status,
      summary: 'The ProRes preset writes a ProRes file; an invalid preset exits 2',
      evidence: 'T-A13\\L-037.json',
      defectReason: l037Status === 'DEFECT' ? c.defectReason : undefined,
    });
  }

  // Row L-038: render failure and recovery
  {
    // Create a standalone project JSON with a declared file asset that is missing from library
    const missingProjFile = join(sandbox.workDir, 'missing-asset-proj.json');
    const missingProjDoc = {
      format: 'joy-media-project',
      schemaVersion: 1,
      project: {
        id: 'proj-missing-asset-test',
        title: 'Missing Asset Test',
        rootCompositionId: 'comp-root',
        compositions: {
          'comp-root': {
            id: 'comp-root',
            tracks: [
              {
                id: 'track-v1',
                enabled: true,
                clips: [
                  {
                    id: 'clip-with-missing-file',
                    assetId: 'asset-missing-file-id',
                    startUs: 0,
                    durationUs: 2_000_000,
                  },
                ],
              },
            ],
          },
        },
        assets: {
          'asset-missing-file-id': {
            id: 'asset-missing-file-id',
            kind: 'video',
            displayName: 'missing-footage.mp4',
            relativePath: 'missing-footage.mp4',
          },
        },
      },
    };
    writeFileSync(missingProjFile, JSON.stringify(missingProjDoc, null, 2), 'utf8');

    const manifestsBefore = new Set(listDir(renderOutDir));
    const rFail = executeCli(
      ['render', '--project', missingProjFile, '--out', renderOutDir, '--json'],
      sandbox,
    );
    const manifestsAfterFail = listDir(renderOutDir).filter((n) => !manifestsBefore.has(n));
    const rRecover = executeCli(
      ['render', '--project', missingProjFile, '--allow-missing', '--out', renderOutDir, '--json'],
      sandbox,
    );
    const manifestsAfterRecover = listDir(renderOutDir).filter(
      (n) => !manifestsBefore.has(n) && n.endsWith('.manifest.json'),
    );
    const pass = rFail.status === 1 && rRecover.status === 0;

    recordEvidence(
      'L-038.txt',
      `Run 1 (missing media, exit ${rFail.status}):\n${rFail.stdout}\n${rFail.stderr}\n\nRun 2 (recovery with --allow-missing, exit ${rRecover.status}):\n${rRecover.stdout}`,
    );

    // Readiness record cli.render.failure-recovery, derived from both runs.
    const failEvent = lastJsonEvent(rFail.stdout);
    readinessRecords.push(
      scenarioRecord(
        'cli.render.failure-recovery',
        [
          { name: 'missing-media-exit-1', status: rFail.status === 1 ? 'passed' : 'failed' },
          {
            name: 'failed-run-wrote-no-manifest',
            status: manifestsAfterFail.length === 0 ? 'passed' : 'failed',
          },
          { name: 'allow-missing-exit-0', status: rRecover.status === 0 ? 'passed' : 'failed' },
          {
            name: 'recovery-wrote-manifest',
            status: manifestsAfterRecover.length > 0 ? 'passed' : 'failed',
          },
        ],
        {
          failureAttempt: {
            command: `joy-media render --project <missing-asset project>`,
            exitCode: rFail.status,
            finalEventType: failEvent?.type ?? null,
            filesWritten: manifestsAfterFail,
          },
          recoveryAttempt: {
            command: `joy-media render --project <missing-asset project> --allow-missing`,
            exitCode: rRecover.status,
            manifestsWritten: manifestsAfterRecover,
          },
        },
      ),
    );

    rows.push({
      id: 'L-038',
      command: 'joy-media render failure and recovery',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rRecover.status,
      summary: 'Missing asset fails with exit 1; recovery with --allow-missing succeeds',
      evidence: 'T-A13\\L-038.txt',
    });
  }

  // Row L-039: benchmark --system
  {
    const r = executeCli(['benchmark', '--system', '--json'], sandbox);
    let pass = r.status === 0;
    try {
      const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
      pass = pass && lines.length > 0 && lines.some((l) => l.includes('"suite":"system"'));
    } catch {
      pass = false;
    }

    recordEvidence('L-039.json', r.stdout);
    rows.push({
      id: 'L-039',
      command: 'joy-media benchmark --system',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'System benchmark runs (disk, sqlite, heap)',
      evidence: 'T-A13\\L-039.json',
    });
  }

  // Row L-040: benchmark --media-engine
  {
    const r = executeCli(['benchmark', '--media-engine', '--json'], sandbox);
    let pass = r.status === 0;
    try {
      const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
      pass = pass && lines.length > 0 && lines.some((l) => l.includes('"suite":"media-engine"'));
    } catch {
      pass = false;
    }

    recordEvidence('L-040.json', r.stdout);
    rows.push({
      id: 'L-040',
      command: 'joy-media benchmark --media-engine',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Media engine benchmark runs (scrub, collision, look)',
      evidence: 'T-A13\\L-040.json',
    });
  }

  // Row L-041: doctor
  {
    const r = executeCli(['doctor'], sandbox);
    const pass = r.status === 0;
    recordEvidence('L-041.json', r.stdout);
    rows.push({
      id: 'L-041',
      command: 'joy-media doctor',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'System doctor health check passes',
      evidence: 'T-A13\\L-041.json',
    });
  }

  // Row L-042: doctor --json
  {
    const r = executeCli(['doctor', '--json'], sandbox);
    let pass = r.status === 0;
    try {
      const parsed = JSON.parse(r.stdout);
      pass = pass && typeof parsed.ok === 'boolean' && Array.isArray(parsed.checks);
    } catch {
      pass = false;
    }

    recordEvidence('L-042.json', r.stdout);
    rows.push({
      id: 'L-042',
      command: 'joy-media doctor --json',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Health check emits { ok, summary, checks[] }',
      evidence: 'T-A13\\L-042.json',
    });
  }

  // Row L-043: doctor-local
  {
    const r = executeCli(['doctor-local'], sandbox);
    const pass = r.status === 0;
    recordEvidence('L-043.json', r.stdout);
    rows.push({
      id: 'L-043',
      command: 'joy-media doctor-local',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Explicit local checks run',
      evidence: 'T-A13\\L-043.json',
    });
  }

  // Row L-044: assets list
  {
    const r = executeCli(['assets', 'list'], sandbox);
    const pass = r.status === 0 && r.stdout.includes('asset-sample-img');
    recordEvidence('L-044.txt', r.stdout);
    rows.push({
      id: 'L-044',
      command: 'joy-media assets list',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Asset library listed',
      evidence: 'T-A13\\L-044.txt',
    });
  }

  // Row L-045: assets list --kind image
  {
    const r = executeCli(['assets', 'list', '--kind', 'image'], sandbox);
    const pass =
      r.status === 0 &&
      r.stdout.includes('asset-sample-img') &&
      !r.stdout.includes('asset-sample-audio');
    recordEvidence('L-045.txt', r.stdout);
    rows.push({
      id: 'L-045',
      command: 'joy-media assets list --kind image',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Assets filtered by kind',
      evidence: 'T-A13\\L-045.txt',
    });
  }

  // Row L-046: assets show <id>
  {
    const rGood = executeCli(['assets', 'show', 'asset-sample-img', '--json'], sandbox);
    const rBad = executeCli(['assets', 'show', 'missing-asset-id'], sandbox);
    const pass = rGood.status === 0 && rBad.status === 1;
    recordEvidence('L-046.json', rGood.stdout);
    rows.push({
      id: 'L-046',
      command: 'joy-media assets show <id>',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rGood.status,
      summary: 'Asset record printed; missing id exits 1',
      evidence: 'T-A13\\L-046.json',
    });
  }

  // Row L-047: assets path <id>
  {
    const rGood = executeCli(['assets', 'path', 'asset-sample-img'], sandbox);
    const rBad = executeCli(['assets', 'path', 'missing-asset-id'], sandbox);
    const pass = rGood.status === 0 && rGood.stdout.includes('sample.png') && rBad.status === 1;
    recordEvidence('L-047.txt', rGood.stdout);
    rows.push({
      id: 'L-047',
      command: 'joy-media assets path <id>',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: rGood.status,
      summary: 'Asset path printed on stdout; missing id exits 1',
      evidence: 'T-A13\\L-047.txt',
    });
  }

  // Row L-048: --json shape, agent family
  {
    const agentCmds = [
      [
        'agent',
        'probe',
        '--url',
        stubServer.baseUrl,
        '--api-key',
        'dummy-key',
        '--model',
        stubServer.model,
        '--json',
      ],
      ['agent', 'config', '--json'],
      ['agent', 'provider', 'list', '--json'],
      ['agent', 'slot', 'list', '--json'],
      ['agent', 'models', '--url', stubServer.baseUrl, '--api-key', 'dummy-key', '--json'],
    ];
    const jsonFamily = checkJsonFamily(agentCmds, sandbox);
    recordEvidence('L-048.json', JSON.stringify(jsonFamily.report, null, 2));
    rows.push({
      id: 'L-048',
      command: 'agent --json shape',
      status: jsonFamily.ok ? 'PASS' : 'FAIL',
      exitCode: jsonFamily.exitCode,
      summary: 'Agent subcommands accept --json and emit valid JSON documents',
      evidence: 'T-A13\\L-048.json',
    });
  }

  // Row L-049: --json shape, project family
  {
    const projCmds = [
      ['project', 'list', '--json'],
      ['project', 'show', defaultProjectId, '--json'],
      ['project', 'create', 'qa-json-check', '--json'],
    ];
    const jsonFamily = checkJsonFamily(projCmds, sandbox);
    recordEvidence('L-049.json', JSON.stringify(jsonFamily.report, null, 2));
    rows.push({
      id: 'L-049',
      command: 'project --json shape',
      status: jsonFamily.ok ? 'PASS' : 'FAIL',
      exitCode: jsonFamily.exitCode,
      summary: 'Project subcommands accept --json and emit valid JSON documents',
      evidence: 'T-A13\\L-049.json',
    });
  }

  // Row L-050: --json shape, assets family
  {
    const assetCmds = [
      ['assets', 'list', '--json'],
      ['assets', 'list', '--kind', 'image', '--json'],
      ['assets', 'show', 'asset-sample-img', '--json'],
    ];
    const jsonFamily = checkJsonFamily(assetCmds, sandbox);
    recordEvidence('L-050.json', JSON.stringify(jsonFamily.report, null, 2));
    rows.push({
      id: 'L-050',
      command: 'assets --json shape',
      status: jsonFamily.ok ? 'PASS' : 'FAIL',
      exitCode: jsonFamily.exitCode,
      summary: 'Assets subcommands accept --json and emit valid JSON documents',
      evidence: 'T-A13\\L-050.json',
    });
  }

  // Row L-051: render --json (NDJSON stream)
  {
    const r = executeCli(
      ['render', '--project', defaultProjectId, '--out', renderOutDir, '--json'],
      sandbox,
    );
    const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
    let validNdjson = lines.length > 0;
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        validNdjson = false;
      }
    }
    const pass = r.status === 0 && validNdjson;
    recordEvidence('L-051.ndjson', r.stdout);
    rows.push({
      id: 'L-051',
      command: 'joy-media render --json',
      status: pass ? 'PASS' : 'FAIL',
      exitCode: r.status,
      summary: 'Render streams valid NDJSON progress events',
      evidence: 'T-A13\\L-051.ndjson',
    });
  }

  // Teardown stub server and sandbox
  await stubServer.stop();
  sandbox.cleanup();

  // Also emit individual readiness records
  for (const record of readinessRecords) {
    try {
      if (existsSync(evidenceDir)) {
        writeFileSync(
          join(evidenceDir, `${record.id}.json`),
          JSON.stringify(record, null, 2),
          'utf8',
        );
      }
    } catch {
      // ignore
    }
  }

  // Write aggregate matrix result
  const resultJson = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    totalRows: rows.length,
    passedCount: rows.filter((r) => r.status === 'PASS').length,
    defectCount: rows.filter((r) => r.status === 'DEFECT').length,
    notTestedCount: rows.filter((r) => r.status === 'NOT-TESTED').length,
    failedCount: rows.filter((r) => r.status === 'FAIL').length,
    readinessRecords,
    matrix: rows,
  };

  const cliMatrixText = JSON.stringify(resultJson, null, 2);
  recordEvidence('cli-matrix.json', cliMatrixText);

  // Print Table Output
  printMatrixTable(rows, resultJson);

  return resultJson;
}

function printMatrixTable(rows, summary) {
  console.log(
    '\n========================================================================================',
  );
  console.log(
    '                          JOY MEDIA CLI TEST MATRIX (T-A13)                             ',
  );
  console.log(
    '========================================================================================',
  );
  console.log(
    'ID    | Status | Exit | Command                                      | Notes / Defect Reason',
  );
  console.log(
    '----------------------------------------------------------------------------------------',
  );

  for (const row of rows) {
    const statusCol =
      row.status === 'PASS'
        ? '\x1b[32mPASS  \x1b[0m'
        : row.status === 'DEFECT'
          ? '\x1b[33mDEFECT\x1b[0m'
          : row.status === 'NOT-TESTED'
            ? '\x1b[36mNOTEST\x1b[0m'
            : '\x1b[31mFAIL  \x1b[0m';
    const id = row.id.padEnd(5);
    const exitStr = String(row.exitCode ?? '-').padStart(4);
    const cmd = row.command.slice(0, 44).padEnd(44);
    const note = row.defectReason
      ? `[DEFECT] ${row.defectReason}`
      : row.note
        ? `${row.summary} [${row.note}]`
        : row.summary;
    console.log(`${id} | ${statusCol} | ${exitStr} | ${cmd} | ${note}`);
  }

  console.log(
    '----------------------------------------------------------------------------------------',
  );
  console.log(
    `Summary: Total: ${summary.totalRows} | Passed: ${summary.passedCount} | Defects: ${summary.defectCount} | Not tested: ${summary.notTestedCount} | Failed: ${summary.failedCount}`,
  );
  console.log('Readiness records emitted:');
  for (const rec of summary.readinessRecords) {
    console.log(`  ${rec.status === 'passed' ? 'ok ' : '-- '} ${rec.id} (${rec.status})`);
  }
  console.log(
    '========================================================================================\n',
  );
}

// CLI entry point
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCliMatrix()
    .then((summary) => {
      if (summary.failedCount > 0) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error('Fatal CLI matrix error:', err);
      process.exitCode = 1;
    });
}
