import processingIconUrl from './brand-assets/joy-code-processing.png';

export function JoyCodeProcessingIcon({ processing }: { readonly processing: boolean }) {
  if (!processing) return null;
  return (
    <img
      className="joy-code-processing-icon"
      src={processingIconUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
