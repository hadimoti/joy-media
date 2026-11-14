const MAX_TITLE_CHARS = 40;

interface TitleObject {
  readonly kind?: string;
  readonly text?: string | undefined;
  readonly textDocument?:
    | { readonly blocks: readonly { readonly runs: readonly { readonly text: string }[] }[] }
    | undefined;
}

/**
 * The name the Inspector header shows for the selected clip: the media's file name, else the words of a text
 * clip, else the kind of element ("Sticker"). Never the clip's internal id.
 */
export function inspectorClipTitle(input: {
  readonly assetName?: string | undefined;
  readonly object?: TitleObject | undefined;
  readonly kindLabel?: string | undefined;
}): string {
  if (input.assetName !== undefined && input.assetName.trim().length > 0) return input.assetName;
  const object = input.object;
  if (object?.kind === 'text') {
    const fromDocument = (object.textDocument?.blocks ?? [])
      .map((block) => block.runs.map((run) => run.text).join(''))
      .join(' ');
    const words = (fromDocument.trim().length > 0 ? fromDocument : (object.text ?? ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (words.length > 0) {
      return words.length > MAX_TITLE_CHARS ? `${words.slice(0, MAX_TITLE_CHARS - 1)}…` : words;
    }
  }
  return input.kindLabel !== undefined && input.kindLabel.length > 0 ? input.kindLabel : 'Clip';
}
