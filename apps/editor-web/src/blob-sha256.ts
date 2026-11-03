import { createSha256 } from '@joy-media/workflow-engine';

/** How many bytes of a Blob are read at a time while it is hashed. */
const HASH_SLICE_BYTES = 8 * 1024 * 1024;

/**
 * SHA-256 of a Blob, as lowercase hex.
 *
 * The Blob is read in slices, so the whole file is never copied into script memory as one buffer.
 * The browser can only hash a whole buffer natively, so this uses the workflow engine's streaming
 * SHA-256; for the same bytes it gives the same digest that `crypto.subtle` would.
 */
export async function sha256OfBlob(
  blob: Blob,
  options: { readonly signal?: AbortSignal; readonly sliceBytes?: number } = {},
): Promise<string> {
  const hasher = createSha256();
  const sliceBytes = options.sliceBytes ?? HASH_SLICE_BYTES;
  if (!Number.isSafeInteger(sliceBytes) || sliceBytes <= 0)
    throw new RangeError('sliceBytes must be a positive safe integer');
  for (let offset = 0; offset < blob.size; offset += sliceBytes) {
    options.signal?.throwIfAborted();
    const slice = blob.slice(offset, Math.min(blob.size, offset + sliceBytes));
    hasher.update(new Uint8Array(await slice.arrayBuffer()));
  }
  options.signal?.throwIfAborted();
  return hasher.hexDigest();
}
