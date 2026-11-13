import type { ExportPresetId, JoyProjectV1 } from '@joy-media/project-schema';
import type { EditorSession } from './editor-session.js';
import { reframeProjectClips, type CanvasReframeMode } from './canvas-reframe.js';
import {
  EXPORT_PRESETS,
  exportPresetCanvasSize,
  exportPresetForCanvas,
  type CanvasSize,
} from './export-presets.js';

function updateRootCanvas(
  project: JoyProjectV1,
  size: CanvasSize,
  exportPreset: ExportPresetId,
): JoyProjectV1 {
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) throw new Error('The root composition is unavailable.');
  return {
    ...project,
    exportPreset,
    updatedAt: new Date().toISOString(),
    compositions: {
      ...project.compositions,
      [project.rootCompositionId]: {
        ...composition,
        width: size.width,
        height: size.height,
      },
    },
  };
}

function updateSessionFormat(
  session: EditorSession,
  size: CanvasSize,
  exportPreset: ExportPresetId,
  label: string,
  reframeMode: CanvasReframeMode = 'keep',
): boolean {
  const visualProject = session.visualProject;
  const visualRoot = visualProject.compositions[visualProject.rootCompositionId];
  const timelineRoot =
    session.timelineProject.compositions[session.timelineProject.rootCompositionId];
  if (visualRoot === undefined || timelineRoot === undefined)
    throw new Error('The root composition is unavailable.');

  const changed =
    visualRoot.width !== size.width ||
    visualRoot.height !== size.height ||
    visualProject.exportPreset !== exportPreset ||
    timelineRoot.width !== size.width ||
    timelineRoot.height !== size.height;
  if (!changed) return false;

  const document = updateRootCanvas(
    reframeProjectClips(visualProject, size, reframeMode),
    size,
    exportPreset,
  );
  const timeline =
    timelineRoot.width === size.width && timelineRoot.height === size.height
      ? undefined
      : {
          label,
          commands: [
            {
              type: 'timeline.setCompositionDimensions' as const,
              payload: {
                compositionId: session.timelineProject.rootCompositionId,
                width: size.width,
                height: size.height,
              },
            },
          ],
        };
  session.dispatchCompound(label, {
    document,
    ...(timeline === undefined ? {} : { timeline }),
  });
  return true;
}

export function applyExportPresetSelection(
  session: EditorSession,
  presetId: ExportPresetId,
  reframeMode: CanvasReframeMode = 'keep',
): boolean {
  const root = session.visualProject.compositions[session.visualProject.rootCompositionId];
  if (root === undefined) throw new Error('The root composition is unavailable.');
  const size = exportPresetCanvasSize(presetId, { width: root.width, height: root.height });
  return updateSessionFormat(
    session,
    size,
    presetId,
    `Change format to ${EXPORT_PRESETS[presetId].label}`,
    reframeMode,
  );
}

export function applyCanvasDimensions(
  session: EditorSession,
  width: number,
  height: number,
  label = `Change canvas to ${width}×${height}`,
  reframeMode: CanvasReframeMode = 'keep',
): boolean {
  const presetId = exportPresetForCanvas(width, height, session.visualProject.exportPreset);
  return updateSessionFormat(session, { width, height }, presetId, label, reframeMode);
}
