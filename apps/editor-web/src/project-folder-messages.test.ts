import { describe, expect, it } from 'vitest';
import type { ProjectFolderAsk, ProjectFolderRefused } from './project-folder-client.js';
import {
  ANSWER_HELP,
  answerText,
  askCopy,
  createText,
  folderCopyOpenedText,
  folderLoadFailedText,
  folderMissingMediaText,
  folderNotStoredText,
  folderSaveFailedText,
  openText,
  problemWords,
  refusalText,
  restoreText,
  unverifiedText,
  volumeWords,
  whenText,
} from './project-folder-messages.js';

const KNOWN_CODES = [
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
  'settled-not-shown',
] as const;

const refused = (
  code: string,
  extra: Partial<ProjectFolderRefused> = {},
): ProjectFolderRefused => ({
  kind: 'refused',
  code,
  ...extra,
});

describe('refusal sentences', () => {
  it('has a plain sentence for every code the desktop can send, never the code itself', () => {
    for (const code of KNOWN_CODES) {
      const text = refusalText(refused(code));
      expect(text.length).toBeGreaterThan(10);
      // A code with a hyphen is never a word of the sentence. A one-word code may be (busy, failed).
      if (code.includes('-')) expect(text).not.toContain(code);
    }
  });

  it('falls back to a plain sentence for a code it does not know', () => {
    expect(refusalText(refused('something-new'))).toBe(
      'The project folder check failed. Nothing was changed.',
    );
  });

  it('names the drive and its file system when the volume is refused', () => {
    expect(
      refusalText(
        refused('unverified-volume', { volume: { drive: 'fixed drive', fileSystem: 'FAT32' } }),
      ),
    ).toBe(
      'This folder is on a fixed drive formatted as FAT32. Folder projects need an NTFS drive for now.',
    );
  });

  it('says a busy answer may be partly saved, and to run it again', () => {
    expect(refusalText(refused('busy', { appliedInRegistry: true }))).toContain(
      'Run the same answer again.',
    );
    expect(refusalText(refused('busy'))).not.toContain('Run the same answer again.');
  });

  it('names the folder when a new name is taken', () => {
    expect(refusalText(refused('name-taken', { name: 'Summer.joyproj' }))).toContain(
      '“Summer.joyproj”',
    );
  });

  it('says what a volume is in words', () => {
    expect(volumeWords({ drive: 'removable drive', fileSystem: 'exFAT' })).toBe(
      'a removable drive formatted as exFAT',
    );
    expect(volumeWords({ drive: 'fixed drive', fileSystem: 'no file system' })).toBe(
      'a fixed drive with no file system',
    );
    expect(volumeWords({ drive: 'no local drive', fileSystem: 'none' })).toContain('UNC path');
  });
});

describe('unverifiable folders', () => {
  it('say nothing was changed, and that the app cannot settle an entry it cannot check', () => {
    expect(unverifiedText('unverifiable', undefined)).toContain('no way to settle it yet');
  });

  it('name the drive when it is the cause', () => {
    expect(
      unverifiedText('unverified-volume', { drive: 'fixed drive', fileSystem: 'FAT32' }),
    ).toContain('fixed drive formatted as FAT32');
  });
});

describe('ready and renewed folders', () => {
  it('says a ready folder is opening, by its title', () => {
    const text = openText({
      kind: 'ready',
      claim: 'kept',
      id: 'project-1',
      title: 'Summer Cut',
      siblings: [],
    });
    expect(text).toBe('Opening “Summer Cut”.');
    expect(text).not.toContain('not built yet');
  });

  it('says a renewed copy got a new id, its old id, and the folders that still hold the old id', () => {
    const text = openText({
      kind: 'ready',
      claim: 'renewed',
      id: 'project-2',
      title: 'Summer copy',
      previousId: 'project-1',
      siblings: [{ key: 'folder-1', name: 'Summer.joyproj' }],
    });
    expect(text).toContain('This copy got a new id. Its old id was project-1.');
    expect(text).toContain('Other folders with the same id: Summer.joyproj.');
  });

  it('says an unverifiable folder and a refused one in words', () => {
    expect(openText({ kind: 'unverifiable', reason: 'missing-folder' })).toContain('missing');
    expect(openText(refused('no-entry'))).toContain('no project entry');
  });
});

