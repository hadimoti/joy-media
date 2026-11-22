# JOY Local Speech runners: offline setup and licensing

This is the setup note for the local speech path on a paired Local Worker. It
describes what the integrated code reads and runs. It contains no bootstrap or
download scripts and sets no build options. How the runners are packaged for
users is an **owner decision**, not settled here.

Related code: [`local-speech.ts`](../src/local-speech.ts),
[`local-masking.ts`](../src/local-masking.ts) (`killProcessTree`),
[`runtime.ts`](../src/runtime.ts) (capability advertising),
[`speech.ts`](../../../packages/job-protocol/src/speech.ts) (protocol and model IDs).
Masking setup follows the same pattern: [`masking/README.md`](../masking/README.md).

Example paths below are placeholders outside the repo. Use your own locations.

## 1. Owner decisions and known gaps

| Item                                                                                                             | State                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installer packaging of Python, models, and runners                                                               | **Owner decision.** Not designed here.                                                                                                              |
| Four env names from the brief (`..._STT_PYTHON`, `..._TTS_PYTHON`, `..._RUNNER_DIR`, `..._MODEL_DIR`)            | **Not what the integrated code reads.** See section 3.                                                                                              |
| Separate STT and TTS Python executables                                                                          | **Not wired.** `local-speech.ts` uses one `JOY_MEDIA_SPEECH_PYTHON` for every runner. Separate interpreters need a source change and an owner call. |
| Desktop test names (`JOY_MEDIA_SPEECH_WHISPER_PYTHON`, `..._TTS_PYTHON`, `..._WHISPER_SCRIPT`, `..._TTS_SCRIPT`) | Appear only in [`worker-env.test.ts`](../../desktop/src/jobs/worker-env.test.ts) as inherited pass-through. The worker does not read them.          |
| Upstream licenses                                                                                                | **Not verified** in this session (see section 9).                                                                                                   |
| Measured cold-start time and VRAM                                                                                | **Not recorded** in the repo. Measure on the target GPU before quoting numbers.                                                                     |

## 2. Model IDs (integrated source)

| Model ID                        | Job type            | Language         | Notes                                                           |
| ------------------------------- | ------------------- | ---------------- | --------------------------------------------------------------- |
| `faster-whisper-large-v3-turbo` | `speech.transcribe` | `fa-IR`, `en-US` | Also used for post-TTS alignment.                               |
| `kokoro-82m`                    | `speech.synthesize` | `en-US` only     | Fixed voice `af_heart`; `voiceId` is rejected.                  |
| `chatterbox-en`                 | `speech.synthesize` | `en-US` only     | Optional reference audio.                                       |
| `chatterbox-fa`                 | `speech.synthesize` | `fa-IR` only     | **Optional, non-commercial, personal use only.** See section 8. |

Source: [`speech.ts`](../../../packages/job-protocol/src/speech.ts).

## 3. Environment variables (as the worker reads them)

Read by `speechAvailabilityFromEnvironment` in [`local-speech.ts`](../src/local-speech.ts).
Set every path as an **absolute** path. A relative value makes that capability
silently unavailable.

| Variable                                    | Required          | Meaning                                                                                       |
| ------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `JOY_MEDIA_SPEECH_PYTHON`                   | yes               | Absolute path to the one Python executable used by all runners.                               |
| `JOY_MEDIA_SPEECH_SCRIPT_DIR`               | no                | Folder holding the runner scripts. Defaults to this `speech` folder next to the worker build. |
| `JOY_MEDIA_SPEECH_FFMPEG`                   | no                | Absolute path to `ffmpeg`. If unset, the runner calls `ffmpeg` from `PATH`.                   |
| `JOY_MEDIA_SPEECH_STT_MODEL_PATH`           | for STT           | Model folder for `faster-whisper-large-v3-turbo`.                                             |
| `JOY_MEDIA_SPEECH_KOKORO_MODEL_PATH`        | for Kokoro        | Model folder for `kokoro-82m`.                                                                |
| `JOY_MEDIA_SPEECH_CHATTERBOX_EN_MODEL_PATH` | for Chatterbox EN | Model folder for `chatterbox-en`.                                                             |
| `JOY_MEDIA_SPEECH_CHATTERBOX_FA_MODEL_PATH` | optional          | Model folder for `chatterbox-fa`.                                                             |
| `JOY_MEDIA_SPEECH_CHATTERBOX_SCRIPT`        | no                | Overrides the Chatterbox runner path for both Chatterbox IDs.                                 |

