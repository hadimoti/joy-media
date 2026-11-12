/**
 * The names the project-folder service may use from the store. The owner approved this list on 11 Nov 2026. The service
 * imports only from this file, and a test pins the names it exports, so a name added here is seen.
 *
 * 12 Nov 2026 (lane B, under the owner's autonomy grant): the four editing names from project-folder-editing.ts were
 * added, so a folder that `openProjectFolderForEditing` settled can be loaded and saved. None of them opens a folder by
 * path: each takes the folder the claim handed out.
 */
export {
  ProjectClaimBusyError,
  ProjectClaimRefusedError,
  ProjectClaimRollbackError,
  ProjectRecordRefusedError,
  answerProjectFolderAsk,
  openProjectFolderForEditing,
  projectPlaceRefusal,
  recordNewProjectFolder,
  restoreProjectFolderRecord,
} from './project-folder-identity.js';
export type { ProjectFolderClaim } from './project-folder-identity.js';
export {
  createProjectFolder,
  listProjectFolders,
  projectFolderName,
  readProjectFolderEntry,
} from './project-folder.js';
export type { ProjectFolder, ProjectFolderEntry, ProjectFolderListing } from './project-folder.js';
export type { ProjectClaimRegistry } from './project-claim-registry.js';
export { describeVolumeAnswer } from './project-volume.js';
export {
  projectFolderMediaStates,
  readProjectFolderDocument,
  readProjectFolderMedia,
  saveProjectFolder,
} from './project-folder-editing.js';
export type { ProjectFolderSave, ProjectFolderSaveResult } from './project-folder-editing.js';
