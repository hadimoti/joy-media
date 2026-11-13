export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_GENERATED_VIDEO_BYTES = 512 * 1024 * 1024;

/** Base64 needs 4/3 the output bytes; the small allowance covers the JSON envelope. */
export const MAX_GENERATED_IMAGE_RESPONSE_BYTES =
  Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) + 64 * 1024;