Mapping to the brief: `SCRIPT_DIR` is the runner-folder setting; the per-model
`*_MODEL_PATH` variables replace a single `MODEL_DIR`. The separate STT and TTS
Python variables are **not wired** (see section 1).

Example values (placeholders):

```text
JOY_MEDIA_SPEECH_PYTHON=D:\joy-speech\venv\Scripts\python.exe
JOY_MEDIA_SPEECH_SCRIPT_DIR=D:\joy-speech\runners
JOY_MEDIA_SPEECH_FFMPEG=D:\joy-speech\ffmpeg\bin\ffmpeg.exe
JOY_MEDIA_SPEECH_STT_MODEL_PATH=D:\joy-speech\models\faster-whisper-large-v3-turbo
JOY_MEDIA_SPEECH_KOKORO_MODEL_PATH=D:\joy-speech\models\kokoro-82m
JOY_MEDIA_SPEECH_CHATTERBOX_EN_MODEL_PATH=D:\joy-speech\models\chatterbox-en
```

Availability also requires that the script file exists and that the Python
interpreter can import the probed modules (section 4). Otherwise the capability
is not advertised.

## 4. Runner CLI, request, and outputs

Invocation (spawned with `shell: false`, no shell string):

```text
<JOY_MEDIA_SPEECH_PYTHON> <runner script> --request <job-private request.json> --output-dir <job output dir>
```

The request is a job-private JSON file, written with owner-only permissions:

```text
{
  "protocol": "joy.speech.v1",
  "type": "speech.transcribe" | "speech.synthesize",
  "language": "fa-IR" | "en-US",
  "modelId": "<model ID from section 2>",
  "modelPath": "<absolute model folder>",
  "sourcePath": "<STT source file, staged by the worker>",   // STT only
  "ffmpegPath": "<absolute ffmpeg>",                          // when configured
  "range": { "startUs": 0, "endUs": 0 },                      // STT, optional
  "text": "<synthesis text>",                                 // TTS only
  "referencePath": "<staged reference audio>",                // Chatterbox, when an asset is given
  "nonCommercial": true                                       // chatterbox-fa only
}
```

Outputs, written to the output directory:

- STT: `transcript.json` (limit 8 MiB).
- TTS: `voice.wav` (limit 32 MiB; PCM 16-bit, mono as written) and `timings.json` (limit 8 MiB).

Progress: the runner prints one JSON line per update to stdout:

```text
{"type":"progress","percent":42}
```

The worker maps this into its 5–85 band. Runner stderr carries only short failure
text, and the worker does not log it. Non-progress stdout is ignored.

## 5. Exact model folder layout

Only the files below are checked by the integrated runners. Other files in a
folder are the loader's business.

```text
D:\joy-speech\models\
  faster-whisper-large-v3-turbo\      # CTranslate2 faster-whisper folder; loaded with local_files_only=True
  kokoro-82m\
    config.json
    kokoro-v1_0.pth                    # non-empty
    voices\af_heart.pt                 # non-empty
  chatterbox-en\
    config.json
    ve.pt
    t3.safetensors | t3.pt | t3_mtl.safetensors    # one of these
    s3gen.safetensors | s3gen.pt                   # one of these
  chatterbox-fa\                       # OPTIONAL, non-commercial
    (same as chatterbox-en)
    tokenizer.json                     # required: expanded Persian tokenizer
```

The Kokoro runner builds its engine from these local files with `repo_id=None`.
The Chatterbox runner uses `ChatterboxTTS.from_local(<folder>)`. Neither runner
fetches from a hub.

## 6. Independent Python environments and dependency probes

The worker probes module availability with `find_spec` and does not load weights:

| Runner                                  | Modules probed                                         | Other check                                                     |
| --------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| STT (`transcribe.py`)                   | `faster_whisper`, `torch`                              | Model folder must exist.                                        |
| Kokoro (`synthesize_kokoro.py`)         | `kokoro`, `torch`, `misaki`, `spacy`, `en_core_web_sm` | Config, weights, voice file present.                            |
| Chatterbox (`synthesize_chatterbox.py`) | `chatterbox`, `torch`, `torchaudio`                    | Package `chatterbox-tts` or `chatterbox`, version **>= 0.1.7**. |

Because all runners share `JOY_MEDIA_SPEECH_PYTHON`, one environment must
contain every package above. The probe result is cached in process memory, and
the worker reads its settings at startup. **Restart the worker after installing
packages or changing any `JOY_MEDIA_SPEECH_*` value.**

## 7. Offline install and Windows CUDA DLL ordering

