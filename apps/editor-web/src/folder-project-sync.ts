import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import {
  CREATIVE_ARTIFACT_LOG_KEY,
  LOOK_INSTANCES_LOG_KEY,
  WORKFLOW_GRAPH_LOG_KEY,
} from './editor-session.js';
import {
  PROJECT_CATALOG_KEY,
  TIMELINE_LOG_KEY,
  VISUAL_LOG_KEY,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import {
  clearFolderProjectUnsaved,
  markFolderProjectUnsaved,
  saveFolderProject,
  type FolderProjectPort,
  type FolderProjectSaveResult,
} from './folder-project.js';
import { folderNotStoredText, folderSaveFailedText } from './project-folder-messages.js';

/**
 * Keeps an open folder project saved. The editor writes every change to this browser's working copy first, as it does
 * for every project. This watches the working copy, marks it unsaved the moment it changes (so a reopen keeps it), and
 * saves it into the folder. Saves run one at a time.
 *
 * `check` is cheap and synchronous, so it can run on a timer and when the window closes. `flush` saves if anything
 * changed. `close` saves a last time and lets the folder go.
 */

/** The browser storage keys that hold a project's documents and its title. */
const WATCHED_KEYS = [
  TIMELINE_LOG_KEY,
  VISUAL_LOG_KEY,
  WORKFLOW_GRAPH_LOG_KEY,
  CREATIVE_ARTIFACT_LOG_KEY,
  LOOK_INSTANCES_LOG_KEY,
  PROJECT_CATALOG_KEY,
] as const;

/** Refusals after which another save cannot work until the folder is opened again. */
const FINAL_REFUSALS = new Set(['not-open', 'save-conflict', 'wrong-project']);

export interface FolderProjectSyncOptions {
  readonly key: string;
  readonly entry: ProjectCatalogEntry;
  readonly storage: BrowserKeyValueStore;
  readonly port: FolderProjectPort & { close(key: string): Promise<void> };
  /** The folder's saved revision the working copy is based on. */
  readonly revisionId: string;
  /** True when the working copy is not in the folder yet. */
  readonly needsSave: boolean;
  /** Words for the owner: a save that lost media, or a save that failed. Each text is said once in a row. */
  readonly onNotice?: (text: string, kind: 'info' | 'error') => void;
  readonly newRevisionId?: () => string;
}

export class FolderProjectSync {
  readonly key: string;
  readonly projectId: string;
  #options: FolderProjectSyncOptions;
  #revisionId: string;
  #snapshot: string;
  #dirty: boolean;
  #stopped = false;
  #running: Promise<FolderProjectSaveResult | undefined> | undefined;
  #lastNotice: string | undefined;

  constructor(options: FolderProjectSyncOptions) {
    this.#options = options;
    this.key = options.key;
    this.projectId = options.entry.id;
    this.#revisionId = options.revisionId;
    this.#snapshot = this.#read();
    this.#dirty = options.needsSave;
    if (this.#dirty) markFolderProjectUnsaved(options.storage, this.projectId);
  }

  /** The folder's saved revision as this editor last saw it. */
  get revisionId(): string {
    return this.#revisionId;
  }

  /** Whether the working copy has changes the folder has not received. Marks them at once, so a reopen keeps them. */
  check(): boolean {
    if (this.#stopped) return false;
    const now = this.#read();
    if (now !== this.#snapshot) {
      this.#snapshot = now;
      if (!this.#dirty) markFolderProjectUnsaved(this.#options.storage, this.projectId);
      this.#dirty = true;
    }
    return this.#dirty;
  }

  /** Saves the working copy into the folder if it changed. Waits for a save that is already running. */
  async flush(): Promise<FolderProjectSaveResult | undefined> {
    while (this.#running !== undefined) await this.#running;
    if (!this.check()) return undefined;
    const running = this.#save();
    this.#running = running;
    try {
      return await running;
    } finally {
      this.#running = undefined;
    }
  }

  /** Saves a last time, then closes the folder. The working copy keeps its unsaved mark if that save failed. */
  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.#stopped = true;
      await this.#options.port.close(this.key).catch(() => undefined);
    }
  }

  async #save(): Promise<FolderProjectSaveResult | undefined> {
    const { storage, port, entry } = this.#options;
    const started = this.#snapshot;
    const revisionId = (this.#options.newRevisionId ?? defaultRevisionId)();
    let result: FolderProjectSaveResult;
    try {
      result = await saveFolderProject({
        key: this.key,
        storage,
        port,
        entry,
        baseRevisionId: this.#revisionId,
        revisionId,
      });
    } catch {
      this.#notice(folderSaveFailedText(undefined), 'error');
      return undefined;
    }
    if (result.kind === 'refused') {
      if (FINAL_REFUSALS.has(result.code)) this.#stopped = true;
      this.#notice(folderSaveFailedText(result.code), 'error');
      return result;
    }
    this.#revisionId = result.revisionId;
    // A change made while the save ran is not in the folder yet: it stays marked, and the next flush sends it.
    if (this.#read() === started) {
      this.#dirty = false;
      clearFolderProjectUnsaved(storage, this.projectId);
    }
    const lost = folderNotStoredText(result.notStored);
    if (lost !== undefined) this.#notice(lost, 'info');
    else this.#lastNotice = undefined;
    return result;
  }

  #notice(text: string, kind: 'info' | 'error'): void {
    if (text === this.#lastNotice) return;
    this.#lastNotice = text;
    this.#options.onNotice?.(text, kind);
  }

  #read(): string {
    const { storage } = this.#options;
    // The unsaved mark is written with removeItem/setItem on its own key, so it is not part of this snapshot.
    return WATCHED_KEYS.map((key) => storage.getItem(key) ?? '').join('\u0000');
  }
}

function defaultRevisionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `folder-rev-${crypto.randomUUID()}`;
  }
  return `folder-rev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
