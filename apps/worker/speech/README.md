# JOY Local Speech runners

These runners use local Python environments and bring-your-own model folders.
Jobs do not install packages, download models, or call cloud services. Configure
absolute paths and restart the Worker after changing them.

## Python environments

Set `JOY_MEDIA_SPEECH_STT_PYTHON` and `JOY_MEDIA_SPEECH_TTS_PYTHON` to absolute
paths of the Python executables for the respective runners. TTS Python needs
`chatterbox-tts >= 0.1.7`, `safetensors`, `soundfile`, `numpy`, and a CUDA-enabled
`torch`. STT Python needs its existing faster-whisper and torch dependencies.
The Worker probes imports without loading model weights.

Other settings are `JOY_MEDIA_SPEECH_RUNNER_DIR` (defaults to this folder),
`JOY_MEDIA_SPEECH_FFMPEG`, `JOY_MEDIA_SPEECH_STT_MODEL_PATH`,
`JOY_MEDIA_SPEECH_KOKORO_MODEL_PATH`, `JOY_MEDIA_SPEECH_CHATTERBOX_EN_MODEL_PATH`,
and `JOY_MEDIA_SPEECH_CHATTERBOX_FA_MODEL_PATH`. The older
`JOY_MEDIA_SPEECH_SCRIPT_DIR` remains a runner-directory alias. The optional
`JOY_MEDIA_SPEECH_CHATTERBOX_SCRIPT` overrides the Chatterbox runner for both
models.

The existing `transcribe.py` runner uses
`JOY_MEDIA_SPEECH_STT_MODEL_PATH` for `faster-whisper-large-v3-turbo`. The
`synthesize_kokoro.py` runner uses `JOY_MEDIA_SPEECH_KOKORO_MODEL_PATH` for
`kokoro-82m`; its local folder needs the Kokoro config, model weights, and voice
file.

## Chatterbox model folders

English `modelPath` points directly to the local English engine folder:

```text
chatterbox-english/
  conds.pt
  s3gen.safetensors
  t3_cfg.safetensors
  tokenizer.json
  ve.safetensors
```

Legacy local names are accepted where there is an equivalent: `ve.pt`,
`s3gen.pt`, and `t3.safetensors`, `t3.pt`, or `t3_mtl.safetensors`. No other
generic checkpoint naming is assumed. English loads with
`ChatterboxTTS.from_local(folder, device)` and accepts optional staged reference
audio.

Persian is optional and uses the author's local engine and tokenizer:

```text
chatterbox-persian/
  t3_fa_expressive.safetensors
  persian_tts_engine.py
  grapheme_mtl_merged_expanded_v1.json   # or tokenizer.json
  # English base files may also be here:
  ve.safetensors
  s3gen.safetensors
```

If the English base files are elsewhere, put them in a sibling directory named
`chatterbox-en` or `chatterbox-english`, or pass an explicit `basePath` in the
private request JSON. The runner searches `basePath` first, then sibling folders.
The Persian model is assembled locally from `VoiceEncoder`, `S3Gen`, the
multilingual `T3` checkpoint, and `MTLTokenizer`; no hub loader is used.

The Persian request requires a staged reference WAV and `nonCommercial: true`.
The Worker sets that flag only after personal non-commercial consent. Synthesis
uses exaggeration `0.45`, seed `7`, and `auto_ezafe` off. Output is mono PCM16
WAV at 24 kHz. `timings.json` reports `timingSource: "unavailable"` and empty
words; the Worker performs alignment afterward when local STT is available.

## Request, output, and privacy

The Worker invokes the runner without a shell:

```text
python synthesize_chatterbox.py --request <private request.json> --output-dir <private output dir>
```

The job-private `joy.speech.v1` request contains local paths only. Persian may
include `basePath`; it is not needed if the English base is beside the model.
The runner writes `voice.wav` and `timings.json`, then emits bounded JSON
progress lines. Logs never include request text or paths.

## Persian attribution and license

Chatterbox Persian Expressive by Ramin Mahmoodi, CC-BY-NC-4.0, non-commercial
use only; credit the author. Do not use this model for commercial purposes.

The general Chatterbox English, Kokoro, and Whisper components have separate
licenses. Check those licenses and the terms for each model before distributing
their files or using them in a product.
