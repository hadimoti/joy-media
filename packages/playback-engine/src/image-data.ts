/**
 * Structural mirror of the browser `ImageData` so the playback engine can
 * carry decoded pixel data without pulling in a DOM lib. The editor-side
 * caller hands a real `ImageData` in and the type is structurally compatible.
 */
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  /** RGBA pixel data, length === width * height * 4. */
  readonly data: Uint8ClampedArray;
}
