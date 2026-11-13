/**
 * The limits and defaults of the MiniMax picture and video routes (T-C02). They are settings, so T-C10 can correct
 * them after one live check on the owner's key, without a change to the adapters.
 *
 * Sources: master plan facts P4 to P9 (MiniMax pages, read 12 Nov 2026). A value marked UNVERIFIED is a JOY default or
 * a field name the facts do not name; the live check (T-C10) settles it.
 */
export const MINIMAX_GENERATION_SETTINGS = {
  image: {
    /** P4: the current picture model. */
    model: 'MiniMax-H3-Image',
    /** P4: the picture answer is requested as base64, so the picture comes back inside the reply and no second host is needed. */
    responseFormat: 'b64_json',
    /** P5: the legacy picture model. */
    legacyModel: 'image-01',
    /** UNVERIFIED: the legacy field value for base64 answers. */
    legacyResponseFormat: 'base64',
    /** UNVERIFIED: a JOY default, not taken from the docs. */
    maxPromptCharacters: 1500,
  },
  video: {
    /** P7: the cheapest current model the facts name. */
    model: 'MiniMax-H3-Lite',
    /** P7: 480P is the smallest resolution named. */
    resolution: '480P',
    /** P7: 4 seconds is the shortest length the cheapest price names. */
    durationSeconds: 4,
    /** P8: the legacy video model. */
    legacyModel: 'MiniMax-Hailuo-02',
    /** P8: the legacy resolution. */
    legacyResolution: '512P',
    /** P8: the legacy length. */
    legacyDurationSeconds: 6,
    /** P6: a task is queried every 10 seconds. The job manager reads this value. */
    pollIntervalMs: 10_000,
    /** UNVERIFIED: a JOY default, not taken from the docs. */
    maxPromptCharacters: 2000,
  },
  /**
   * The watermark rule is not yet known for the API (P4 to P9 leave it open). No watermark field is sent until T-C10
   * measures what the key gets.
   */
  watermark: 'provider-default',
} as const;
