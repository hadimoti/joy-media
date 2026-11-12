import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as gate from './gate.js';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The names the owner approved for the project-folder service on 11 Nov 2026, as the gate exports them at run time. */
const APPROVED_GATE_NAMES = [
  'ProjectClaimBusyError',
  'ProjectClaimRefusedError',
  'ProjectClaimRollbackError',
  'ProjectRecordRefusedError',
  'answerProjectFolderAsk',
  'createProjectFolder',
  'describeVolumeAnswer',
  'listProjectFolders',
  'openProjectFolderForEditing',
  'projectFolderName',
  'projectPlaceRefusal',
  'readProjectFolderEntry',
  'recordNewProjectFolder',
  'restoreProjectFolderRecord',
  // Added on 12 Nov 2026 for opening and saving folder projects in the editor (project-folder-editing.ts).
  'projectFolderMediaStates',
  'readProjectFolderDocument',
  'readProjectFolderMedia',
  'saveProjectFolder',
];

describe('the project-store boundary, inside the package', () => {
  it('exports exactly the approved names from the gate the service uses', () => {
    expect(Object.keys(gate).sort()).toEqual([...APPROVED_GATE_NAMES].sort());
  });

  it('lets the service import only node built-ins, the gate and the protocol', () => {
    const source = readFileSync(join(here, 'project-folder-service.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^import\s[^;]*?\sfrom\s+'([^']+)';/gms)].map(
      (match) => match[1] ?? '',
    );
    const allowed = (specifier: string): boolean =>
      specifier.startsWith('node:') ||
      specifier === './gate.js' ||
      specifier === './project-folder-protocol.js';
    expect(specifiers.filter((specifier) => !allowed(specifier))).toEqual([]);
  });
});
