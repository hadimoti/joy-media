import type {
  ProjectFolderAnswerReply,
  ProjectFolderAsk,
  ProjectFolderCreateReply,
  ProjectFolderOpenReply,
  ProjectFolderProblem,
  ProjectFolderRefused,
  ProjectFolderRestoreReply,
  ProjectFolderSibling,
  ProjectFolderUnverifiedReason,
  ProjectFolderVolume,
} from './project-folder-client.js';

/**
 * The words the owner reads for project folders. Short, plain sentences, and no store terms or codes. Every reply the
 * desktop can send has a sentence here, so a refusal never reaches the owner as a bare code.
 */

const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'no-title': 'Give the project a name first.',
  'name-taken': 'A folder with this name is already in your projects folder. Choose another name.',
  'unknown-folder': 'That folder is no longer in the list. Refresh the list and try again.',
  'not-a-folder': 'This folder is not a project folder: its project file is missing.',
  'no-entry':
    'This folder has no project entry yet, and the app has no record of it as a project, so it cannot be opened here.',
  'missing-folder': 'This folder is missing. It may have been moved or renamed.',
  'unreadable-identity': 'The folder could not be read. Its drive may be disconnected or busy.',
  'unreadable-place': 'The real place of this folder could not be read, so it cannot be checked.',
  'no-folder-identity':
    'This drive does not give folder identities, so the folder cannot be checked.',
  'unverified-volume':
    'This folder is on a drive that is not verified as NTFS. Folder projects need an NTFS drive for now.',
  damaged: 'The stored project data in this folder cannot be read. Nothing was changed.',
  busy: 'The project is busy. Try again in a moment.',
  restart: 'A project check failed and could not be undone. Restart the app before trying again.',
  'other-id-held': 'This folder already holds a different project id.',
  'id-recorded-elsewhere': 'Another folder is already the original of this project id.',
  'folder-recorded-under-other-id': 'This folder is already recorded under another project id.',
  'id-held-unrecorded':
    'This folder holds a project id, but no record says it is the original. Choose which folder is the original.',
  'id-in-use': 'The new project id is already in use. Try again.',
  'has-entry': 'This folder already has its project entry, so there is nothing to restore.',
  'has-documents': 'This folder holds documents but no entry, so it cannot be restored.',
  'no-record-here':
    'The app does not remember this project at this place. Move the folder back to where it was, then restore it.',
  'recorded-original-in-place':
    'The original of this project id is still where it was recorded, so this folder cannot take its place.',
  'recorded-original-itself':
    'This folder is the original of its project id, so it cannot be a copy. Choose “This is the original” to keep it as it is.',
  'identity-changed-at-place':
    'This folder is at the recorded place of its project id, but it has changed. A copy cannot take a new id here. Choose “This is the original” to keep it under its id.',
  failed: 'The project folder check failed. Nothing was changed. Try again.',
  'settled-not-shown':
    'The folder was settled, but the app could not show the result. Open the folder again to check it.',
};

const UNKNOWN_REFUSAL = 'The project folder check failed. Nothing was changed.';

/** The start of the sentence for a failure after part of a change was saved. It never says that nothing was changed. */
const PARTLY_FAILED_WORDS = 'The change could not be finished.';

/** What each answer does, said under its button. Nothing here offers an undo the app does not have. */
export const ANSWER_HELP = {
  original: 'Keeps this folder under its id. Undo is not in the app yet.',
  copy: 'Gives this folder a new id, even when it is a moved original. This cannot be undone in the app yet.',
  restore: 'Writes the project entry once. This cannot be undone in the app yet.',
} as const;

/** Why a folder in the list could not be read, in words for the owner's notice. */
export function problemWords(problem: ProjectFolderProblem): string {
  switch (problem) {
    case 'not-a-folder':
      return 'not a project folder';
    case 'no-entry':
      return 'no project entry';
    case 'unreadable':
      return 'could not be read';
    case 'not-read-in-time':
      return 'busy, try again';
  }
}

/** A date for the owner, or the text unchanged when it is not a date. */
export function whenText(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString();
}

/** A drive in words, such as "a fixed drive formatted as FAT32". */
export function volumeWords(volume: ProjectFolderVolume): string {
  if (volume.drive === 'no local drive') return 'no local drive (a network share or a UNC path)';
  if (volume.drive === 'drive not checked') return 'a drive that could not be checked';
  return volume.fileSystem === 'no file system'
    ? `a ${volume.drive} with no file system`
    : `a ${volume.drive} formatted as ${volume.fileSystem}`;
}

