#!/usr/bin/env python3
"""Run local Chatterbox English or Persian TTS from staged job assets."""

from __future__ import annotations

import argparse
import array
import importlib.metadata
import importlib.util
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
ENGLISH_FILES = ("conds.pt", "s3gen.safetensors", "t3_cfg.safetensors", "tokenizer.json", "ve.safetensors")
ENGLISH_ALTERNATES = {
    "ve.safetensors": ("ve.pt",),
    "s3gen.safetensors": ("s3gen.pt",),
    "t3_cfg.safetensors": ("t3.safetensors", "t3.pt", "t3_mtl.safetensors"),
    "conds.pt": (),
    "tokenizer.json": (),
}


def _validate_request(request: dict[str, Any]) -> tuple[str, str, Path, Path | None, Path | None]:
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
    base_path = None
    raw_base = request.get("basePath")
    if raw_base is not None:
        if language != "fa-IR" or not isinstance(raw_base, str) or not raw_base.strip():
            raise ValueError("basePath is only valid as a local Persian English-base directory")
        base_path = Path(raw_base).expanduser()
    return text, language, Path(model_path).expanduser(), reference_path, base_path


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


def _nonempty_file(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 0


def _require_file(directory: Path, names: tuple[str, ...], label: str) -> Path:
    for name in names:
        path = directory / name
        if _nonempty_file(path):
            return path
    raise FileNotFoundError(f"Required Chatterbox {label} file is missing or empty")


def _find_persian_base(model_dir: Path, base_path: Path | None) -> Path:
    candidates = ([base_path] if base_path is not None else []) + [
        model_dir / "chatterbox-en",
        model_dir / "chatterbox-english",
        model_dir.parent / "chatterbox-en",
        model_dir.parent / "chatterbox-english",
    ]
    for candidate in candidates:
        if candidate is not None and all(_nonempty_file(candidate / name) for name in ("ve.safetensors", "s3gen.safetensors")):
            return candidate
    raise FileNotFoundError("Persian Chatterbox English base files are missing")


def _verify_local_setup(model_dir: Path, language: str, base_path: Path | None = None) -> Path | None:
    version = _installed_version()
    if _version_tuple(version) < (0, 1, 7):
        raise RuntimeError(f"Chatterbox >=0.1.7 is required; local version is {version}")
    if not model_dir.is_dir():
        raise FileNotFoundError(f"Chatterbox model directory is missing: {model_dir}")

    if language == "en-US":
        for name in ENGLISH_FILES:
            if name == "conds.pt" and not _nonempty_file(model_dir / name):
                # Older local layouts predate the cached-conditioning file.
                if any(_nonempty_file(model_dir / legacy) for legacy in ENGLISH_ALTERNATES["t3_cfg.safetensors"]):
                    continue
            _require_file(model_dir, (name, *ENGLISH_ALTERNATES[name]), name)
        return None
    _require_file(model_dir, ("t3_fa_expressive.safetensors",), "Persian checkpoint")
    _require_file(model_dir, ("persian_tts_engine.py",), "Persian engine")
    _require_file(model_dir, ("grapheme_mtl_merged_expanded_v1.json", "tokenizer.json"), "expanded Persian tokenizer")
    return _find_persian_base(model_dir, base_path)


def _load_engine(model_dir: Path) -> Any:
    """Load the English engine from the supplied local folder only."""
    import torch
    from chatterbox.tts import ChatterboxTTS
    return ChatterboxTTS.from_local(str(model_dir), "cuda" if torch.cuda.is_available() else "cpu")


def _load_persian_engine(model_dir: Path, base_dir: Path) -> Any:
    """Build the Persian multilingual engine from local checkpoint and English base files."""
    import torch
    from safetensors.torch import load_file

    sys.path.insert(0, str(model_dir))
    engine_path = model_dir / "persian_tts_engine.py"
    spec = importlib.util.spec_from_file_location("joy_persian_tts_engine", engine_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Persian Chatterbox engine could not be loaded")
    pe = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = pe
    spec.loader.exec_module(pe)
    pe.patch_chatterbox_runtime()

    from chatterbox import mtl_tts
    from chatterbox.models.t3 import T3
    from chatterbox.models.t3.t3 import T3Config
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.models.voice_encoder import VoiceEncoder
    from chatterbox.models.tokenizers import MTLTokenizer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    ve = VoiceEncoder()
    ve.load_state_dict(load_file(str(base_dir / "ve.safetensors")))
    ve.to(device).eval()
    s3 = S3Gen()
    s3.load_state_dict(load_file(str(base_dir / "s3gen.safetensors")), strict=False)
    s3.to(device).eval()
    t3 = T3(T3Config.multilingual())
    state = load_file(str(model_dir / "t3_fa_expressive.safetensors"))
    t3.load_state_dict({key: value for key, value in state.items() if not key.startswith("patched_model.")}, strict=True)
    t3.to(device).eval()
    tokenizer_path = model_dir / "grapheme_mtl_merged_expanded_v1.json"
    if not tokenizer_path.is_file():
        tokenizer_path = model_dir / "tokenizer.json"
    tokenizer = MTLTokenizer(str(tokenizer_path))
    model = mtl_tts.ChatterboxMultilingualTTS(t3, s3, ve, tokenizer, device, conds=None)
    engine = pe.PersianCommercialTTS.__new__(pe.PersianCommercialTTS)
    engine.device = device
    engine.model = model
    engine.sr = 24_000
    engine._cached_ref = None
    engine.ezafe = None
    return engine


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
    engine: Any, text: str, language: str, reference_path: Path | None
) -> tuple[list[float], int]:
    if language == "fa-IR":
        audio = engine.synthesize(text, str(reference_path), exaggeration=0.45, seed=7, auto_ezafe=False)
    else:
        kwargs: dict[str, Any] = {}
        if reference_path is not None:
            kwargs["audio_prompt_path"] = str(reference_path)
        audio = engine.generate(text, **kwargs)
    sample_rate = getattr(engine, "sr", getattr(engine, "sample_rate", DEFAULT_SAMPLE_RATE))
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ValueError("Chatterbox returned an invalid sample rate")
    return _as_mono_samples(audio), sample_rate


def synthesize(request: dict[str, Any], output_dir: Path) -> None:
    text, language, model_dir, reference_path, base_path = _validate_request(request)
    resolved_base = _verify_local_setup(model_dir, language, base_path)
    if language == "fa-IR" and reference_path is None:
        raise ValueError("Persian Chatterbox requires a staged reference audio file")
    if reference_path is not None and (
        not reference_path.is_file() or reference_path.stat().st_size == 0
    ):
        raise FileNotFoundError(f"Staged reference audio is missing or empty: {reference_path}")

    engine = _load_engine(model_dir) if language == "en-US" else _load_persian_engine(model_dir, resolved_base)
    samples, sample_rate = _generate_audio(engine, text, language, reference_path)
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
        print("chatterbox synthesis failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
