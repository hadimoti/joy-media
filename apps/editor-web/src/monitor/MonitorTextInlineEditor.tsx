import { useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_TEXT_STYLE_V1,
  resolveContentFontFamily,
  textDocumentToString,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import type { MonitorOverlay } from './monitor-overlay-model.js';
import type { MonitorViewState } from './monitor-view-state.js';

/** A textarea positioned over the rendered title; saving uses TextPanel's document shape. */
export function MonitorTextInlineEditor({
  object,
  overlay,
  view,
  onCommit,
  onClose,
}: {
  readonly object: VisualObjectV1;
  readonly overlay: MonitorOverlay;
  readonly view: MonitorViewState;
  readonly onCommit: (text: string) => void;
  readonly onClose: () => void;
}) {
  const document = object.textDocument ?? {
    version: 1 as const,
    blocks: [{ id: 'text-block-1', runs: [{ text: object.text ?? '' }] }],
  };
  const [draftText, setDraftText] = useState(() => textDocumentToString(document));
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const committedRef = useRef(false);
  useLayoutEffect(() => editorRef.current?.focus(), []);

  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = overlay.localToCanvas;
  const width = Math.hypot(a, b);
  const height = Math.hypot(c, d);
  if (width <= 0 || height <= 0) return null;
  const font = object.textStyle ?? DEFAULT_TEXT_STYLE_V1;
  const fill = font.fill.kind === 'solid' ? font.fill.color : (font.fill.stops[0]?.color ?? '#fff');
  const finish = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(draftText);
    onClose();
  };

  return (
    <textarea
      ref={editorRef}
      className="monitor-inline-text-editor"
      data-monitor-text-editor=""
      aria-label="Edit text on Monitor"
      value={draftText}
      dir={font.direction}
      wrap="soft"
      spellCheck={false}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width,
        height,
        transformOrigin: 'top left',
        transform: `matrix(${(a * view.zoom) / width}, ${(b * view.zoom) / width}, ${(c * view.zoom) / height}, ${(d * view.zoom) / height}, ${e * view.zoom + view.panX}, ${f * view.zoom + view.panY})`,
        boxSizing: 'border-box',
        margin: 0,
        padding: 0,
        resize: 'none',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        background: 'rgb(16 18 21 / 72%)',
        border: '2px solid var(--joy-accent)',
        borderRadius: '2px',
        color: fill,
        fontFamily: resolveContentFontFamily(font.fontFamily),
        fontSize: `${font.fontSizePx}px`,
        fontWeight: font.fontWeight,
        fontStyle: font.italic ? 'italic' : 'normal',
        lineHeight: font.lineHeight,
        letterSpacing: `${font.tracking}px`,
        textAlign: font.align,
        zIndex: 20,
      }}
      onChange={(event) => setDraftText(event.currentTarget.value)}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish();
        }
      }}
    />
  );
}
