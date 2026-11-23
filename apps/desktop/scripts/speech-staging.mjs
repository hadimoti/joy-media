import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const SPEECH_RUNNER_FILES = ['transcribe.py', 'synthesize_kokoro.py', 'synthesize_chatterbox.py'];

/** Stage only JOY-authored entrypoint scripts; local environments and model data stay opt-in. */
export async function stageSpeechRunners(sourceDir, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  for (const name of SPEECH_RUNNER_FILES) {
    await cp(resolve(sourceDir, name), resolve(destinationDir, name));
  }
}
