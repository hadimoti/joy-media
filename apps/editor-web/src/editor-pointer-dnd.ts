import { hasExceededDragThreshold } from './timeline-clip-interaction.js';
import type { AnimationDescriptorV1 } from '@joy-media/project-schema';

export interface EditorPointerMediaAsset {
  readonly assetId: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly displayName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: {
    readonly mimeType: string;
    readonly durationUs?: number;
    readonly width?: number;
    readonly height?: number;
    readonly animation?: AnimationDescriptorV1;
  };
}

export type EditorPointerDragPayload =
  | {
      readonly kind: 'media';
      readonly asset: EditorPointerMediaAsset;
    }
  | { readonly kind: 'effect'; readonly effectId: string }
  | { readonly kind: 'transition'; readonly transitionId: string };

export type EditorPointerDropTarget =
  | {
      readonly kind: 'timeline-track';
      readonly element: HTMLElement;
      readonly trackId: string;
    }
  | {
      readonly kind: 'timeline-clip';
      readonly element: HTMLElement;
      readonly trackId: string;
      readonly clipId: string;
    }
  | {
      readonly kind: 'timeline-cut';
      readonly element: HTMLElement;
      readonly trackId: string;
      readonly leftClipId: string;
      readonly rightClipId: string;
    }
  | {
      readonly kind: 'timeline-runway';
      readonly element: HTMLElement;
      readonly family: 'visual' | 'audio';
    }
  | { readonly kind: 'timeline-empty'; readonly element: HTMLElement }
  | { readonly kind: 'monitor'; readonly element: HTMLElement }
  | { readonly kind: 'joy-code-attach'; readonly element: HTMLElement };

export interface EditorPointerDndHandlers {
  readonly onMove: (
    payload: EditorPointerDragPayload,
    target: EditorPointerDropTarget | undefined,
    event: PointerEvent | undefined,
  ) => void;
  readonly onDrop: (
    payload: EditorPointerDragPayload,
    target: EditorPointerDropTarget,
    event: PointerEvent,
  ) => void;
  readonly onEnd?: () => void;
}

interface RegisteredRoot {
  readonly handlers: EditorPointerDndHandlers;
}

interface ActiveDrag {
  readonly pointerId: number;
  readonly source: HTMLElement;
  readonly payload: EditorPointerDragPayload;
  readonly originX: number;
  readonly originY: number;
  started: boolean;
  targetElement: HTMLElement | undefined;
  rootElement: HTMLElement | undefined;
  handlers: EditorPointerDndHandlers | undefined;
  lastPointerEvent: PointerEvent | undefined;
}

const roots = new Map<HTMLElement, RegisteredRoot>();
let activeDrag: ActiveDrag | undefined;

/** Register a panel as a pointer-drop surface for its marked descendants. */
export function registerEditorPointerDndRoot(
  root: HTMLElement,
  handlers: EditorPointerDndHandlers,
): () => void {
  roots.set(root, { handlers });
  return () => {
    roots.delete(root);
    if (activeDrag?.rootElement === root) cancelActiveDrag();
  };
}

/** Begin a touch, pen, or mouse drag from an internal editor card. */
export function beginEditorPointerDrag(
  event: PointerEvent,
  source: HTMLElement,
  payload: EditorPointerDragPayload,
  options: { readonly allowInteractiveTarget?: boolean } = {},
): void {
  if (event.button !== 0 || activeDrag !== undefined) return;
  const eventTarget = event.target;
  if (
    eventTarget instanceof Element &&
    eventTarget.closest(
      options.allowInteractiveTarget === true
        ? 'input, select, textarea, label, [data-no-drag]'
        : 'button, input, select, textarea, label, [data-no-drag]',
    ) !== null
  ) {
    return;
  }

  const drag: ActiveDrag = {
    pointerId: event.pointerId,
    source,
    payload,
    originX: event.clientX,
    originY: event.clientY,
    started: false,
    targetElement: undefined,
    rootElement: undefined,
    handlers: undefined,
    lastPointerEvent: undefined,
  };
  activeDrag = drag;
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', cancelActiveDrag, true);
}

function onPointerMove(event: PointerEvent): void {
  const drag = activeDrag;
  if (drag === undefined || drag.pointerId !== event.pointerId) return;
  if (!drag.started) {
    if (!hasExceededDragThreshold(event.clientX - drag.originX, event.clientY - drag.originY))
      return;
    drag.started = true;
    drag.source.classList.add('editor-pointer-dnd-source-active');
    document.body.dataset.editorPointerDragging = drag.payload.kind;
    createDragHint(drag.payload);
  }

  drag.lastPointerEvent = event;
  event.preventDefault();
  moveDragHint(event.clientX, event.clientY);
  const location = rootAtPoint(event.clientX, event.clientY);
  if (drag.targetElement !== location?.targetElement) {
    if (drag.targetElement !== undefined) delete drag.targetElement.dataset.editorPointerDndOver;
    drag.targetElement = location?.targetElement;
    if (drag.targetElement !== undefined) drag.targetElement.dataset.editorPointerDndOver = 'true';
  }
  if (drag.rootElement !== location?.rootElement) {
    drag.handlers?.onMove(drag.payload, undefined, event);
    drag.rootElement = location?.rootElement;
    drag.handlers = location?.handlers;
  }
  drag.handlers?.onMove(drag.payload, location?.target, event);
}