Install and stage everything on a machine with network access, then move the
pre-staged environment and model folders to the worker machine. Jobs install
nothing: the runners' error messages say so, and the runners do not download.

- Model files: place them in the folders in section 5 before the first job.
- The STT runner is hard-wired to `device="cuda"` with `compute_type="float16"`.
  It needs a CUDA-enabled PyTorch build that matches the installed CUDA 12
  runtime.
- **Windows DLL ordering:** `transcribe.py` imports `torch` before
  `faster_whisper` on `win32`, both at module import and again inside the job.
  Keep this order if you change the import block. The Kokoro and Chatterbox
  runners have no equivalent step.

## 8. Cold start, VRAM, cancellation, and the optional Persian model

**Cold start.** Each job starts a new runner process and loads its model inside
that process: `WhisperModel(...)`, `KModel`/`KPipeline`, or
`ChatterboxTTS.from_local(...)`. The integrated source keeps no warm pool. Speech
steps for one job run one after another. After a TTS run exits, the alignment
STT run starts only after it.

**VRAM.** The repo records no VRAM figures. Measure peak use per model on the
target GPU during an attended run, and record the result as evidence before
quoting it.

**Whole-tree cancel.** On cancel, `runRunner` calls `killProcessTree` from
[`local-masking.ts`](../src/local-masking.ts). The Windows branch walks the
`Win32_Process` descendants and stops each one. The test
`cancels a runner process tree and removes job-private files` in
[`local-speech.test.ts`](../src/local-speech.test.ts) checks that the child is
gone and the job-private directory is removed.

**Persian Chatterbox (`chatterbox-fa`): optional, non-commercial, personal use only.**

- Not part of the default setup. Install it only when the owner enables it.
- The job must carry consent purpose `personal-noncommercial`. The worker sets
  `nonCommercial: true` in the request. The runner rejects requests without it.
- A staged reference audio file is required. The runner raises without one.
- `tokenizer.json` (expanded Persian tokenizer) is required in the model folder.
- Do not use its output commercially. Its upstream provenance and terms are
  unverified (section 9).

## 9. License provenance

No license text or provenance record for these components is in the repo. The
upstream pointers below are for the owner to check. Their license terms were
**not verified** in this session: the web search was denied permission.

| Component                                     | Upstream pointer                             | License status                                                    |
| --------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| faster-whisper                                | github.com/SYSTRAN/faster-whisper            | Unverified                                                        |
| Whisper large-v3-turbo weights                | huggingface.co/openai/whisper-large-v3-turbo | Unverified                                                        |
| Kokoro-82M weights and voices                 | huggingface.co/hexgrad/Kokoro-82M            | Unverified                                                        |
| Kokoro Python package                         | github.com/hexgrad/kokoro                    | Unverified                                                        |
| Misaki, spaCy, `en_core_web_sm`               | Their PyPI and GitHub pages                  | Unverified                                                        |
| Chatterbox (`chatterbox-en`)                  | github.com/resemble-ai/chatterbox            | Unverified                                                        |
| `chatterbox-fa` weights and Persian tokenizer | Source not recorded in repo                  | **Unknown. Restricted to non-commercial by the integrated code.** |
| PyTorch, torchaudio, FFmpeg                   | Their official pages                         | Unverified                                                        |

Before any distribution, the owner records each license in writing and confirms
it allows the intended use.

## 10. Verify the installed scripts and resolve setup state

1. **Files:** confirm the runner scripts exist in `JOY_MEDIA_SPEECH_SCRIPT_DIR`,
   and that each model folder holds the files in section 5 with non-zero size.
2. **Python:** confirm `JOY_MEDIA_SPEECH_PYTHON` is an absolute path to a file,
   and that it imports the modules in section 6.
3. **Restart** the worker. Then check its advertised capabilities. These are
   `speech.transcribe`, `speech.synthesize`, and `speech.model.<model ID>`
   (see [`runtime.ts`](../src/runtime.ts)).
4. **Resolve a missing capability** by checking, in order: an absolute path
   (section 3), the model folder layout (section 5), the module probe (section 6),
   and the Chatterbox version floor. Then restart.
5. The existing runner tests are
   [`test_transcribe.py`](./test_transcribe.py),
   [`test_synthesize_kokoro.py`](./test_synthesize_kokoro.py), and
   [`test_synthesize_chatterbox.py`](./test_synthesize_chatterbox.py). They are
   **not run** by this change. Run them in the staged environment when the owner
   asks.

Do not run the runners by hand against real owner data. Do not put model or
key material in logs or in this repo.
