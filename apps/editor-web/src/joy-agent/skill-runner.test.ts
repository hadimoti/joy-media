import { describe, expect, it, vi } from 'vitest';
import {
  createCreativeSkillRunner,
  type CreativeSkillRunAdapter,
  type CreativeSkillStepResult,
} from './skill-runner.js';
import { JOY_EDITOR_OPERATION_DEFINITIONS } from '@joy-media/agent-tools';

const runtime = {
  capabilities: [
    'project-context',
    'canonical-prepare',
    'preview',
    'approval',
    'source-observation',
    'evidence-coverage',
    'transcript-evidence',
    'audio-analysis',
    'audio-mix',
    'rtl-text',
    'composition-capture',
    'encoded-output-verification',
  ] as const,
  operationDefinitions: JOY_EDITOR_OPERATION_DEFINITIONS,
};

function adapter(): CreativeSkillRunAdapter {
  return {
    inspect: vi.fn(async (): Promise<CreativeSkillStepResult> => ({
      artifacts: [{ id: 'context-1', kind: 'context', summary: 'Read' }],
    })),
    observe: vi.fn(async (): Promise<CreativeSkillStepResult> => ({
      artifacts: [{ id: 'evidence-1', kind: 'evidence', summary: 'Read' }],
    })),
    propose: vi.fn(async (): Promise<CreativeSkillStepResult> => ({
      artifacts: [{ id: 'prepared-1', kind: 'prepared-change', summary: 'Prepared' }],
    })),
    preview: vi.fn(async (): Promise<CreativeSkillStepResult> => ({
      artifacts: [{ id: 'preview-1', kind: 'preview', summary: 'Shown' }],
    })),
    verify: vi.fn(async (): Promise<CreativeSkillStepResult> => ({
      artifacts: [{ id: 'verification-1', kind: 'verification', summary: 'Measured' }],
    })),
  };
}

describe('creative skill runner', () => {
  it('runs only the bounded declared checkpoints and stops before any apply authority', async () => {
    const events: string[] = [];
    const worker = adapter();
    const runner = createCreativeSkillRunner({
      runtime,
      adapter: worker,
      isAuthorityCurrent: () => true,
      now: () => '2026-09-06T00:00:00.000Z',
    });
    const result = await runner.run({
      skillId: 'build-rough-cut',
      scope: { projectId: 'project-1', runId: 'run-1', epoch: 1, revision: 'revision-1' },
      onEvent: (event) => events.push(`${event.state}:${event.checkpointId}`),
    });

    expect(result.kind).toBe('ready-for-approval');
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual([
      'context',
      'evidence',
      'prepared-change',
      'preview',
    ]);
    expect(events).toEqual([
      'started:inspect-targets',
      'completed:inspect-targets',
      'started:observe-sources',
      'completed:observe-sources',
      'started:prepare-rough-cut',
      'completed:prepare-rough-cut',
      'started:preview-rough-cut',
      'completed:preview-rough-cut',
    ]);
    expect(worker.inspect).toHaveBeenCalledTimes(1);
    expect(worker.observe).toHaveBeenCalledTimes(1);
    expect(worker.propose).toHaveBeenCalledTimes(1);
    expect(worker.preview).toHaveBeenCalledTimes(1);
    expect('apply' in worker).toBe(false);
  });

  it('does not run a recipe whose verified operation or adapter is unavailable', async () => {
    const worker = adapter();
    const runner = createCreativeSkillRunner({
      runtime: {
        ...runtime,
        operationDefinitions: JOY_EDITOR_OPERATION_DEFINITIONS.map((definition) =>
          definition.kind === 'timeline.trimClip'
            ? {
                ...definition,
                evidence: { ...definition.evidence, status: 'unsupported' as const },
              }
            : definition,
        ),
      },
      adapter: worker,
      isAuthorityCurrent: () => true,
    });
    await expect(
      runner.run({
        skillId: 'build-rough-cut',
        scope: { projectId: 'project-1', runId: 'run-1', epoch: 1, revision: 'revision-1' },
      }),
    ).resolves.toMatchObject({ kind: 'unavailable', missingOperations: ['timeline.trimClip'] });
    expect(worker.inspect).not.toHaveBeenCalled();

    const partialAdapter: CreativeSkillRunAdapter = {
      inspect: vi.fn(async (): Promise<CreativeSkillStepResult> => ({
        artifacts: [{ id: 'context-1', kind: 'context', summary: 'Read' }],
      })),
    };
    const adapterUnavailable = createCreativeSkillRunner({
      runtime,
      adapter: partialAdapter,
      isAuthorityCurrent: () => true,
    });
    await expect(
      adapterUnavailable.run({
        skillId: 'watch-and-map',
        scope: { projectId: 'project-1', runId: 'run-2', epoch: 1, revision: 'revision-1' },
      }),
    ).resolves.toMatchObject({ kind: 'blocked', reason: 'adapter-unavailable', artifacts: [] });
  });

  it('blocks stale or cancelled work after every async checkpoint instead of leaking a late artifact', async () => {
    let current = true;
    const worker = adapter();
    (worker.inspect as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      current = false;
      return {
        artifacts: [{ id: 'context-1', kind: 'context' as const, summary: 'Read' }],
      } satisfies CreativeSkillStepResult;
    });
    const runner = createCreativeSkillRunner({
      runtime,
      adapter: worker,
      isAuthorityCurrent: () => current,
    });
    await expect(
      runner.run({
        skillId: 'creative-brief',
        scope: { projectId: 'project-1', runId: 'run-1', epoch: 1, revision: 'revision-1' },
      }),
    ).resolves.toMatchObject({ kind: 'blocked', reason: 'stale-authority', artifacts: [] });
    expect(worker.propose).not.toHaveBeenCalled();
  });

  it('does not mislabel a no-op advisory recipe as an edit awaiting approval', async () => {
    const runner = createCreativeSkillRunner({
      runtime,
      adapter: adapter(),
      isAuthorityCurrent: () => true,
    });
    await expect(
      runner.run({
        skillId: 'watch-and-map',
        scope: { projectId: 'project-1', runId: 'run-1', epoch: 1, revision: 'revision-1' },
      }),
    ).resolves.toMatchObject({ kind: 'completed' });
  });

  it('rejects an untrusted artifact result and honours cancellation before an adapter is called', async () => {
    const worker = adapter();
    (worker.inspect as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      artifacts: [{ id: 'unsafe-1', kind: 'context', summary: 'https://example.invalid' }],
    });
    const runner = createCreativeSkillRunner({
      runtime,
      adapter: worker,
      isAuthorityCurrent: () => true,
    });
    await expect(
      runner.run({
        skillId: 'creative-brief',
        scope: { projectId: 'project-1', runId: 'run-1', epoch: 1, revision: 'revision-1' },
      }),
    ).resolves.toMatchObject({ kind: 'blocked', reason: 'invalid-artifact' });

    const controller = new AbortController();
    controller.abort();
    await expect(
      runner.run({
        skillId: 'creative-brief',
        scope: { projectId: 'project-1', runId: 'run-3', epoch: 1, revision: 'revision-1' },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ kind: 'blocked', reason: 'cancelled' });
  });
});
