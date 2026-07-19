/** Browser-safe persistence entry point. Desktop filesystem adapters are excluded. */

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
export type { BrowserKeyValueStore } from './browser-store.js';
export { BrowserProjectStore } from './browser-store.js';
