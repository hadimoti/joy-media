#!/usr/bin/env python3
"""Run local Chatterbox English or Persian TTS from staged job assets."""

from __future__ import annotations

import argparse
import array
import importlib.metadata
import json
import math
import re
import sys
import wave
from pathlib import Path
from typing import Any


DEFAULT_SAMPLE_RATE = 24_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MODEL_LANGUAGE = {
    "chatterbox-en": "en-US",
    "chatterbox-fa": "fa-IR",
}
CHECKPOINT_GROUPS = (
    ("ve.pt",),
    ("t3.safetensors", "t3.pt", "t3_mtl.safetensors"),
    ("s3gen.safetensors", "s3gen.pt"),
)


def _validate_request(request: dict[str, Any]) -> tuple[str, str, Path, Path | None]:
    if request.get("protocol") != "joy.speech.v1":
        raise ValueError("protocol must be joy.speech.v1")
    if request.get("type") != "speech.synthesize":
        raise ValueError("type must be speech.synthesize")
    model_id = request.get("modelId")
    if model_id not in MODEL_LANGUAGE:
        raise ValueError("modelId must be chatterbox-en or chatterbox-fa")
    language = MODEL_LANGUAGE[model_id]
    if request.get("language") != language:
        raise ValueError(f"{model_id} supports language {language} only")
    text = request.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text must be a non-empty string")
    model_path = request.get("modelPath")
    if not isinstance(model_path, str) or not model_path.strip():
        raise ValueError("modelPath must be a local model directory")

    reference_path: Path | None = None
    raw_reference = request.get("referencePath")
    if raw_reference is not None:
        if not isinstance(raw_reference, str) or not raw_reference.strip():
            raise ValueError("referencePath must be a local audio file path")
        reference_path = Path(raw_reference).expanduser()

    if language == "fa-IR" and request.get("nonCommercial") is not True:
        raise ValueError("Persian Chatterbox requires the trusted non-commercial flag")
    return text, language, Path(model_path).expanduser(), reference_path


def _version_tuple(version: str) -> tuple[int, ...]:
    match = re.match(r"^\s*(\d+(?:\.\d+)*)(?:[-+].*)?\s*$", version)
    if not match:
        raise RuntimeError(f"Cannot determine local Chatterbox version: {version!r}")
    return tuple(int(part) for part in match.group(1).split("."))


def _installed_version() -> str:
    try:
        return importlib.metadata.version("chatterbox-tts")
    except importlib.metadata.PackageNotFoundError:
        try:
            return importlib.metadata.version("chatterbox")
        except importlib.metadata.PackageNotFoundError as error:
            raise RuntimeError("Local Chatterbox package is missing; install nothing during a job") from error


def _verify_local_setup(model_dir: Path, language: str) -> dict[str, Any]:
    version = _installed_version()
    if _version_tuple(version) < (0, 1, 7):
        raise RuntimeError(f"Chatterbox >=0.1.7 is required; local version is {version}")
    if not model_dir.is_dir():
        raise FileNotFoundError(f"Chatterbox model directory is missing: {model_dir}")

    config_path = model_dir / "config.json"
    if not config_path.is_file():
        raise FileNotFoundError(f"Chatterbox config is missing: {config_path}")
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Chatterbox config is invalid: {config_path}") from error
    if not isinstance(config, dict):
        raise ValueError("Chatterbox config must contain a JSON object")

    for alternatives in CHECKPOINT_GROUPS:
        if not any(
            (model_dir / name).is_file() and (model_dir / name).stat().st_size > 0
            for name in alternatives
        ):
            names = " or ".join(alternatives)
            raise FileNotFoundError(f"Chatterbox checkpoint file is missing or empty: {names}")
    if language == "fa-IR":
        tokenizer_path = model_dir / "tokenizer.json"
        if not tokenizer_path.is_file() or tokenizer_path.stat().st_size == 0:
            raise FileNotFoundError(f"Expanded Persian tokenizer is missing: {tokenizer_path}")
    return config


def _load_engine(model_dir: Path) -> Any:
    """Load staged model files through Chatterbox's local-only loader."""
    from chatterbox.tts import ChatterboxTTS

    loader = getattr(ChatterboxTTS, "from_local", None)
    if loader is None:
        raise RuntimeError("Local Chatterbox from_local loader is unavailable")
    return loader(str(model_dir))


def _as_mono_samples(audio: Any) -> list[float]:
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    if hasattr(audio, "tolist"):
        audio = audio.tolist()
    if isinstance(audio, (int, float)):
        audio = [audio]
    flattened: list[float] = []

    def append_values(value: Any) -> None:
        if isinstance(value, (list, tuple)):
            for item in value:
                append_values(item)
            return
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("Chatterbox produced a non-finite audio sample")
        flattened.append(number)

    append_values(audio)
    if not flattened:
        raise ValueError("Chatterbox produced empty audio")
    return flattened


def _pcm16(samples: list[float]) -> array.array:
    pcm = array.array("h")
    for sample in samples:
        value = round(max(-1.0, min(1.0, sample)) * 32767)
        pcm.append(max(-32768, min(32767, value)))
    if sys.byteorder != "little":
        pcm.byteswap()
    return pcm


def _generate_audio(
    engine: Any, text: str, reference_path: Path | None
) -> tuple[list[float], int]:
    kwargs: dict[str, Any] = {}
    if reference_path is not None:
        kwargs["audio_prompt_path"] = str(reference_path)
    audio = engine.generate(text, **kwargs)
    sample_rate = getattr(engine, "sr", getattr(engine, "sample_rate", DEFAULT_SAMPLE_RATE))
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ValueError("Chatterbox returned an invalid sample rate")
    return _as_mono_samples(audio), sample_rate


def synthesize(request: dict[str, Any], output_dir: Path) -> None:
    text, language, model_dir, reference_path = _validate_request(request)
    _verify_local_setup(model_dir, language)
    if language == "fa-IR" and reference_path is None:
        raise ValueError("Persian Chatterbox requires a staged reference audio file")
    if reference_path is not None and (
        not reference_path.is_file() or reference_path.stat().st_size == 0
    ):
        raise FileNotFoundError(f"Staged reference audio is missing or empty: {reference_path}")

    engine = _load_engine(model_dir)
    samples, sample_rate = _generate_audio(engine, text, reference_path)
    pcm = _pcm16(samples)
    duration_us = round(len(pcm) * 1_000_000 / sample_rate)
    if duration_us > MAX_SAFE_INTEGER:
        raise ValueError("Audio duration exceeds the safe integer limit")

    output_dir.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output_dir / "voice.wav"), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())
    (output_dir / "timings.json").write_text(
        json.dumps(
            {"durationUs": duration_us, "timingSource": "unavailable", "words": []},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    try:
        request = json.loads(Path(args.request).read_text(encoding="utf-8"))
        if not isinstance(request, dict):
            raise ValueError("request JSON must contain an object")
        print(json.dumps({"type": "progress", "percent": 1}), flush=True)
        synthesize(request, Path(args.output_dir))
        print(json.dumps({"type": "progress", "percent": 100}), flush=True)
        return 0
    except Exception as error:
        print(f"chatterbox synthesis failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
