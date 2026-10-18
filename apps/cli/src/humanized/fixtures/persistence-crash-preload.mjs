/* global process */
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const mode = process.env['JOY_MEDIA_TEST_CRASH_BOUNDARY'];
const markerPath = process.env['JOY_MEDIA_TEST_CRASH_MARKER'];

function pauseAtBoundary() {
  if (markerPath === undefined) return;
  fs.writeFileSync(markerPath, JSON.stringify({ mode, pid: process.pid }));
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(sleep, 0, 0, 1_000);
}

if (mode === 'before-sqlite-commit' || mode === 'sqlite-full-commit') {
  const { DatabaseSync } = await import('node:sqlite');
  const originalExec = DatabaseSync.prototype.exec;
  let fullInjected = false;
  DatabaseSync.prototype.exec = function exec(sql) {
    if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') {
      if (mode === 'before-sqlite-commit') pauseAtBoundary();
      if (mode === 'sqlite-full-commit' && !fullInjected) {
        fullInjected = true;
        const error = new Error('database or disk is full');
        error.code = 'SQLITE_FULL';
        fs.writeFileSync(markerPath, JSON.stringify({ mode, pid: process.pid }));
        throw error;
      }
    }
    return originalExec.call(this, sql);
  };
}

if (mode === 'before-file-rename') {
  const targetPath = process.env['JOY_MEDIA_TEST_RENAME_TARGET'];
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function renameSync(source, destination) {
    if (
      typeof targetPath === 'string' &&
      path.resolve(String(destination)) === path.resolve(targetPath)
    ) {
      pauseAtBoundary();
    }
    return originalRenameSync.call(this, source, destination);
  };
  syncBuiltinESMExports();
}

if (mode === 'file-rename-eperm-once') {
  const targetPath = process.env['JOY_MEDIA_TEST_RENAME_TARGET'];
  const originalRenameSync = fs.renameSync;
  let injected = false;
  fs.renameSync = function renameSync(source, destination) {
    if (
      !injected &&
      typeof targetPath === 'string' &&
      path.resolve(String(destination)) === path.resolve(targetPath)
    ) {
      injected = true;
      fs.writeFileSync(markerPath, JSON.stringify({ mode, pid: process.pid }));
      const error = new Error('injected transient Windows sharing violation');
      error.code = 'EPERM';
      throw error;
    }
    return originalRenameSync.call(this, source, destination);
  };
  syncBuiltinESMExports();
}
