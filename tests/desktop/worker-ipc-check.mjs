/**
 * JOY Media Desktop Worker IPC & LocalDatabase Lifecycle Verification Helper
 *
 * Verifies:
 * 1. Worker Entry Resolution (apps/worker/dist/index.js & apps/worker/bin/joy-worker.exe)
 * 2. Worker Status & Supervisor Lifecycle via desktop IPC channels
 * 3. Derivative Job Enqueue via desktop IPC channel
 * 4. LocalDatabase Job Progress Events (queued -> running -> done) via desktop IPC channel
 * 5. Job Cancellation via desktop IPC channel
 * 6. Origin Policy & IPC Channel Allow-list Enforcement
 */

import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve('.');
const desktopDist = resolve(repoRoot, 'apps/desktop/dist');

// Dynamically import compiled desktop modules
const ipcHandlersModule = await import(
  pathToFileURL(resolve(desktopDist, 'main/ipc-handlers.js')).href
);
const workerSupervisorModule = await import(
  pathToFileURL(resolve(desktopDist, 'main/worker-supervisor.js')).href
);
const workerEntryModule = await import(
  pathToFileURL(resolve(desktopDist, 'main/worker-entry.js')).href
);
const fileRegistryModule = await import(
  pathToFileURL(resolve(desktopDist, 'main/file-registry.js')).href
);
const localDbModule = await import(
  pathToFileURL(resolve(desktopDist, 'store/local-database.js')).href
);
const ipcChannelsModule = await import(
  pathToFileURL(resolve(desktopDist, 'preload/ipc-channels.cjs')).href
);

const { createIpcHandlers, dispatchIpcRequest } = ipcHandlersModule;
const { createWorkerSupervisor } = workerSupervisorModule;
const { resolveWorkerEntry } = workerEntryModule;
const { createFileRegistry } = fileRegistryModule;
const { LocalDatabase } = localDbModule;
const { IPC_CHANNELS: _IPC_CHANNELS } = ipcChannelsModule;

console.log('=== JOY Media Desktop Worker IPC & LocalDatabase Verification ===\n');

const tempDir = mkdtempSync(join(tmpdir(), 'joy-worker-ipc-check-'));
const testDbPath = join(tempDir, 'test-desktop.sqlite3');

