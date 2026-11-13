export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_GENERATED_VIDEO_BYTES = 512 * 1024 * 1024;

/** Jobs of one kind that may be queued, running or downloading at the same time. */
export const MAX_ACTIVE_GENERATED_IMAGE_JOBS = 2;
export const MAX_ACTIVE_GENERATED_VIDEO_JOBS = 1;

/** A video download may take five minutes overall and must send a byte at least every 30 seconds. */
export const GENERATION_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
export const GENERATION_DOWNLOAD_IDLE_TIMEOUT_MS = 30 * 1000;

/** A video job fails after this many failed status checks in a row. */
export const GENERATION_STATUS_ERROR_LIMIT = 3;

/** Base64 needs 4/3 the output bytes; the small allowance covers the JSON envelope. */
export const MAX_GENERATED_IMAGE_RESPONSE_BYTES =
  Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) + 64 * 1024;