describe('answers and restores', () => {
  it('says each settled answer in words', () => {
    expect(answerText({ kind: 'answered', claim: 'claimed', siblings: [] })).toContain(
      'now the original',
    );
    expect(answerText({ kind: 'answered', claim: 'kept', siblings: [] })).toBe(
      'The folder keeps its id.',
    );
    expect(
      answerText({
        kind: 'answered',
        claim: 'renewed',
        id: 'project-2',
        previousId: 'project-1',
        siblings: [],
      }),
    ).toBe('This copy got a new id: project-2. Its old id was project-1.');
    expect(answerText({ kind: 'answered', claim: 'none', siblings: [] })).toBe(
      'Nothing was changed.',
    );
    expect(answerText({ kind: 'answered', claim: 'undecided', siblings: [] })).toContain(
      'still open',
    );
    expect(answerText({ kind: 'answered', claim: 'unverifiable', siblings: [] })).toContain(
      'cannot be checked',
    );
  });

  it('says a refused answer in words', () => {
    expect(answerText(refused('recorded-original-in-place'))).toContain(
      'still where it was recorded',
    );
  });

  it('says a restore in words, and a refused one too', () => {
    expect(restoreText({ kind: 'restored' })).toContain('entry is back');
    expect(restoreText(refused('no-title'))).toBe('Give the project a name first.');
  });

  it('says a new folder project was created, and what to do when it was made but not recorded', () => {
    expect(
      createText({
        kind: 'created',
        key: 'folder-1',
        name: 'Summer.joyproj',
        id: 'project-1',
        title: 'Summer',
      }),
    ).toBe('Created “Summer.joyproj” in your projects folder.');
    expect(createText(refused('id-in-use', { name: 'Summer.joyproj' }))).toContain(
      'was made, but the app could not record it',
    );
  });

  it('says where a new folder would be made when its drive is not verified as NTFS', () => {
    expect(
      createText(
        refused('unverified-volume', { volume: { drive: 'removable drive', fileSystem: 'FAT32' } }),
      ),
    ).toBe(
      'The folder would be made on a removable drive formatted as FAT32. Folder projects need an NTFS drive for now.',
    );
  });

  it('keeps the made-folder sentence when the record is refused after the folder was made', () => {
    const text = createText(
      refused('unverified-volume', {
        name: 'Summer.joyproj',
        volume: { drive: 'removable drive', fileSystem: 'FAT32' },
      }),
    );
    expect(text).toContain('was made, but the app could not record it');
    expect(text).not.toContain('would be made');
  });

  it('says a new folder would be made on a drive that is not verified as NTFS when the drive is not known', () => {
    expect(createText(refused('unverified-volume', {}))).toBe(
      'The folder would be made on a drive that is not verified as NTFS. Folder projects need an NTFS drive for now.',
    );
  });
});

