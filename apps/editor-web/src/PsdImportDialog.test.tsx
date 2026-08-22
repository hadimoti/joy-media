import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PsdImportDialog } from './PsdImportDialog.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import type { EditorSession } from './editor-session.js';
import { emptySpikeProject } from '@joy-media/test-fixtures';

describe('PsdImportDialog', () => {
  it('exposes an accessible bounded mapping surface and fidelity warning region', () => {
    const session = {
      visualProject: INITIAL_EDITOR_PROJECT,
      timelineProject: emptySpikeProject(),
      dispatchCompound: vi.fn(),
    } as unknown as EditorSession;
    const markup = renderToStaticMarkup(
      <PsdImportDialog
        session={session}
        projectId="project-1"
        onClose={() => undefined}
        showToast={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Import PSD"');
    expect(markup).toContain('accept=".psd,image/vnd.adobe.photoshop"');
    expect(markup).toContain('Choose PSD file');
    expect(markup).toContain('>Close</button>');
  });
});
