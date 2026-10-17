/* global process, setInterval */
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const databasePath = process.argv[2];
const markerPath = process.argv[3];
if (databasePath === undefined || markerPath === undefined) {
  process.stderr.write('usage: sqlite-lock-holder.mjs <database-path> <marker-path>\n');
  process.exit(2);
}

const database = new DatabaseSync(databasePath);
database.exec('PRAGMA journal_mode = WAL');
database.exec('BEGIN IMMEDIATE');
writeFileSync(markerPath, JSON.stringify({ pid: process.pid, locked: true }));
setInterval(() => undefined, 1_000);