/** The words for one refusal, with no note about an answer. The drive and the folder name are used when known. */
export function refusalWords(refusal: ProjectFolderRefused): string {
  if (refusal.code === 'unverified-volume' && refusal.volume !== undefined) {
    return `This folder is on ${volumeWords(refusal.volume)}. Folder projects need an NTFS drive for now.`;
  }
  if (refusal.code === 'name-taken' && refusal.name !== undefined) {
    return `A folder named “${refusal.name}” is already in your projects folder. Choose another name.`;
  }
  return REFUSAL_WORDS[refusal.code] ?? UNKNOWN_REFUSAL;
}

/** The start of a restart sentence, without its instruction. The instruction says what to do after the restart. */
const RESTART_START = 'A project check failed and could not be undone.';

/**
 * The sentences for a refusal after part of a change was saved. They never say that nothing was changed. A restart comes
 * first when the owner needs one, and the instruction to do the change again follows it.
 */
function savedChangeText(
  refusal: ProjectFolderRefused,
  rerun: string,
  restartRerun: string,
): string {
  if (refusal.code === 'restart')
    return `${RESTART_START} Part of the change was saved. ${restartRerun}`;
  const start = refusal.code === 'busy' ? 'The project is busy.' : PARTLY_FAILED_WORDS;
  return `${start} Part of the change was saved. ${rerun}`;
}

/** The sentence for one refusal of an answer or a restore. An answer that was partly saved says so. */
export function refusalText(refusal: ProjectFolderRefused): string {
  if (refusal.appliedInRegistry === true) {
    return savedChangeText(
      refusal,
      'Run the same answer again.',
      'Restart the app, then run the same answer again.',
    );
  }
  return refusalWords(refusal);
}

/** The sentence for a folder that could not be settled. Nothing was written for it. */
export function unverifiedText(
  reason: ProjectFolderUnverifiedReason,
  volume: ProjectFolderVolume | undefined,
): string {
  if (reason === 'unverified-volume') {
    return refusalText({
      kind: 'refused',
      code: 'unverified-volume',
      ...(volume === undefined ? {} : { volume }),
    });
  }
  if (reason === 'unverifiable') {
    return 'This folder cannot be checked yet. Nothing was changed. The app has no way to settle it yet.';
  }
  return REFUSAL_WORDS[reason] ?? UNKNOWN_REFUSAL;
}

function siblingsSentence(siblings: readonly ProjectFolderSibling[]): string {
  if (siblings.length === 0) return '';
  return `Other folders with the same id: ${siblings.map((sibling) => sibling.name).join(', ')}.`;
}

/** The sentence after a folder is settled as ready, or the reason it is not. */
export function openText(reply: Exclude<ProjectFolderOpenReply, { readonly kind: 'ask' }>): string {
  // An open has no answer to run again. A partly saved change is checked by opening the folder again: that may settle
  // it, or ask the owner a question.
  if (reply.kind === 'refused' && reply.appliedInRegistry === true) {
    return savedChangeText(
      reply,
      'Open the folder again to check it.',
      'Restart the app, then open the folder again to check it.',
    );
  }
  if (reply.kind === 'refused' && reply.code === 'busy') {
    return 'The project is busy. Open the folder again in a moment.';
  }
  if (reply.kind === 'refused') return refusalText(reply);
  if (reply.kind === 'unverifiable') return unverifiedText(reply.reason, reply.volume);
  const ready = `Opening “${reply.title}”.`;
  if (reply.claim !== 'renewed' || reply.previousId === undefined) return ready;
  const renewed = `This copy got a new id. Its old id was ${reply.previousId}.`;
  const others = siblingsSentence(reply.siblings);
  return [ready, renewed, others].filter((part) => part !== '').join(' ');
}

/** The sentence after an answer to an ask. */
export function answerText(reply: ProjectFolderAnswerReply): string {
  if (reply.kind === 'refused') return refusalText(reply);
  switch (reply.claim) {
    case 'claimed':
      return 'This folder is now the original of its project id.';
    case 'kept':
      return 'The folder keeps its id.';
    case 'renewed': {
      const renewed = `This copy got a new id: ${reply.id ?? 'a new id'}. Its old id was ${reply.previousId ?? 'unknown'}.`;
      const others = siblingsSentence(reply.siblings);
      return [renewed, others].filter((part) => part !== '').join(' ');
    }
    case 'none':
      return 'Nothing was changed.';
    case 'unverifiable':
      return reply.volume === undefined
        ? 'Nothing was changed. This folder cannot be checked yet.'
        : `Nothing was changed. This folder is on ${volumeWords(reply.volume)}, so it cannot be checked yet.`;
    case 'undecided':
      return 'Nothing was changed. The question is still open.';
  }
}

