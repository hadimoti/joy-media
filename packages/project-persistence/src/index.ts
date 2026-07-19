/** @joy-media/project-persistence — local snapshots, logs, recovery, and locks (WP-01.2). */
export type {
  AutosaveState,
  PersistenceAdapter,
  RecoveryResult,
  ProjectStore,
  StoredSnapshot,
  StoredTransaction,
} from './persistence.js';
export {
  PersistenceError,
  InMemoryProjectStore,
  LocalProjectPersistence,
  ProjectLockManager,
} from './persistence.js';
export { JsonFileProjectStore } from './desktop-store.js';
