import { describe, expect, it } from 'vitest';
import { sniffMediaMime } from './media-mime-sniff.js';

function bytes(...parts: Array<number | string>): Uint8Array {
  const values: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      values.push(part);
      continue;
    }
    for (let index = 0; index < part.length; index += 1) {
      values.push(part.charCodeAt(index));
    }
  }
  return new Uint8Array(values);
}

describe('sniffMediaMime', () => {
  it('recognizes MP4 from an ftyp brand', () => {
    expect(sniffMediaMime(bytes(0, 0, 0, 24, 'ftyp', 'isom'))).toBe('video/mp4');
  });

  it('recognizes MOV from a QuickTime brand', () => {
    expect(sniffMediaMime(bytes(0, 0, 0, 24, 'ftyp', 'qt  '))).toBe('video/quicktime');
  });

  it.each(['M4A ', 'M4B '])('recognizes an audio MP4 brand %s', (brand) => {
    expect(sniffMediaMime(bytes(0, 0, 0, 24, 'ftyp', brand))).toBe('audio/mp4');
  });

  it('recognizes a 3GP brand as MP4 video', () => {
    expect(sniffMediaMime(bytes(0, 0, 0, 24, 'ftyp', '3gp4'))).toBe('video/mp4');
  });

  it.each(['heic', 'heix', 'mif1', 'msf1'])('recognizes HEIC brand %s', (brand) => {
    expect(sniffMediaMime(bytes(0, 0, 0, 24, 'ftyp', brand))).toBe('image/heic');
  });

  it.each(['avif', 'avis'])('recognizes AVIF brand %s', (brand) => {
    expect(sniffMediaMime(bytes(0, 0, 0, 24, 'ftyp', brand))).toBe('image/avif');
  });

  it('recognizes WebM and Matroska from the EBML signature', () => {
    expect(sniffMediaMime(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe('video/webm');
  });

  it('recognizes Ogg', () => {
    expect(sniffMediaMime(bytes('OggS'))).toBe('video/ogg');
  });

  it('recognizes WAV', () => {
    expect(sniffMediaMime(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBe('audio/wav');
  });

  it('recognizes WebP inside a RIFF container', () => {
    expect(sniffMediaMime(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('image/webp');
  });

  it('recognizes AVI inside a RIFF container', () => {
    expect(sniffMediaMime(bytes('RIFF', 0, 0, 0, 0, 'AVI '))).toBe('video/x-msvideo');
  });

  it('recognizes MP3 with an ID3 header', () => {
    expect(sniffMediaMime(bytes('ID3'))).toBe('audio/mpeg');
  });

  it('recognizes an MP3 frame sync', () => {
    expect(sniffMediaMime(bytes(0xff, 0xe0))).toBe('audio/mpeg');
  });

  it('recognizes FLAC', () => {
    expect(sniffMediaMime(bytes('fLaC'))).toBe('audio/flac');
  });

  it('recognizes PNG', () => {
    expect(sniffMediaMime(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
  });

  it('recognizes JPEG', () => {
    expect(sniffMediaMime(bytes(0xff, 0xd8, 0xff))).toBe('image/jpeg');
  });

  it.each(['GIF87a', 'GIF89a'])('recognizes GIF header %s', (header) => {
    expect(sniffMediaMime(bytes(header))).toBe('image/gif');
  });

  it('does not recognize BMP from its weak signature', () => {
    expect(sniffMediaMime(bytes('BM'))).toBeUndefined();
  });

  it('returns undefined for an empty array', () => {
    expect(sniffMediaMime(new Uint8Array())).toBeUndefined();
  });

  it('returns undefined for a PNG header that is too short', () => {
    expect(sniffMediaMime(bytes(0x89, 'PN'))).toBeUndefined();
  });

  it('returns undefined for random bytes', () => {
    expect(sniffMediaMime(bytes(0x12, 0x34, 0x56, 0x78))).toBeUndefined();
  });

  it('defaults unknown ftyp brands to MP4 video', () => {
    expect(sniffMediaMime(bytes(0, 0, 0, 24, 'ftyp', 'zzzz'))).toBe('video/mp4');
  });

  it('returns undefined for 32 zero bytes', () => {
    expect(sniffMediaMime(new Uint8Array(32))).toBeUndefined();
  });
});