/** The sentence after a restore answer. */
export function restoreText(reply: ProjectFolderRestoreReply): string {
  if (reply.kind === 'restored') return 'The project entry is back. Checking the folder again.';
  // A restore is not an answer, so a saved change is said with the words for reopening the folder.
  if (reply.appliedInRegistry === true) {
    return savedChangeText(
      reply,
      'Open the folder again to check it.',
      'Restart the app, then open the folder again to check it.',
    );
  }
  return refusalText(reply);
}

/**
 * The sentence after a new folder project is made, or is not. A folder that was made before a refusal is always named:
 * it exists on disk, and it is not a project until it is recorded.
 */
export function createText(reply: ProjectFolderCreateReply): string {
  if (reply.kind === 'created') return `Created “${reply.name}” in your projects folder.`;
  // A taken name was never made, so it is only a refusal of the name.
  if (reply.code === 'name-taken') return refusalText(reply);
  // A folder on an unverified drive that was never made says where it would be made. One that was made keeps the name branch.
  if (reply.code === 'unverified-volume' && reply.name === undefined) {
    const where =
      reply.volume === undefined
        ? 'a drive that is not verified as NTFS'
        : volumeWords(reply.volume);
    return `The folder would be made on ${where}. Folder projects need an NTFS drive for now.`;
  }
  if (reply.name !== undefined) {
    // A saved record leaves the folder in the list with no entry, and opening it there gives the restore question.
    if (reply.appliedInRegistry === true && reply.code !== 'restart') {
      return `The folder “${reply.name}” was made, but the app could not record it, so it is not a project yet. Part of the change was saved. The folder is in the list with no project entry yet: open it there and give it a title to finish it.`;
    }
    // A rollback that saved no record leaves no registry row, so opening the folder gives the no-entry refusal and no
    // title step. The owner restarts the app, then makes the project under another name, and the folder is left as it is.
    if (reply.code === 'restart' && reply.appliedInRegistry !== true) {
      return `The folder “${reply.name}” was made, but the app could not record it, so it is not a project yet. Restart the app before anything else. Then you can create the project under another name, and this folder is left as it is.`;
    }
    // A rollback failure leaves a connection inside a transaction, so the owner restarts the app before anything else.
    const saved = reply.appliedInRegistry === true ? ' Part of the change was saved.' : '';
    const next =
      reply.code === 'restart'
        ? ' Restart the app, then open the folder in the list and give it a title to finish it.'
        : ' You can create the project under another name, and this folder is left as it is.';
    return `The folder “${reply.name}” was made, but the app could not record it, so it is not a project yet.${saved}${next}`;
  }
  return refusalText(reply);
}

export interface AskCopy {
  readonly title: string;
  readonly paragraphs: readonly string[];
  /** Other folders that hold the same id, or an empty string. */
  readonly siblings: string;
  /** False when the copy answer would be refused here, so the question does not offer it. */
  readonly offersCopy: boolean;
}

function recordedNote(ask: ProjectFolderAsk): string {
  if (ask.recordedPath === undefined) return '';
  const when = ask.recordedAt === undefined ? '' : ` (recorded ${whenText(ask.recordedAt)})`;
  return ` at ${ask.recordedPath}${when}`;
}

/** The question when the original was recorded at a place that no longer holds it. What is there now decides the words. */
function claimantMissingCopy(ask: ProjectFolderAsk, siblings: string): AskCopy {
  const seen = `The original was last seen${recordedNote(ask)}.`;
  if (ask.placeState === 'this-folder') {
    return {
      title: 'This folder is at the recorded place, but it has changed.',
      paragraphs: [
        `${seen} This folder is at that place now, but its identity is not the one recorded. It may have been restored from a backup.`,
        'Choose “This is the original” to keep this folder under its id.',
        'A copy cannot take a new id at the recorded place, so that choice is not offered here.',
      ],
      siblings,
      offersCopy: false,
    };
  }
  if (ask.placeState === 'other-folder') {
    return {
      title: 'The original is not where it was recorded.',
      paragraphs: [
        `${seen} Another folder is at that place now, and it is not this one.`,
        'If the original was moved or renamed within your projects folder, it may be one of the folders listed below.',
        'Choose “This is the original” if this folder is the original.',
        'Choose “This is a copy” to give this folder a new id. If this folder is the moved original, its id changes this way.',
      ],
      siblings,
      offersCopy: true,
    };
  }
  return {
    title: 'The original is not where it was recorded.',
    paragraphs: [
      `${seen} It is not there now.`,
      'If you moved or renamed it within your projects folder, it may be one of the folders listed below.',
      'Choose “This is the original” if this folder is the original.',
      'Choose “This is a copy” to give this folder a new id. If this folder is the moved original, its id changes this way.',
    ],
    siblings,
    offersCopy: true,
  };
}

