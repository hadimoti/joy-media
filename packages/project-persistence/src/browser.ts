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
export {
  createEditorProjectStorageAdapter,
  EDITOR_PROJECT_STORAGE_KEYS,
  EDITOR_PROJECT_STORAGE_PREFIXES,
  isEditorProjectStorageKey,
  MAX_EDITOR_PROJECT_STORAGE_KEY_LENGTH,
  MAX_EDITOR_PROJECT_STORAGE_VALUE_BYTES,
} from './editor-storage.js';
export type { SynchronousEditorStorage } from './editor-storage.js';