describe('the owner’s question', () => {
  const shared = { siblings: [] as ProjectFolderAsk['siblings'] };

  it('shows where the original was last seen, when it is known, and never picks an answer', () => {
    const copy = askCopy({
      reason: 'claimant-missing',
      recordedPath: 'D:\\Projects\\Summer.joyproj',
      recordedAt: '2026-11-10T10:00:00.000Z',
      ...shared,
    });
    expect(copy.title).toBe('The original is not where it was recorded.');
    expect(copy.paragraphs.join(' ')).toContain('D:\\Projects\\Summer.joyproj');
    expect(copy.paragraphs.join(' ')).toContain('“This is the original”');
    expect(copy.paragraphs.join(' ')).toContain('“This is a copy”');
    expect(copy.paragraphs.join(' ')).toContain('its id changes this way');
  });

  it('explains a duplicate identity: a clone of this folder is still where it was recorded', () => {
    const copy = askCopy({
      reason: 'duplicate-identity',
      recordedPath: 'C:\\Projects\\Summer.joyproj',
      recordedAt: '2026-11-10T10:00:00.000Z',
      ...shared,
    });
    expect(copy.paragraphs.join(' ')).toContain('same identity');
    expect(copy.paragraphs.join(' ')).toContain('may be a clone');
  });

  it('asks which folder is the original when nothing is recorded, without a recorded place', () => {
    const copy = askCopy({ reason: 'no-record', projectId: 'project-1', ...shared });
    expect(copy.title).toBe('Which folder is the original?');
    expect(copy.paragraphs.join(' ')).not.toContain('recorded');
  });

  it('shows the folders that hold the same id', () => {
    const copy = askCopy({
      reason: 'no-record',
      siblings: [{ key: 'folder-2', name: 'Summer copy.joyproj' }],
    });
    expect(copy.siblings).toBe('Other folders with the same id: Summer copy.joyproj.');
  });

  it('shows no sibling line when no other folder holds the id', () => {
    expect(askCopy({ reason: 'no-record', ...shared }).siblings).toBe('');
  });

  it('is the restore prompt for a lost entry, and keeps the id', () => {
    const copy = askCopy({
      reason: 'entry-missing',
      projectId: 'project-1',
      recordedPath: 'C:\\Projects\\Summer.joyproj',
      recordedAt: '2026-11-10T10:00:00.000Z',
      ...shared,
    });
    expect(copy.title).toBe('This folder lost its project entry.');
    expect(copy.paragraphs.join(' ')).toContain('The project id stays the same.');
    expect(ANSWER_HELP.restore).toContain('cannot be undone');
  });

  it('says what each answer does, and says plainly that undo is not in the app yet', () => {
    for (const help of [ANSWER_HELP.original, ANSWER_HELP.copy, ANSWER_HELP.restore]) {
      expect(help).toMatch(/undo|undone/i);
      expect(help).toContain('yet');
    }
  });
});

describe('the question by place state, and what a failed create says', () => {
  const base = {
    recordedPath: 'C:\\Projects\\Summer.joyproj',
    siblings: [] as ProjectFolderAsk['siblings'],
  };

  it('says this folder is at the recorded place with a changed identity, and offers no copy', () => {
    const copy = askCopy({ ...base, reason: 'claimant-missing', placeState: 'this-folder' });
    expect(copy.paragraphs.join(' ')).toContain('This folder is at that place now');
    expect(copy.offersCopy).toBe(false);
  });

  it('says another folder is at the recorded place, and offers both answers', () => {
    const copy = askCopy({ ...base, reason: 'claimant-missing', placeState: 'other-folder' });
    expect(copy.paragraphs.join(' ')).toContain('Another folder is at that place now');
    expect(copy.offersCopy).toBe(true);
  });

  it('says the original is not there now when nothing is at the recorded place', () => {
    const copy = askCopy({ ...base, reason: 'claimant-missing', placeState: 'missing' });
    expect(copy.paragraphs.join(' ')).toContain('It is not there now.');
    expect(copy.offersCopy).toBe(true);
  });

  it('names a folder that was made before its record failed, and does not ask for the same answer again', () => {
    const text = createText(refused('busy', { appliedInRegistry: true, name: 'Summer.joyproj' }));
    expect(text).toContain('“Summer.joyproj” was made, but the app could not record it');
    expect(text).toContain('not a project yet');
    expect(text).not.toContain('Run the same answer again');
  });

  it('says a taken name is only a refusal of the name, never a made folder', () => {
    const text = createText(refused('name-taken', { name: 'Summer.joyproj' }));
    expect(text).toContain('A folder named “Summer.joyproj” is already in your projects folder.');
    expect(text).not.toContain('was made');
  });

  it('says a moved original’s id changes when it is settled as a copy, even with no record', () => {
    const copy = askCopy({ reason: 'no-record', siblings: [] });
    expect(copy.paragraphs.join(' ')).toContain(
      'If this folder is a moved original, its id changes this way.',
    );
  });

  it('names the other folders that hold the old id after a copy is answered', () => {
    const text = answerText({
      kind: 'answered',
      claim: 'renewed',
      id: 'project-2',
      previousId: 'project-1',
      siblings: [{ key: 'folder-1', name: 'Summer.joyproj' }],
    });
    expect(text).toContain('Other folders with the same id: Summer.joyproj.');
  });
});

