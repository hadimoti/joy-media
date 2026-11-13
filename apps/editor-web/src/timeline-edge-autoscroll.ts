export interface TimelineEdgeAutoScrollFrameScheduler {
  readonly request: (callback: FrameRequestCallback) => number;
  readonly cancel: (frameId: number) => void;
}

export interface TimelineEdgeAutoScrollLoop {
  /** Update the pointer location while its source drag is active. */
  readonly move: (clientX: number, clientY: number) => void;
  /** Stop the loop and cancel its pending animation frame. */
  readonly stop: () => void;
}

/** Repeats edge scrolling while a pointer remains in the timeline edge zone. */
export function createTimelineEdgeAutoScrollLoop(
  scrollAtPointer: (clientX: number, clientY: number) => number | undefined,
  scheduler: TimelineEdgeAutoScrollFrameScheduler = {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (frameId) => cancelAnimationFrame(frameId),
  },
): TimelineEdgeAutoScrollLoop {
  let pointer: { readonly clientX: number; readonly clientY: number } | undefined;
  let frameId: number | undefined;

  const tick: FrameRequestCallback = () => {
    frameId = undefined;
    const current = pointer;
    if (current === undefined) return;
    if (scrollAtPointer(current.clientX, current.clientY) === undefined || pointer === undefined) {
      pointer = undefined;
      return;
    }
    frameId = scheduler.request(tick);
  };

  const stop = () => {
    pointer = undefined;
    if (frameId !== undefined) {
      scheduler.cancel(frameId);
      frameId = undefined;
    }
  };

  return {
    move(clientX, clientY) {
      pointer = { clientX, clientY };
      if (frameId === undefined) frameId = scheduler.request(tick);
    },
    stop,
  };
}