function onPointerUp(event: PointerEvent): void {
  const drag = activeDrag;
  if (drag === undefined || drag.pointerId !== event.pointerId) return;
  if (drag.started) {
    event.preventDefault();
    const location = rootAtPoint(event.clientX, event.clientY);
    try {
      suppressClickAtPoint(event.clientX, event.clientY);
      if (location?.target !== undefined) {
        location.handlers.onDrop(drag.payload, location.target, event);
      }
    } finally {
      finishActiveDrag();
    }
    return;
  }
  finishActiveDrag();
}

function suppressClickAtPoint(x: number, y: number): void {
  const listener = (event: MouseEvent) => {
    if (Math.abs(event.clientX - x) > 1 || Math.abs(event.clientY - y) > 1) return;
    event.preventDefault();
    event.stopPropagation();
    document.removeEventListener('click', listener, true);
  };
  document.addEventListener('click', listener, true);
  window.setTimeout(() => document.removeEventListener('click', listener, true), 0);
}

function onPointerCancel(event: PointerEvent): void {
  if (activeDrag?.pointerId === event.pointerId) cancelActiveDrag();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || activeDrag === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  cancelActiveDrag();
}

function cancelActiveDrag(): void {
  if (activeDrag === undefined) return;
  try {
    activeDrag.handlers?.onMove(activeDrag.payload, undefined, activeDrag.lastPointerEvent);
  } finally {
    finishActiveDrag();
  }
}

function finishActiveDrag(): void {
  const drag = activeDrag;
  if (drag === undefined) return;
  const onEnd = drag.handlers?.onEnd;
  if (drag.targetElement !== undefined) delete drag.targetElement.dataset.editorPointerDndOver;
  drag.source.classList.remove('editor-pointer-dnd-source-active');
  delete document.body.dataset.editorPointerDragging;
  document.querySelector('.editor-pointer-dnd-hint')?.remove();
  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  document.removeEventListener('pointercancel', onPointerCancel, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('blur', cancelActiveDrag, true);
  activeDrag = undefined;
  onEnd?.();
}

function rootAtPoint(
  x: number,
  y: number,
):
  | {
      readonly rootElement: HTMLElement;
      readonly targetElement: HTMLElement | undefined;
      readonly target: EditorPointerDropTarget | undefined;
      readonly handlers: EditorPointerDndHandlers;
    }
  | undefined {
  const hit = document.elementFromPoint(x, y);
  if (!(hit instanceof Element)) return undefined;
  const rootElement = hit.closest<HTMLElement>('[data-editor-pointer-dnd-root]');
  if (rootElement === null) return undefined;
  const handlers = roots.get(rootElement)?.handlers;
  if (handlers === undefined) return undefined;
  const targetElement = hit.closest<HTMLElement>('[data-editor-pointer-dnd-target]');
  if (targetElement === null || !rootElement.contains(targetElement)) {
    return { rootElement, targetElement: undefined, target: undefined, handlers };
  }
  const target = parseDropTarget(targetElement);
  return { rootElement, targetElement, target, handlers };
}

function parseDropTarget(element: HTMLElement): EditorPointerDropTarget | undefined {
  const kind = element.dataset.editorPointerDndTarget;
  if (kind === 'monitor' || kind === 'joy-code-attach') return { kind, element };
  if (kind === 'timeline-empty') return { kind, element };
  if (kind === 'timeline-runway') {
    const family = element.closest<HTMLElement>('.timeline-runway')?.dataset.trackFamily;
    if (family === 'visual' || family === 'audio') return { kind, element, family };
    return undefined;
  }
  if (kind === 'timeline-cut') {
    const trackId = element.dataset.trackId;
    const leftClipId = element.dataset.leftClipId;
    const rightClipId = element.dataset.rightClipId;
    if (trackId !== undefined && leftClipId !== undefined && rightClipId !== undefined) {
      return { kind, element, trackId, leftClipId, rightClipId };
    }
    return undefined;
  }
  if (kind === 'timeline-track' || kind === 'timeline-clip') {
    const trackId =
      element.dataset.trackId ?? element.closest<HTMLElement>('.timeline-lane')?.dataset.trackId;
    if (trackId === undefined) return undefined;
    if (kind === 'timeline-clip') {
      const clipId = element.dataset.clipId;
      if (clipId === undefined) return undefined;
      return { kind, element, trackId, clipId };
    }
    return { kind, element, trackId };
  }
  return undefined;
}

function createDragHint(payload: EditorPointerDragPayload): void {
  const hint = document.createElement('div');
  hint.className = 'editor-pointer-dnd-hint';
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  hint.textContent =
    payload.kind === 'media'
      ? 'Ctrl: insert · Alt: replace clip'
      : payload.kind === 'effect'
        ? 'Drop on a clip or the Monitor'
        : 'Drop on a cut between clips';
  document.body.append(hint);
}

function moveDragHint(x: number, y: number): void {
  const hint = document.querySelector<HTMLElement>('.editor-pointer-dnd-hint');
  if (hint === null) return;
  hint.style.left = `${x + 14}px`;
  hint.style.top = `${y + 16}px`;
}