describe('the words after a partly saved change', () => {
  it('tells the owner to open a busy folder again, never to run an answer again', () => {
    const text = openText(refused('busy', { appliedInRegistry: true }));
    expect(text).toContain('Open the folder again to check it.');
    expect(text).not.toContain('Run the same answer again');
  });

  it('says a failure after a saved record never claims that nothing was changed', () => {
    const text = refusalText(refused('failed', { appliedInRegistry: true }));
    expect(text).toContain('The change could not be finished.');
    expect(text).toContain('Part of the change was saved. Run the same answer again.');
    expect(text).not.toContain('Nothing was changed');
  });

  it('tells the owner to open the folder again after a failure that saved a record', () => {
    const text = openText(refused('failed', { appliedInRegistry: true }));
    expect(text).toContain('The change could not be finished.');
    expect(text).toContain('Open the folder again to check it.');
    expect(text).not.toContain('Nothing was changed');
  });

  it('never says nothing was changed after a saved record, whatever the refusal code', () => {
    for (const code of ['damaged', 'restart', 'failed', 'busy']) {
      const extra = { appliedInRegistry: true };
      expect(refusalText(refused(code, extra))).not.toContain('Nothing was changed');
      expect(openText(refused(code, extra))).not.toContain('Nothing was changed');
    }
  });

  it('tells the owner to restart the app when a failed rollback saved a record on create', () => {
    const text = createText(
      refused('restart', { appliedInRegistry: true, name: 'Summer.joyproj' }),
    );
    expect(text).toContain('Part of the change was saved');
    expect(text).toContain(
      'Restart the app, then open the folder in the list and give it a title to finish it.',
    );
    expect(text).not.toContain('Choose another name');
  });

  it('tells the owner to restart, then make the project under another name, when a failed rollback saved no record on create', () => {
    const text = createText(refused('restart', { name: 'Summer.joyproj' }));
    expect(text).toContain(
      '“Summer.joyproj” was made, but the app could not record it, so it is not a project yet.',
    );
    expect(text).toContain('Restart the app before anything else.');
    expect(text).toContain(
      'create the project under another name, and this folder is left as it is.',
    );
    expect(text).not.toContain('give it a title');
    expect(text).not.toContain('Part of the change was saved');
  });

  it('says a saved create is in the list with no entry, and that opening it there finishes it', () => {
    const text = createText(refused('busy', { appliedInRegistry: true, name: 'Summer.joyproj' }));
    expect(text).toContain('Part of the change was saved');
    expect(text).toContain('in the list with no project entry yet');
    expect(text).toContain('give it a title to finish it');
    expect(text).not.toContain('Choose another name');
  });

  it('says a restore that saved a change in the words for reopening the folder, never as an answer', () => {
    const text = restoreText(refused('busy', { appliedInRegistry: true }));
    expect(text).toContain('Open the folder again to check it.');
    expect(text).not.toContain('Run the same answer again');
  });

  it('puts the restart first when a failed rollback saved a change, then the instruction', () => {
    expect(refusalText(refused('restart', { appliedInRegistry: true }))).toContain(
      'Restart the app, then run the same answer again.',
    );
    expect(openText(refused('restart', { appliedInRegistry: true }))).toContain(
      'Restart the app, then open the folder again to check it.',
    );
  });

  it('says a settled change that could not be shown is settled, and never says nothing was changed', () => {
    expect(openText(refused('settled-not-shown'))).toContain('The folder was settled');
    expect(openText(refused('settled-not-shown'))).toContain('Open the folder again to check it.');
    expect(openText(refused('settled-not-shown'))).not.toContain('Nothing was changed');
    expect(answerText(refused('settled-not-shown'))).not.toContain('Nothing was changed');
  });

  it('says a partly saved create gives no retry advice, and does not say the app cannot finish it', () => {
    const text = createText(refused('busy', { appliedInRegistry: true, name: 'Summer.joyproj' }));
    expect(text).not.toContain('try again later');
    expect(text).not.toContain('cannot finish it from here yet');
  });

  it('names the drive when an unverifiable answer is caused by it', () => {
    const text = answerText({
      kind: 'answered',
      claim: 'unverifiable',
      siblings: [],
      volume: { drive: 'fixed drive', fileSystem: 'FAT32' },
    });
    expect(text).toContain('a fixed drive formatted as FAT32');
    expect(text).toContain('Nothing was changed');
  });
});

