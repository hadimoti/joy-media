import type { DecodedFrame } from './index.js';
export interface MediaSource {
  readonly assetId: string;
  readonly originalToken: string;
  readonly proxyToken?: string;
}
export interface FrameDecoder {
  decode(sourceToken: string, sourceTimeUs: number, requestToken: number): Promise<DecodedFrame>;
}
export function selectDecodeSource(source: MediaSource, quality: 'full' | 'proxy'): string {
  return quality === 'proxy' && source.proxyToken !== undefined
    ? source.proxyToken
    : source.originalToken;
}
/** Requests use scheduler generations so a seek cancels stale asynchronous decoder answers. */
export async function requestDecodedFrame(
  decoder: FrameDecoder,
  source: MediaSource,
  sourceTimeUs: number,
  requestToken: number,
  quality: 'full' | 'proxy',
): Promise<DecodedFrame> {
  return decoder.decode(selectDecodeSource(source, quality), sourceTimeUs, requestToken);
}
