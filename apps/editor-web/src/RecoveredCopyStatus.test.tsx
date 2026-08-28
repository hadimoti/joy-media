import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecoveredCopyStatus } from './RecoveredCopyStatus.js';

describe('RecoveredCopyStatus', () => {
  it('surfaces the saved name and accessible open action without exposing opaque ids', () => {
    const sourceProjectId = 'source-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const recoveredProjectId = 'recovered-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const markup = renderToStaticMarkup(
      <RecoveredCopyStatus
        copy={{
          kind: 'recovered-copy',
          projectId: recoveredProjectId,
          name: 'Campaign (Recovered copy)',
          document: { schemaVersion: 2, projectId: recoveredProjectId },
          basedOnRevision: 2,
          serverRevision: 4,
          createdAt: '2026-08-26T00:00:00.000Z',
          provenance: {
            sourceProjectId,
            baseRevision: 2,
            sourceHeadRevision: 4,
            operation: { kind: 'restore', targetRevision: 2 },
            requestedDocumentHash: 'sha256-requested',
          },
        }}
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain(
      'Saved recovered copy “<bdi dir="auto">Campaign (Recovered copy)</bdi>”',
    );
    expect(markup).toContain('Open recovered copy');
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain(sourceProjectId);
    expect(markup).not.toContain(recoveredProjectId);
  });

  it('isolates mixed-direction recovered names with automatic bidi direction', () => {
    const markup = renderToStaticMarkup(
      <RecoveredCopyStatus
        copy={{
          kind: 'recovered-copy',
          projectId: 'recovered-project',
          name: 'نسخه Campaign-01',
          document: { schemaVersion: 2, projectId: 'recovered-project' },
          basedOnRevision: 2,
          serverRevision: 4,
          createdAt: '2026-08-26T00:00:00.000Z',
          provenance: {
            sourceProjectId: 'source-project',
            baseRevision: 2,
            sourceHeadRevision: 4,
            operation: { kind: 'restore', targetRevision: 2 },
            requestedDocumentHash: 'sha256-requested',
          },
        }}
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain('“<bdi dir="auto">نسخه Campaign-01</bdi>”');
  });
});
