export interface DisposableWorkerController {
  dispose(): Promise<void>;
}

/** Keep the quit path asynchronous so the Worker tree is terminated before Electron exits. */
export async function disposeWorkerForQuit(
  controller: DisposableWorkerController | undefined,
): Promise<void> {
  await controller?.dispose();
}
