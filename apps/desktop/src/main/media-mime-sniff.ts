/** Returns a MIME type for a known media container from its first bytes, or undefined when not
 * recognised. */
export function sniffMediaMime(head: Uint8Array): string | undefined {
  if (head.length >= 12 && matchesAscii(head, 4, 'ftyp')) {
    if (matchesAscii(head, 8, 'qt  ')) return 'video/quicktime';
    if (matchesAscii(head, 8, 'M4A ') || matchesAscii(head, 8, 'M4B ')) return 'audio/mp4';
    if (
      matchesAscii(head, 8, 'heic') ||
      matchesAscii(head, 8, 'heix') ||
      matchesAscii(head, 8, 'mif1') ||
      matchesAscii(head, 8, 'msf1')
    ) {
      return 'image/heic';
    }
    if (matchesAscii(head, 8, 'avif') || matchesAscii(head, 8, 'avis')) return 'image/avif';
    return 'video/mp4';
  }

  if (matchesBytes(head, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (matchesAscii(head, 0, 'OggS')) return 'video/ogg';

  if (matchesAscii(head, 0, 'RIFF')) {
    if (matchesAscii(head, 8, 'WAVE')) return 'audio/wav';
    if (matchesAscii(head, 8, 'WEBP')) return 'image/webp';
    if (matchesAscii(head, 8, 'AVI ')) return 'video/x-msvideo';
  }

  if (matchesAscii(head, 0, 'ID3')) return 'audio/mpeg';
  if (head.length >= 2 && head[0] === 0xff) {
    const secondByte = head[1];
    if (secondByte !== undefined && (secondByte & 0xe0) === 0xe0) return 'audio/mpeg';
  }

  if (matchesAscii(head, 0, 'fLaC')) return 'audio/flac';
  if (matchesBytes(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (matchesBytes(head, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matchesAscii(head, 0, 'GIF87a') || matchesAscii(head, 0, 'GIF89a')) return 'image/gif';

  return undefined;
}

function matchesAscii(head: Uint8Array, offset: number, value: string): boolean {
  if (head.length < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (head[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function matchesBytes(head: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (head.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (head[offset + index] !== signature[index]) return false;
  }
  return true;
}
