/**
 * The messages between the desktop main process and the project-folder worker (project-folder-worker.ts), and the
 * plain replies the renderer receives through `desktop.project-folder.*`.
 *
 * Every reply is data. A folder is named by an opaque key from the last listing, never by a path the renderer sends,
 * so the renderer can only act on folders the desktop itself listed in the default folder. A refusal carries a code,
 * never the store's error text: the editor turns the code into words.
 */

export const PROJECT_FOLDER_OPS = [
  'list',
  'create',
  'open',
  'answer',
  'restore',
  'shutdown',
] as const;
export type ProjectFolderOp = (typeof PROJECT_FOLDER_OPS)[number];

/** The ops the renderer may reach through IPC. `shutdown` is only sent by the main process. */
export type ProjectFolderRequestOp = Exclude<ProjectFolderOp, 'shutdown'>;

/** The port the IPC handlers use to reach the worker. The client (project-folder-client.ts) implements it. */
export interface ProjectFolderRequestPort {
  request(op: ProjectFolderRequestOp, payload: unknown): Promise<unknown>;
}

export interface ProjectFolderRequestMessage {
  readonly id: number;
  readonly op: ProjectFolderOp;
  readonly payload: unknown;
}

export type ProjectFolderWorkerReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** Why a folder operation was refused. The editor writes the words for each code. */
export const PROJECT_FOLDER_REFUSALS = [
  'no-title',
  'name-taken',
  'unknown-folder',
  'not-a-folder',
  'no-entry',
  'missing-folder',
  'unreadable-identity',
  'unreadable-place',
  'unverified-volume',
  'no-folder-identity',
  'damaged',
  'busy',
  'restart',
  'other-id-held',
  'id-recorded-elsewhere',
  'folder-recorded-under-other-id',
  'id-held-unrecorded',
  'id-in-use',
  'has-entry',
  'has-documents',
  'no-record-here',
  'recorded-original-in-place',
  'recorded-original-itself',
  'identity-changed-at-place',
  'failed',
  // The change is settled, but the reply could not be built. The owner checks the folder again.
  'settled-not-shown',
] as const;
export type ProjectFolderRefusal = (typeof PROJECT_FOLDER_REFUSALS)[number];

/** A drive in words, as Windows reported it. Only set when the refusal depends on the drive. */
export interface ProjectFolderVolume {
  readonly drive: string;
  readonly fileSystem: string;
}

/** A folder in the same directory that holds the same project id. The key opens it, like any listed folder. */
export interface ProjectFolderSibling {
  readonly key: string;
  readonly name: string;
}

export interface ProjectFolderEntryView {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timelineProjectId: string;
  readonly visualProjectId: string;
  readonly trashedAt?: string;
}

export type ProjectFolderProblem = 'not-a-folder' | 'no-entry' | 'unreadable' | 'not-read-in-time';

export interface ProjectFolderListedItem {
  readonly key: string;
  readonly name: string;
  readonly entry?: ProjectFolderEntryView;
  readonly problem?: ProjectFolderProblem;
}

export interface ProjectFolderListReply {
  readonly kind: 'listed';
  readonly folders: readonly ProjectFolderListedItem[];
}

/**
 * The owner's question about one folder. `no-record`: the registry names no original for this id. `claimant-missing`:
 * the recorded original is no longer where it was recorded. `duplicate-identity`: a clone of this folder is still where
 * it was recorded. `entry-missing`: the folder lost its entry, and the registry still names it at `recordedPath`.
 */
export interface ProjectFolderAsk {
  readonly reason: 'no-record' | 'claimant-missing' | 'duplicate-identity' | 'entry-missing';
  readonly projectId?: string;
  readonly recordedPath?: string;
  readonly recordedAt?: string;
  /**
   * For claimant-missing: what is at the recorded place now. `missing`: nothing. `other-folder`: another folder with a
   * different identity. `this-folder`: this folder itself, whose identity changed (for example, a restored backup).
   */
  readonly placeState?: 'missing' | 'other-folder' | 'this-folder';
  readonly siblings: readonly ProjectFolderSibling[];
}

/** A folder that could not be settled, and why. Nothing was written for it. */
export type ProjectFolderUnverifiedReason =
  | 'missing-folder'
  | 'unreadable-identity'
  | 'unreadable-place'
  | 'unverified-volume'
  | 'no-folder-identity'
  | 'unverifiable';

export interface ProjectFolderRefused {
  readonly kind: 'refused';
  readonly code: ProjectFolderRefusal;
  /**
   * True when a record was committed before the failure: the same answer must be run again, or the folder opened again.
   * Set for a busy error, and for any other failure after a record was committed.
   */
  readonly appliedInRegistry?: boolean;
  readonly volume?: ProjectFolderVolume;
  /**
   * The folder's name. For name-taken it is the name already in use, and nothing was made. For any other refusal it is
   * set only when the folder was made before the refusal, so the owner knows that a folder exists.
   */
  readonly name?: string;
}

export type ProjectFolderOpenReply =
  | {
      readonly kind: 'ready';
      readonly claim: 'kept' | 'claimed' | 'renewed';
      readonly id: string;
      readonly title: string;
      /** For a renewed copy: the id it had before it got its new one. */
      readonly previousId?: string;
      readonly siblings: readonly ProjectFolderSibling[];
    }
  | { readonly kind: 'ask'; readonly ask: ProjectFolderAsk }
  | {
      readonly kind: 'unverifiable';
      readonly reason: ProjectFolderUnverifiedReason;
      readonly volume?: ProjectFolderVolume;
    }
  | ProjectFolderRefused;

export type ProjectFolderAnswerReply =
  | {
      readonly kind: 'answered';
      readonly claim: 'claimed' | 'kept' | 'renewed' | 'none' | 'unverifiable' | 'undecided';
      readonly id?: string;
      readonly previousId?: string;
      /** For a renewed copy: the other folders that still hold the id it lost. */
      readonly siblings: readonly ProjectFolderSibling[];
      /** For an unverifiable folder whose own drive is the reason: that drive, as Windows reported it. */
      readonly volume?: ProjectFolderVolume;
    }
  | ProjectFolderRefused;

export type ProjectFolderRestoreReply = { readonly kind: 'restored' } | ProjectFolderRefused;

export type ProjectFolderCreateReply =
  | {
      readonly kind: 'created';
      readonly key: string;
      readonly name: string;
      readonly id: string;
      readonly title: string;
    }
  | ProjectFolderRefused;

/** The ask answers, as the renderer sends them. Never a default: the owner picks one. */
export const PROJECT_FOLDER_ANSWERS = ['original', 'copy'] as const;
export type ProjectFolderAnswer = (typeof PROJECT_FOLDER_ANSWERS)[number];
