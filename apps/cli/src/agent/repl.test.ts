import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../utils/project-loader.js';
import * as projectLoader from '../utils/project-loader.js';
import { saveReplProject } from './repl.js';

describe('agent REPL project saving', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not persist a scratch project to the sentinel in-memory path', () => {
    const saveSpy = vi.spyOn(projectLoader, 'saveProject');
    const project = createDefaultProject('Scratch');
    expect(
      saveReplProject(project, { project, revision: 3, source: 'sqlite', path: 'in-memory' }, 3),
    ).toBe(3);
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
