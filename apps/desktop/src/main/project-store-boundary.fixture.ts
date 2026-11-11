/**
 * A typecheck fixture, not a test. The front door of the project-store package must resolve, and it must not export the
 * store's claim functions. The first import must typecheck. The directive records that the second import must fail. If
 * the second import ever typechecks, the directive is unused and the build fails. If the package does not resolve, the
 * first import fails and the build fails.
 */
import { runProjectFolderWorker } from '@joy-media/project-store';
// @ts-expect-error openProjectFolder is not on the front door of the project-store package.
import { openProjectFolder } from '@joy-media/project-store';

export const runner: unknown = runProjectFolderWorker;
export const notOnFrontDoor: unknown = openProjectFolder;
