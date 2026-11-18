/**
 * Thrown when a project asset has no file in this profile: it is not in the local original cache, it is
 * not a bundled reference clip, and no desktop library file answers for it. The export names such clips
 * in plain words (T-R04) instead of showing the internal resolve message.
 */
export class MediaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaUnavailableError';
  }
}
