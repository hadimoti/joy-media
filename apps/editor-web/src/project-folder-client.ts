// A type-only import: desktop-client.ts pulls in the provider modules at run time, and this module must not.
import type { DesktopJoyBridge } from './desktop-client.js';

/**
 * Typed calls to the desktop's project-folder channels (`desktop.project-folder.*`). The shapes mirror
 * packages/project-store/src/project-folder-protocol.ts. editor-web does not import from the desktop, which is a sibling
 * app, so the shapes are declared again here.
 *
 * A folder is named only by the opaque key from the last listing. A refusal comes back as data with a code, and
 * project-folder-messages.ts turns the code into words for the owner.
 */

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

export interface ProjectFolderSibling {
  readonly key: string;
  readonly name: string;
}

export interface ProjectFolderAsk {
  readonly reason: 'no-record' | 'claimant-missing' | 'duplicate-identity' | 'entry-missing';
  readonly projectId?: string;
  readonly recordedPath?: string;
  readonly recordedAt?: string;
  /** For claimant-missing: what is at the recorded place now. */
  readonly placeState?: 'missing' | 'other-folder' | 'this-folder';
  readonly siblings: readonly ProjectFolderSibling[];
}

export interface ProjectFolderVolume {
  readonly drive: string;
  readonly fileSystem: string;
}

export interface ProjectFolderRefused {
  readonly kind: 'refused';
  readonly code: string;
  readonly appliedInRegistry?: boolean;
  readonly volume?: ProjectFolderVolume;
  readonly name?: string;
}

export type ProjectFolderUnverifiedReason =
  | 'missing-folder'
  | 'unreadable-identity'
  | 'unreadable-place'
  | 'unverified-volume'
  | 'no-folder-identity'
  | 'unverifiable';

export type ProjectFolderOpenReply =
  | {
      readonly kind: 'ready';
      readonly claim: 'kept' | 'claimed' | 'renewed';
      readonly id: string;
      readonly title: string;
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

export type ProjectFolderAnswer = 'original' | 'copy';

export type ProjectFolderAnswerReply =
  | {
      readonly kind: 'answered';
      readonly claim: 'claimed' | 'kept' | 'renewed' | 'none' | 'unverifiable' | 'undecided';
      readonly id?: string;
      readonly previousId?: string;
      readonly siblings: readonly ProjectFolderSibling[];
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

/** The desktop bridge (`window.joyDesktop`), present only inside the Electron desktop shell. */
function desktopBridge(): DesktopJoyBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { readonly joyDesktop?: DesktopJoyBridge }).joyDesktop;
}

/** Whether this editor runs inside the desktop app, where project folders exist. */
export function projectFoldersAvailable(): boolean {
  return desktopBridge() !== undefined;
}

function bridge(): DesktopJoyBridge {
  const host = desktopBridge();
  if (host === undefined) throw new Error('Project folders need the desktop app');
  return host;
}

export async function listProjectFolders(): Promise<ProjectFolderListReply> {
  return (await bridge().invoke('desktop.project-folder.list', {})) as ProjectFolderListReply;
}

export async function createProjectFolder(title: string): Promise<ProjectFolderCreateReply> {
  return (await bridge().invoke('desktop.project-folder.create', {
    title,
  })) as ProjectFolderCreateReply;
}

export async function openProjectFolder(key: string): Promise<ProjectFolderOpenReply> {
  return (await bridge().invoke('desktop.project-folder.open', { key })) as ProjectFolderOpenReply;
}

export async function answerProjectFolder(
  key: string,
  answer: ProjectFolderAnswer,
): Promise<ProjectFolderAnswerReply> {
  return (await bridge().invoke('desktop.project-folder.answer', {
    key,
    answer,
  })) as ProjectFolderAnswerReply;
}

export async function restoreProjectFolder(
  key: string,
  title: string,
): Promise<ProjectFolderRestoreReply> {
  return (await bridge().invoke('desktop.project-folder.restore', {
    key,
    title,
  })) as ProjectFolderRestoreReply;
}
