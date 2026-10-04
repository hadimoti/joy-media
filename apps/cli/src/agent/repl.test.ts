import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '../utils/project-loader.js';
import * as projectLoader from '../utils/project-loader.js';
import { describeDualBrain, saveReplProject } from './repl.js';
import { RETIRED_MODEL_IDS } from '@joy-media/joy-agent-engine';

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

  it('reports no retired model ids in the dual-brain REPL status', () => {
    const status = describeDualBrain();
    const renderedStatus = JSON.stringify(status);
    for (const retiredModelId of RETIRED_MODEL_IDS) {
      expect(renderedStatus).not.toContain(retiredModelId);
    }
  });
});