describe('a copy of the original itself', () => {
  it('is refused, and offers the original answer that keeps the folder as it is', () => {
    const text = refusalText(refused('recorded-original-itself'));
    expect(text).toContain('so it cannot be a copy');
    expect(text).toContain('Choose “This is the original” to keep it as it is.');
  });
});

describe('small helpers', () => {
  it('shows an unreadable date as it was written', () => {
    expect(whenText('not a date')).toBe('not a date');
    expect(whenText('2026-11-10T10:00:00.000Z')).not.toBe('');
  });

  it('says why a folder in the list could not be read', () => {
    expect(problemWords('not-a-folder')).toBe('not a project folder');
    expect(problemWords('no-entry')).toBe('no project entry');
    expect(problemWords('unreadable')).toBe('could not be read');
    expect(problemWords('not-read-in-time')).toBe('busy, try again');
  });
});

describe('folder project media and save words', () => {
  it('say one missing media file by name, that its place is kept, and how to bring it back', () => {
    expect(folderMissingMediaText('Summer', ['beach.mp4'])).toBe(
      '“Summer” opened, but 1 media file is missing from its folder: beach.mp4. Its place in the project is kept. Import the very same file again and it goes back in place.',
    );
  });

  it('say several missing files, and shorten a long list', () => {
    expect(folderMissingMediaText('Summer', ['a.mp4', 'b.png'])).toBe(
      '“Summer” opened, but 2 media files are missing from its folder: a.mp4 and b.png. Their places in the project are kept. Import the very same files again and they go back in place.',
    );
    expect(folderMissingMediaText('Summer', ['a', 'b', 'c', 'd', 'e'])).toContain(
      '5 media files are missing from its folder: a, b, c and 2 more.',
    );
  });

  it('say nothing when no media is missing', () => {
    expect(folderMissingMediaText('Summer', [])).toBeUndefined();
    expect(folderNotStoredText([])).toBeUndefined();
  });

  it('say which media a save could not copy into the folder', () => {
    expect(folderNotStoredText(['logo.png'])).toBe(
      'Saved, but 1 media file could not be copied into the project folder: logo.png. It still plays here. Import it again, and the app copies it into the folder on the next save.',
    );
  });

  it('say a failed save keeps the changes in the app', () => {
    for (const code of ['not-open', 'save-conflict', 'wrong-project', 'failed', undefined]) {
      expect(folderSaveFailedText(code)).toMatch(/kept in the app/);
    }
  });

  it('say a failed load changed nothing in the folder', () => {
    expect(folderLoadFailedText('unreadable')).toContain('Nothing was changed in the folder.');
    expect(folderLoadFailedText('failed')).toContain('Nothing was changed in the folder.');
  });

  it('use no developer words', () => {
    const texts = [
      folderMissingMediaText('Summer', ['a.mp4']),
      folderNotStoredText(['a.mp4']),
      folderSaveFailedText('save-conflict'),
      folderSaveFailedText('not-open'),
      folderLoadFailedText('unreadable'),
      folderCopyOpenedText(),
    ].join(' ');
    expect(texts).not.toMatch(/sqlite|asset id|checksum|revision|IPC|database|cache/i);
  });
});
