import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThreeDStudioChat } from './ThreeDStudioChat.js';
import { ThreeDStudioHierarchy } from './ThreeDStudioHierarchy.js';
import { emptyScene3D } from '@joy-media/scene3d-core';
import type { BrowserAsset } from '../control-plane-client.js';

const MODEL: BrowserAsset = {
  id: 'model-1',
  projectId: 'project-1',
  kind: 'model',
  displayName: 'hero.glb',
  sha256: 'a'.repeat(64),
  bytes: 1,
  descriptor: { mimeType: 'model/gltf-binary' },
  createdAt: 1,
};

describe('3D studio surfaces', () => {
  it('keeps chat as a proposal surface', () => {
    const markup = renderToStaticMarkup(<ThreeDStudioChat />);
    expect(markup).toContain('drafts proposals only');
    expect(markup).toContain('Draft proposal');
  });
  it('exposes hierarchy actions without mutating the document directly', () => {
    const markup = renderToStaticMarkup(
      <ThreeDStudioHierarchy
        document={emptyScene3D('scene-1')}
        assets={[MODEL]}
        selectedObjectId={undefined}
        onSelect={() => undefined}
        onAdd={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(markup).toContain('Add model');
    expect(markup).toContain('Delete selected');
  });
});
