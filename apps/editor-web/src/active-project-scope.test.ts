import { describe, expect, it } from 'vitest';
import { advanceActiveProjectScope, type ActiveProjectScope } from './active-project-scope.js';

function scopeRef(projectId: string | null): { current: ActiveProjectScope } {
  return { current: { projectId, generation: 0 } };
}

describe('advanceActiveProjectScope', () => {
  it('keeps the generation while the active project is unchanged', () => {
    const scope = scopeRef('project-a');
    advanceActiveProjectScope(scope, 'project-a');
    expect(scope.current).toEqual({ projectId: 'project-a', generation: 0 });
  });

  it('raises the generation when the session moves to another project', () => {
    const scope = scopeRef('project-a');
    advanceActiveProjectScope(scope, 'project-b');
    expect(scope.current).toEqual({ projectId: 'project-b', generation: 1 });
  });

  it('counts leaving the library and returning to the same project as a new scope', () => {
    const scope = scopeRef('project-a');
    advanceActiveProjectScope(scope, null);
    advanceActiveProjectScope(scope, 'project-a');
    expect(scope.current).toEqual({ projectId: 'project-a', generation: 2 });
  });
});
