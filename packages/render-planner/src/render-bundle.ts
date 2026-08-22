import type { ExportPresetId, JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { OpaqueAssetDescriptor, RenderBundleV1 } from './types.js';

export interface CreateRenderBundleInput {
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly compositionId?: string;
  readonly outputPreset?: ExportPresetId | 'preview';
  readonly seed: string;
  readonly assets?: Readonly<Record<string, OpaqueAssetDescriptor>>;
}

export function createRenderBundle(input: CreateRenderBundleInput): RenderBundleV1 {
  const assets = input.assets ?? assetDescriptorsFromProject(input.visualProject);
  assertOpaqueDescriptors(assets);
  return {
    version: 1,
    timelineProject: input.timelineProject,
    visualProject: input.visualProject,
    compositionId: input.compositionId ?? input.visualProject.rootCompositionId,
    outputPreset: input.outputPreset ?? input.visualProject.exportPreset ?? 'preview',
    seed: input.seed,
    assets,
  };
}

export function assetDescriptorsFromProject(
  project: JoyProjectV1,
): Readonly<Record<string, OpaqueAssetDescriptor>> {
  const descriptors: Record<string, OpaqueAssetDescriptor> = {};
  for (const asset of Object.values(project.assets)) {
    descriptors[asset.id] = {
      id: asset.id,
      kind: asset.kind,
      displayName: asset.displayName,
      opaqueRef: `asset:${asset.id}`,
      availability: 'ready',
    };
  }
  for (const object of Object.values(project.visualObjects)) {
    if (object.kind === 'html-scene' && object.scenePackageId !== undefined) {
      const id = `html-scene:${object.scenePackageId}`;
      descriptors[id] = {
        id,
        kind: 'html-scene',
        displayName: object.scenePackageId,
        opaqueRef: `html-scene:${object.scenePackageId}`,
        availability: 'ready',
      };
    }
    if (object.kind === 'motion-scene' && object.motionSceneId !== undefined) {
      const id = `motion-scene:${object.motionSceneId}`;
      descriptors[id] = {
        id,
        kind: 'motion-scene',
        displayName: object.motionSceneId,
        opaqueRef: `motion-scene:${object.motionSceneId}`,
        availability: 'ready',
      };
    }
  }
  return descriptors;
}

function assertOpaqueDescriptors(assets: Readonly<Record<string, OpaqueAssetDescriptor>>): void {
  for (const descriptor of Object.values(assets)) {
    if (looksLikeLocalPath(descriptor.opaqueRef)) {
      throw new Error(
        `asset descriptor "${descriptor.id}" must use an opaque ref, not a local path`,
      );
    }
  }
}

function looksLikeLocalPath(value: string): boolean {
  return (
    value.startsWith('file:') ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  );
}