let allChecksPassed = true;
function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    allChecksPassed = false;
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  PASS: ${message}`);
}

try {
  // --------------------------------------------------------------------------
  // Check 1: Worker Entry Point Resolution
  // --------------------------------------------------------------------------
  console.log('1. Verifying Worker Entry Point Resolution...');
  const mainDirname = resolve(desktopDist, 'main');
  const liveEntry = resolveWorkerEntry({
    mainDirname,
    execPath: process.execPath,
  });

  assert(
    typeof liveEntry.command === 'string' && liveEntry.command.length > 0,
    `Live worker entry command resolved: ${liveEntry.command}`,
  );
  assert(
    Array.isArray(liveEntry.args),
    `Live worker entry args resolved: [${liveEntry.args.join(', ')}]`,
  );

  const resolvedTarget = liveEntry.args[0] ?? liveEntry.command;
  const isDistOrExe =
    resolvedTarget.includes('dist\\index.js') ||
    resolvedTarget.includes('dist/index.js') ||
    resolvedTarget.includes('joy-worker.exe');
  assert(
    isDistOrExe,
    `Resolved target points to compiled worker (dist/index.js) or binary (joy-worker.exe): ${resolvedTarget}`,
  );

  // Test resolution logic for joy-worker.exe in repo layout
  const dummyWorkerRoot = join('C:', 'repo', 'apps', 'worker');
  const dummyMainDir = join('C:', 'repo', 'apps', 'desktop', 'dist', 'main');
  const dummyExe = join(dummyWorkerRoot, 'bin', 'joy-worker.exe');
  const exeResolution = resolveWorkerEntry({
    mainDirname: dummyMainDir,
    execPath: 'C:\\node\\node.exe',
    fileExists: (p) => p === dummyExe,
  });
  assert(
    exeResolution.command === dummyExe && exeResolution.args.length === 0,
    `Correctly resolves standalone joy-worker.exe when dist/index.js is absent: ${dummyExe}`,
  );

  // Test resolution logic for packaged joy-worker.exe
  const packagedExe = join(dummyMainDir, '..', '..', 'worker', 'joy-worker.exe');
  const packagedExeResolution = resolveWorkerEntry({
    mainDirname: dummyMainDir,
    execPath: 'C:\\node\\node.exe',
    fileExists: (p) => p === packagedExe,
  });
  assert(
    packagedExeResolution.command === packagedExe && packagedExeResolution.args.length === 0,
    `Correctly resolves packaged standalone joy-worker.exe: ${packagedExe}`,
  );

  // --------------------------------------------------------------------------
  // Check 2: Setup IPC Substrate with WorkerSupervisor & LocalDatabase
  // --------------------------------------------------------------------------
  console.log('\n2. Initializing IPC Substrate, WorkerSupervisor & LocalDatabase...');
  const localDb = new LocalDatabase({ filePath: testDbPath });
  const fileRegistry = createFileRegistry();

  let childSpawned = false;
  let _childKilled = false;
  const fakeChild = {
    once: (_event, _listener) => {
      // simulate healthy long-running process
    },
    kill: (_signal) => {
      _childKilled = true;
      return true;
    },
  };

  const supervisor = createWorkerSupervisor({
    spawn: (_cmd, _args, _opts) => {
      childSpawned = true;
      return fakeChild;
    },
    command: liveEntry.command,
    args: liveEntry.args,
    workerId: () => 'test-worker-uuid-42',
  });

  const fakeSecretStore = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  };

  const handlers = createIpcHandlers({
    fileRegistry,
    workerSupervisor: supervisor,
    localDatabase: localDb,
    probeMedia: async (_path) => ({
      checksum: 'sha256-mock-video-checksum',
      byteSize: 1048576,
      kind: 'video',
    }),
    showOpenDialog: async () => ({
      canceled: false,
      path: resolve(repoRoot, 'packages/test-fixtures/media/image.png'),
    }),
    secretStore: fakeSecretStore,
    probeProvider: async () => ({ ok: true }),
    checkForUpdate: () => ({ status: 'current', reason: 'not-newer' }),
  });

  const ALLOWED_ORIGIN = 'http://localhost:5173';
  async function invokeIpc(channel, payload) {
    const request = { origin: ALLOWED_ORIGIN, channel, payload };
    const response = await dispatchIpcRequest(handlers, request);
    return response;
  }

  // --------------------------------------------------------------------------
  // Check 3: Worker Status & Lifecycle via desktop IPC Channel
  // --------------------------------------------------------------------------
  console.log('\n3. Verifying Worker Status & Lifecycle over desktop IPC Channel...');
  // Initial status before start
  const initialStatusResp = await invokeIpc('desktop.worker-status');
  assert(initialStatusResp.ok === true, 'desktop.worker-status responded with ok: true');
  assert(
    initialStatusResp.data.connection === 'unknown',
    `Initial connection state is 'unknown': ${initialStatusResp.data.connection}`,
  );

  // Send startup preference to trigger worker launch
  const prefResp = await invokeIpc('desktop.startup-preference', 'start-worker');
  assert(
    prefResp.ok === true && prefResp.data === 'start-worker',
    'desktop.startup-preference accepted start-worker',
  );
  assert(childSpawned === true, 'WorkerSupervisor successfully spawned child worker process');

  // Verify status updated to online
  const onlineStatusResp = await invokeIpc('desktop.worker-status');
  assert(onlineStatusResp.ok === true, 'desktop.worker-status returned ok: true after startup');
  assert(
    onlineStatusResp.data.connection === 'online',
    `Worker status connection transitioned to 'online': ${onlineStatusResp.data.connection}`,
  );
  assert(
    onlineStatusResp.data.workerId === 'test-worker-uuid-42',
    `Worker status includes assigned workerId: ${onlineStatusResp.data.workerId}`,
  );
  assert(
    typeof onlineStatusResp.data.lastSeenAt === 'string',
    `Worker status records lastSeenAt timestamp: ${onlineStatusResp.data.lastSeenAt}`,
  );

  // --------------------------------------------------------------------------
  // Check 4: Media Selection & Derivative Job Enqueue via desktop IPC Channel
  // --------------------------------------------------------------------------
  console.log('\n4. Verifying Media Selection & Job Enqueue over desktop IPC Channel...');
  const selectFileResp = await invokeIpc('desktop.select-file');
  assert(
    selectFileResp.ok === true && selectFileResp.data?.id,
    'desktop.select-file registered file reference',
  );
  const fileRef = selectFileResp.data;

  // Enqueue thumbnail derivative job
  const enqueueResp = await invokeIpc('desktop.request-derivative', {
    ref: fileRef,
    kind: 'thumbnail',
  });
  assert(enqueueResp.ok === true, 'desktop.request-derivative responded with ok: true');
  assert(
    typeof enqueueResp.data?.jobId === 'string',
    `Job enqueued with jobId: ${enqueueResp.data?.jobId}`,
  );
  assert(
    enqueueResp.data?.refId === fileRef.id,
    `Approval returned matching refId: ${enqueueResp.data?.refId}`,
  );
  assert(
    enqueueResp.data?.kind === 'thumbnail',
    `Approval returned matching kind: ${enqueueResp.data?.kind}`,
  );
  const thumbnailJobId = enqueueResp.data.jobId;

  // Verify initial queued state in LocalDatabase via desktop.job-status
  const initialJobStatus = await invokeIpc('desktop.job-status', { jobId: thumbnailJobId });
  assert(initialJobStatus.ok === true, 'desktop.job-status retrieved job');
  assert(
    initialJobStatus.data?.status === 'queued',
    `Initial job status in LocalDatabase is 'queued': ${initialJobStatus.data?.status}`,
  );
  assert(
    initialJobStatus.data?.kind === 'derivative:thumbnail',
    `Job kind recorded accurately: ${initialJobStatus.data?.kind}`,
  );
  assert(
    initialJobStatus.data?.refId === fileRef.id,
    `Job refId matches source media ref: ${initialJobStatus.data?.refId}`,
  );

  // --------------------------------------------------------------------------
  // Check 5: LocalDatabase Progress Transitions via desktop IPC Channel
  // --------------------------------------------------------------------------
  console.log('\n5. Verifying LocalDatabase Progress Events via desktop IPC Channel...');
  // Transition 1: queued -> running
  localDb.updateJobStatus(thumbnailJobId, 'running');
  const runningJobStatus = await invokeIpc('desktop.job-status', { jobId: thumbnailJobId });
  assert(
    runningJobStatus.data?.status === 'running',
    `Progress event: job status transitioned to 'running': ${runningJobStatus.data?.status}`,
  );

  // Transition 2: running -> done
  localDb.updateJobStatus(thumbnailJobId, 'done');
  const doneJobStatus = await invokeIpc('desktop.job-status', { jobId: thumbnailJobId });
  assert(
    doneJobStatus.data?.status === 'done',
    `Progress event: job status transitioned to 'done': ${doneJobStatus.data?.status}`,
  );

  // --------------------------------------------------------------------------
  // Check 6: Job Cancellation via desktop IPC Channel
  // --------------------------------------------------------------------------
  console.log('\n6. Verifying Job Cancellation over desktop IPC Channel...');
  // Enqueue a proxy derivative job
  const enqueueProxyResp = await invokeIpc('desktop.request-derivative', {
    ref: fileRef,
    kind: 'proxy',
  });
  const proxyJobId = enqueueProxyResp.data.jobId;

  // Cancel the queued job via IPC
  const cancelResp = await invokeIpc('desktop.cancel-job', { jobId: proxyJobId });
  assert(cancelResp.ok === true, 'desktop.cancel-job responded with ok: true');
  assert(
    cancelResp.data?.status === 'cancelled',
    `Job status updated to 'cancelled': ${cancelResp.data?.status}`,
  );
  assert(
    cancelResp.data?.error === 'cancelled by user',
    `Job cancellation error set: ${cancelResp.data?.error}`,
  );

  // Query status again to verify persistence
  const queriedCancelled = await invokeIpc('desktop.job-status', { jobId: proxyJobId });
  assert(queriedCancelled.data?.status === 'cancelled', 'LocalDatabase persists cancelled state');

  // Verify that cancelling an already-finished job fails gracefully
  const cancelDoneResp = await invokeIpc('desktop.cancel-job', { jobId: thumbnailJobId });
  assert(
    cancelDoneResp.ok === false &&
      cancelDoneResp.error?.includes('Cannot cancel a job in status "done"'),
    `Cancelling finished job is rejected: ${cancelDoneResp.error}`,
  );

  // --------------------------------------------------------------------------
  // Check 7: Security Policy & Channel Allow-List Enforcement
  // --------------------------------------------------------------------------
  console.log('\n7. Verifying Origin Policy & Disallowed Channel Enforcement...');
  const blockedOriginResp = await dispatchIpcRequest(handlers, {
    origin: 'https://unauthorized-site.com',
    channel: 'desktop.worker-status',
  });
  assert(
    blockedOriginResp.ok === false && blockedOriginResp.error?.includes('Blocked IPC request'),
    `Disallowed origin blocked before reaching handler: ${blockedOriginResp.error}`,
  );

  const blockedChannelResp = await dispatchIpcRequest(handlers, {
    origin: ALLOWED_ORIGIN,
    channel: 'desktop.unauthorized-channel',
  });
  assert(
    blockedChannelResp.ok === false && blockedChannelResp.error?.includes('Blocked IPC request'),
    `Disallowed channel blocked before reaching handler: ${blockedChannelResp.error}`,
  );

  localDb.close();
  supervisor.stop();
  console.log('\n=== All Desktop Worker IPC & LocalDatabase Checks PASSED ===');
} catch (err) {
  console.error('\nFatal check failure:', err);
  allChecksPassed = false;
} finally {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup
  }
}

process.exit(allChecksPassed ? 0 : 1);
