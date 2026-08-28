import {
  ProjectDocumentJournalError,
  type ProjectDocumentBrowserJournalStorage,
} from './project-document-browser-journal.js';

const DEFAULT_DATABASE_NAME = 'joy-media.project-documents.v1';
const DEFAULT_OBJECT_STORE_NAME = 'journals';
const DEFAULT_OPFS_FILE_NAME = 'project-document-journals.v1.json';

/** Narrow IndexedDB surface used by the adapter and by DOM-independent tests. */
export interface IndexedDbRequestLike<T> {
  result: T;
  error?: unknown;
  onsuccess: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export interface IndexedDbObjectStoreLike {
  get(key: string): IndexedDbRequestLike<unknown>;
  put(value: string, key: string): IndexedDbRequestLike<unknown>;
}

export interface IndexedDbTransactionLike {
  objectStore(name: string): IndexedDbObjectStoreLike;
  oncomplete: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onabort: ((event?: unknown) => void) | null;
}

export interface IndexedDbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: 'readonly' | 'readwrite'): IndexedDbTransactionLike;
}

export interface IndexedDbOpenRequestLike extends IndexedDbRequestLike<IndexedDbDatabaseLike> {
  onupgradeneeded: ((event?: unknown) => void) | null;
}

export interface IndexedDbFactoryLike {
  open(name: string, version: number): IndexedDbOpenRequestLike;
}

export interface IndexedDbJournalStorageOptions {
  readonly databaseName?: string;
  readonly objectStoreName?: string;
  /** Omit in production to use globalThis.indexedDB; inject in tests or workers. */
  readonly indexedDB?: IndexedDbFactoryLike;
}

/**
 * IndexedDB-backed key/value storage for ProjectDocumentBrowserJournal.
 *
 * The adapter reports unavailable/open/read/write failures explicitly. It has
 * no localStorage or network fallback, so the caller can disable offline mode
 * or show a recovery action when browser persistence is unavailable.
 */
export class IndexedDbProjectDocumentJournalStorage implements ProjectDocumentBrowserJournalStorage {
  readonly #factory: IndexedDbFactoryLike | undefined;
  readonly #databaseName: string;
  readonly #objectStoreName: string;
  #databasePromise: Promise<IndexedDbDatabaseLike> | undefined;

  constructor(options: IndexedDbJournalStorageOptions = {}) {
    this.#factory = options.indexedDB ?? globalIndexedDbFactory();
    this.#databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    this.#objectStoreName = options.objectStoreName ?? DEFAULT_OBJECT_STORE_NAME;
    if (this.#databaseName.length === 0 || this.#objectStoreName.length === 0) {
      throw new RangeError('IndexedDB database and object store names must not be empty');
    }
  }

  static isSupported(factory?: IndexedDbFactoryLike): boolean {
    return (factory ?? globalIndexedDbFactory()) !== undefined;
  }

