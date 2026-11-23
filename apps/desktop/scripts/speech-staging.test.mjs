import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageSpeechRunners } from './speech-staging.mjs';

test('stages only the three allowed JOY speech entrypoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'joy-speech-stage-'));
  const source = join(root, 'source');
  const destination = join(root, 'unpacked', 'speech');
  const expected = ['synthesize_chatterbox.py', 'synthesize_kokoro.py', 'transcribe.py'];
  try {
    await mkdir(source);
    for (const folder of ['__pycache__', '.venv']) await mkdir(join(source, folder));
    for (const name of [...expected, 'test_transcribe.py', 'model.safetensors', 'ffmpeg.exe']) {
      await writeFile(join(source, name), `fixture:${name}`);
    }
    await stageSpeechRunners(source, destination);
    assert.deepEqual((await readdir(destination)).sort(), expected);
    for (const name of expected)
      assert.equal(await readFile(join(destination, name), 'utf8'), `fixture:${name}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
