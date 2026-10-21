import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, describeRun, type Sandbox } from './harness.js';
import { cliSchemaErrors } from './schema-validation.js';

function expectSchema(schemaFile: string, value: unknown): void {
  const errors = cliSchemaErrors(schemaFile, value);
  expect(errors, `${schemaFile}: ${errors.join('; ')}`).toEqual([]);
}

describe.each(['bin', 'bundle'] as const)('versioned CLI output schemas via %s', (entry) => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = createSandbox(`cli-schemas-${entry}`);
  });
  afterEach(() => sb.cleanup());

  it('validates help, errors, doctor, project, timeline, and render output', async () => {
    const help = await sb.run(['help'], { entry });
    expect(help.code, describeRun(help)).toBe(0);
    expectSchema('help-text.v1.schema.json', help.stdout);

    const failedEdit = await sb.run(
      [
        'timeline',
        'remove-clip',
        '--project',
        'missing-project',
        '--clip',
        'missing-clip',
        '--json',
      ],
      { entry },
    );
    expect(failedEdit.code, describeRun(failedEdit)).toBe(1);
    expectSchema('command-error.v1.schema.json', failedEdit.json());

    const doctor = await sb.run(['doctor', '--json'], {
      entry,
      env: { JOY_MEDIA_EDGE_URL: 'off' },
    });
    expect(doctor.code, describeRun(doctor)).toBe(0);
    expectSchema('doctor-report.v1.schema.json', doctor.json());

    const created = await sb.run(['project', 'create', 'Schema Contract', '--json'], { entry });
    expect(created.code, describeRun(created)).toBe(0);
    const createdDoc = created.json<{ id: string }>();
    expectSchema('project-create.v1.schema.json', createdDoc);

    const listed = await sb.run(['project', 'list', '--json'], { entry });
    expect(listed.code, describeRun(listed)).toBe(0);
    expectSchema('project-list.v1.schema.json', listed.json());

    const shown = await sb.run(['project', 'show', createdDoc.id, '--json'], { entry });
    expect(shown.code, describeRun(shown)).toBe(0);
    expectSchema('project-show.v1.schema.json', shown.json());

    const projectFile = sb.path('portable project فارسی.json');
    const exported = await sb.run(
      ['project', 'export', createdDoc.id, '--output', projectFile, '--json'],
      { entry },
    );
    expect(exported.code, describeRun(exported)).toBe(0);
    expectSchema('project-transfer.v1.schema.json', exported.json());

    const imported = await sb.run(['project', 'import', projectFile, '--json'], { entry });
    expect(imported.code, describeRun(imported)).toBe(0);
    expectSchema('project-transfer.v1.schema.json', imported.json());

    const added = await sb.run(
      ['timeline', 'add-clip', '--project', createdDoc.id, '--duration', '3', '--json'],
      { entry },
    );
    expect(added.code, describeRun(added)).toBe(0);
    expectSchema('timeline-mutation.v1.schema.json', added.json());
    const clipId = added.json<{ clip: { id: string } }>().clip.id;

    const split = await sb.run(
      ['timeline', 'split', '--project', createdDoc.id, '--clip', clipId, '--at', '1.5', '--json'],
      { entry },
    );
    expect(split.code, describeRun(split)).toBe(0);
    expectSchema('timeline-mutation.v1.schema.json', split.json());
    const secondClip = split.json<{ clips: Array<{ id: string }> }>().clips[1]!.id;

    const trimmed = await sb.run(
      ['timeline', 'trim', '--project', createdDoc.id, '--clip', clipId, '--end', '0.75', '--json'],
      { entry },
    );
    expect(trimmed.code, describeRun(trimmed)).toBe(0);
    expectSchema('timeline-mutation.v1.schema.json', trimmed.json());

    const removed = await sb.run(
      ['timeline', 'remove-clip', '--project', createdDoc.id, '--clip', secondClip, '--json'],
      { entry },
    );
    expect(removed.code, describeRun(removed)).toBe(0);
    expectSchema('timeline-mutation.v1.schema.json', removed.json());

    const plan = await sb.run(
      [
        'render',
        '--project',
        createdDoc.id,
        '--out',
        sb.path('plan-only'),
        '--manifest-only',
        '--json',
      ],
      { entry },
    );
    expect(plan.code, describeRun(plan)).toBe(0);
    const planEvents = plan.ndjson();
    for (const event of planEvents) expectSchema('render-event.v1.schema.json', event);
    expect(planEvents.at(-1)).toMatchObject({ type: 'complete', mediaProduced: false });

    const renderFailure = await sb.run(['render', '--project', 'missing-project', '--json'], {
      entry,
    });
    expect(renderFailure.code, describeRun(renderFailure)).toBe(1);
    for (const event of renderFailure.ndjson()) expectSchema('render-event.v1.schema.json', event);
    expect(renderFailure.ndjson().at(-1)).toMatchObject({ type: 'error' });
  }, 60_000);
});