  async getItem(key: string): Promise<string | null> {
    const database = await this.#open();
    try {
      const transaction = database.transaction(this.#objectStoreName, 'readonly');
      const result = await requestResult(transaction.objectStore(this.#objectStoreName).get(key));
      if (result === undefined) return null;
      if (typeof result !== 'string') {
        throw new Error('IndexedDB journal value is not serialized text');
      }
      return result;
    } catch (error) {
      if (error instanceof ProjectDocumentJournalError) throw error;
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_READ_FAILED',
        'IndexedDB journal read failed',
        { cause: error },
      );
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    const database = await this.#open();
    try {
      const transaction = database.transaction(this.#objectStoreName, 'readwrite');
      await requestResult(transaction.objectStore(this.#objectStoreName).put(value, key));
      await transactionComplete(transaction);
    } catch (error) {
      if (error instanceof ProjectDocumentJournalError) throw error;
      throw new ProjectDocumentJournalError(
        isQuotaError(error) ? 'JOURNAL_QUOTA_EXCEEDED' : 'JOURNAL_STORAGE_WRITE_FAILED',
        isQuotaError(error)
          ? 'IndexedDB journal quota was exceeded'
          : 'IndexedDB journal write failed',
        { cause: error },
      );
    }
  }

  async #open(): Promise<IndexedDbDatabaseLike> {
    if (this.#databasePromise !== undefined) return this.#databasePromise;
    if (this.#factory === undefined) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_UNAVAILABLE',
        'IndexedDB is unavailable in this browser context',
      );
    }
    this.#databasePromise = new Promise<IndexedDbDatabaseLike>((resolve, reject) => {
      let request: IndexedDbOpenRequestLike;
      try {
        request = this.#factory!.open(this.#databaseName, 1);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        try {
          if (!request.result.objectStoreNames.contains(this.#objectStoreName)) {
            request.result.createObjectStore(this.#objectStoreName);
          }
        } catch (error) {
          reject(error);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    }).catch((error: unknown) => {
      this.#databasePromise = undefined;
      if (error instanceof ProjectDocumentJournalError) throw error;
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_UNAVAILABLE',
        'IndexedDB journal could not be opened',
        { cause: error },
      );
    });
    return this.#databasePromise;
  }
}

/** Minimal OPFS surface, kept injectable so tests do not need a DOM. */
export interface OpfsFileLike {
  text(): Promise<string>;
}

export interface OpfsWritableLike {
  write(value: string): Promise<void>;
  close(): Promise<void>;
  abort?: () => Promise<void>;
}

export interface OpfsFileHandleLike {
  getFile(): Promise<OpfsFileLike>;
  createWritable(): Promise<OpfsWritableLike>;
}

export interface OpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
}

export interface OpfsJournalStorageOptions {
  readonly fileName?: string;
  /** Inject in tests or supply a worker-owned OPFS directory. */
  readonly directory?: OpfsDirectoryLike;
  readonly getDirectory?: () => Promise<OpfsDirectoryLike>;
}

/** OPFS-backed storage seam with explicit availability and no fallback. */
export class OpfsProjectDocumentJournalStorage implements ProjectDocumentBrowserJournalStorage {
  readonly #fileName: string;
  readonly #directoryFactory: (() => Promise<OpfsDirectoryLike>) | undefined;
  #directoryPromise: Promise<OpfsDirectoryLike> | undefined;

  constructor(options: OpfsJournalStorageOptions = {}) {
    this.#fileName = options.fileName ?? DEFAULT_OPFS_FILE_NAME;
    this.#directoryFactory =
      options.getDirectory ??
      (options.directory === undefined
        ? globalOpfsDirectoryFactory()
        : async () => options.directory!);
    if (this.#fileName.length === 0) throw new RangeError('OPFS file name must not be empty');
  }

  static isSupported(directory?: OpfsDirectoryLike): boolean {
    return directory !== undefined || globalOpfsDirectoryFactory() !== undefined;
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const file = await (
        await this.#directory()
      )
        .getFileHandle(this.#fileNameForKey(key))
        .then((handle) => handle.getFile());
      return await file.text();
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof ProjectDocumentJournalError) throw error;
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_READ_FAILED',
        'OPFS journal read failed',
        { cause: error },
      );
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      const handle = await (
        await this.#directory()
      ).getFileHandle(this.#fileNameForKey(key), { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(value);
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof ProjectDocumentJournalError) throw error;
      throw new ProjectDocumentJournalError(
        isQuotaError(error) ? 'JOURNAL_QUOTA_EXCEEDED' : 'JOURNAL_STORAGE_WRITE_FAILED',
        isQuotaError(error) ? 'OPFS journal quota was exceeded' : 'OPFS journal write failed',
        { cause: error },
      );
    }
  }

  async #directory(): Promise<OpfsDirectoryLike> {
    if (this.#directoryPromise !== undefined) return this.#directoryPromise;
    if (this.#directoryFactory === undefined) {
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_UNAVAILABLE',
        'OPFS is unavailable in this browser context',
      );
    }
    this.#directoryPromise = this.#directoryFactory().catch((error: unknown) => {
      this.#directoryPromise = undefined;
      throw new ProjectDocumentJournalError(
        'JOURNAL_STORAGE_UNAVAILABLE',
        'OPFS journal directory could not be opened',
        { cause: error },
      );
    });
    return this.#directoryPromise;
  }

  #fileNameForKey(key: string): string {
    return `${this.#fileName}-${encodeURIComponent(key)}`;
  }
}

export type ProjectDocumentBrowserStorageKind = 'indexeddb' | 'opfs';

export interface CreateProjectDocumentBrowserStorageOptions {
  /** Backend selection is mandatory: no implicit localStorage/cloud fallback exists. */
  readonly kind: ProjectDocumentBrowserStorageKind;
  readonly indexedDb?: IndexedDbJournalStorageOptions;
  readonly opfs?: OpfsJournalStorageOptions;
}

/** Explicit backend factory for App wiring; availability failures remain typed. */
export function createProjectDocumentBrowserStorage(
  options: CreateProjectDocumentBrowserStorageOptions,
): ProjectDocumentBrowserJournalStorage {
  return options.kind === 'indexeddb'
    ? new IndexedDbProjectDocumentJournalStorage(options.indexedDb)
    : new OpfsProjectDocumentJournalStorage(options.opfs);
}

function requestResult<T>(request: IndexedDbRequestLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IndexedDbTransactionLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = (event) => reject(event ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = (event) => reject(event ?? new Error('IndexedDB transaction aborted'));
  });
}

function globalIndexedDbFactory(): IndexedDbFactoryLike | undefined {
  const candidate = (globalThis as { indexedDB?: unknown }).indexedDB;
  return candidate === undefined ? undefined : (candidate as IndexedDbFactoryLike);
}

function globalOpfsDirectoryFactory(): (() => Promise<OpfsDirectoryLike>) | undefined {
  const navigatorLike = (
    globalThis as {
      navigator?: { storage?: { getDirectory?: () => Promise<OpfsDirectoryLike> } };
    }
  ).navigator;
  const getDirectory = navigatorLike?.storage?.getDirectory;
  return getDirectory === undefined ? undefined : () => getDirectory.call(navigatorLike!.storage);
}

function isQuotaError(value: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      value instanceof DOMException &&
      value.name === 'QuotaExceededError') ||
    (isRecord(value) && (value.name === 'QuotaExceededError' || value.code === 'QUOTA_ERR'))
  );
}

function isNotFoundError(value: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      value instanceof DOMException &&
      value.name === 'NotFoundError') ||
    (isRecord(value) && value.name === 'NotFoundError')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
