/**
 * The Program Monitor's "Media offline" note, shown while the video clip at the playhead has a
 * missing file (T-R03). It is a small corner card and never covers the stage: pointer events are off,
 * so the picture, the layers beneath it and the monitor handles stay usable.
 */
export function MediaOfflineNote({ name }: { readonly name: string }) {
  return (
    <div className="monitor-media-offline" role="status" data-monitor-media-offline="">
      <strong>Media offline</strong>
      <span dir="ltr">{name}</span>
    </div>
  );
}