/**
 * The owner's question for an ask that settles by a choice: which folder is the original. It never picks one for the
 * owner, and it says where the original was last seen. The entry-missing case is the restore prompt, not this one.
 */
export function askCopy(ask: ProjectFolderAsk): AskCopy {
  const siblings = siblingsSentence(ask.siblings);
  switch (ask.reason) {
    case 'no-record':
      return {
        title: 'Which folder is the original?',
        paragraphs: [
          'The app has no record of which folder holds this project id.',
          'Choose “This is the original” to keep this folder under its id.',
          'Choose “This is a copy” to give this folder a new id. If this folder is a moved original, its id changes this way.',
        ],
        siblings,
        offersCopy: true,
      };
    case 'claimant-missing':
      return claimantMissingCopy(ask, siblings);
    case 'duplicate-identity':
      return {
        title: 'Another folder is the same folder.',
        paragraphs: [
          `A folder with the same identity was recorded as the original${recordedNote(ask)}, and it is still there.`,
          'This folder may be a clone of it. Choose which one is the original.',
          'Choose “This is a copy” to give this folder a new id.',
        ],
        siblings,
        offersCopy: true,
      };
    case 'entry-missing':
      return {
        title: 'This folder lost its project entry.',
        paragraphs: [
          `The app remembers this project${recordedNote(ask)}.`,
          'Give the project a title to restore its entry. The project id stays the same.',
          'If the folder was moved or renamed, put it back at that place first. Restore is refused anywhere else.',
        ],
        siblings,
        offersCopy: false,
      };
  }
}

/** A list of file names in plain words: “a”, “a and b”, “a, b and c”, or the first three and how many more. */
function namesInWords(names: readonly string[]): string {
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * The words when a folder project opens but some of its media is in neither the folder nor this computer's media
 * cache. Media is named by checksum, so the very same file imported again fills its place by itself.
 */
export function folderMissingMediaText(
  title: string,
  names: readonly string[],
): string | undefined {
  if (names.length === 0) return undefined;
  const one = names.length === 1;
  return [
    `“${title}” opened, but ${one ? '1 media file is' : `${names.length} media files are`} missing from its folder: ${namesInWords(names)}.`,
    one ? 'Its place in the project is kept.' : 'Their places in the project are kept.',
    one
      ? 'Import the very same file again and it goes back in place.'
      : 'Import the very same files again and they go back in place.',
  ].join(' ');
}

/** The words when a save lands, but some media could not be copied into the folder. */
export function folderNotStoredText(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  const one = names.length === 1;
  return [
    `Saved, but ${one ? '1 media file' : `${names.length} media files`} could not be copied into the project folder: ${namesInWords(names)}.`,
    one
      ? 'It still plays here. Import it again, and the app copies it into the folder on the next save.'
      : 'They still play here. Import them again, and the app copies them into the folder on the next save.',
  ].join(' ');
}

/** The words when a save into the folder is refused or fails. The working copy in the app always keeps the changes. */
export function folderSaveFailedText(code: string | undefined): string {
  switch (code) {
    case 'not-open':
      return 'Your changes are kept in the app, but the project folder is closed. Go back to Projects and open the folder again to save into it.';
    case 'save-conflict':
    case 'wrong-project':
      return 'This project folder was changed somewhere else. Your changes are kept in the app. Go back to Projects and open the folder again.';
    default:
      return 'Your changes could not be saved into the project folder. They are kept in the app, and the app tries again.';
  }
}

/** The words when a folder was settled as ready, but its saved project could not be loaded into the editor. */
export function folderLoadFailedText(code: string | undefined): string {
  if (code === 'not-open') {
    return 'The project folder was closed before it could open. Open it again.';
  }
  if (code === 'unreadable') {
    return 'The saved project in this folder could not be read, so it was not opened. Nothing was changed in the folder.';
  }
  return 'The project folder could not be opened in the editor. Nothing was changed in the folder. Try again.';
}

/** The words when a copied folder opens: it is its own project now, and the folder it was copied from is untouched. */
export function folderCopyOpenedText(): string {
  return 'This folder is a copy, so it opened as a new project of its own. The folder it was copied from is left as it is.';
}
