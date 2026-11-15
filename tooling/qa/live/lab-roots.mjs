import { join } from 'node:path';

/**
 * Folders and the approved `joy://` registry hash for a live run. The defaults are the PC's. A second machine
 * (the laptop) sets environment variables instead of editing code:
 *   JOY_QA_ROOT               the run root (default C:\jgp\v111): fixtures, evidence, codex (profiles), dnd
 *   JOY_QA_LOCK               the app lock file (default C:\jgp\LOCK-app-run.txt)
 *   JOY_QA_EXPECTED_JOY_HASH  the SHA-256 of the exported `joy://` key, or the word `absent` when the
 *                             machine has no such key (an unchanged "no key" is then the approved state)
 * Nothing here touches the disk or the registry.
 */
export const PC_JOY_HASH = 'AF05BE55222C86FECE27E738B7E8A931CB4261C9797261C67DDE3C71A4E5CAC0';

export function labRoots(env = process.env) {
  const root = env.JOY_QA_ROOT || 'C:\\jgp\\v111';
  const hash = env.JOY_QA_EXPECTED_JOY_HASH;
  return {
    root,
    lockPath: env.JOY_QA_LOCK || 'C:\\jgp\\LOCK-app-run.txt',
    fixtures: join(root, 'fixtures'),
    evidence: join(root, 'evidence'),
    scratch: join(root, 'codex'),
    drops: join(root, 'dnd'),
    expectedJoyHash:
      hash === undefined || hash === ''
        ? PC_JOY_HASH
        : hash.toLowerCase() === 'absent'
          ? ''
          : hash.toUpperCase(),
  };
}
