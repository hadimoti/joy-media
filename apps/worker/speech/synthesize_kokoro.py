#!/usr/bin/env python3
"""Run Kokoro English TTS from job-local, preinstalled model assets."""

from __future__ import annotations

import argparse
import array
import importlib.util
import json
import math
import re
import sys
import wave
from pathlib import Path
from typing import Any


SAMPLE_RATE = 24_000
VOICE_ID = "af_heart"
MAX_SAFE_INTEGER = 9_007_199_254_740_991
# Leading and trailing punctuation (and underscores) around a spoken word.
_WORD_EDGES = re.compile(r"^[\W_]+|[\W_]+$")


def _validate_request(request: dict[str, Any]) -> tuple[str, Path]:
    if request.get("protocol") != "joy.speech.v1":
        raise ValueError("protocol must be joy.speech.v1")
    if request.get("type") != "speech.synthesize":
        raise ValueError("type must be speech.synthesize")
    if request.get("modelId") != "kokoro-82m":
        raise ValueError("modelId must be kokoro-82m")
    if request.get("language") != "en-US":
        raise ValueError("Kokoro runner supports language en-US only")
    text = request.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text must be a non-empty string")
    model_path = request.get("modelPath")
    if not isinstance(model_path, str) or not model_path.strip():
        raise ValueError("modelPath must be a local model directory")
    return text, Path(model_path).expanduser()


def _verify_local_setup(model_dir: Path) -> tuple[dict[str, Any], Path, Path]:
    if not model_dir.is_dir():
        raise FileNotFoundError(f"Kokoro model directory is missing: {model_dir}")

    config_path = model_dir / "config.json"
    weights_path = model_dir / "kokoro-v1_0.pth"
    voice_path = model_dir / "voices" / f"{VOICE_ID}.pt"

    if not config_path.is_file():
        raise FileNotFoundError(f"Kokoro config is missing: {config_path}")
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Kokoro config is invalid: {config_path}") from error
    if not isinstance(config, dict):
        raise ValueError("Kokoro config must contain a JSON object")

    if not weights_path.is_file() or weights_path.stat().st_size == 0:
        raise FileNotFoundError(f"Kokoro model weights are missing: {weights_path}")
    if not voice_path.is_file() or voice_path.stat().st_size == 0:
        raise FileNotFoundError(f"Kokoro built-in voice is missing: {voice_path}")

    for module_name, label in (
        ("misaki", "Misaki"),
        ("spacy", "spaCy"),
        ("en_core_web_sm", "spaCy English model"),
        ("kokoro", "Kokoro"),
        ("torch", "PyTorch"),
    ):
        try:
            available = importlib.util.find_spec(module_name) is not None
        except (ImportError, ValueError):
            available = False
        if not available:
            raise RuntimeError(f"Local {label} setup is missing; install nothing during a job")

    return config, weights_path, voice_path


def _load_engine(config: dict[str, Any], weights_path: Path) -> Any:
    """Build Kokoro explicitly from local files, with Hugging Face lookup disabled."""
    from kokoro import KModel, KPipeline

    model = KModel(config=config, model=str(weights_path), repo_id=None)
    pipeline = KPipeline(lang_code="a", repo_id=None, model=model)
    return pipeline


def _load_voice(voice_path: Path) -> Any:
    import torch

    try:
        return torch.load(voice_path, map_location="cpu", weights_only=True)
    except TypeError:  # Older local torch releases do not accept weights_only.
        return torch.load(voice_path, map_location="cpu")


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
            raise ValueError("Kokoro produced a non-finite audio sample")
        flattened.append(number)

    append_values(audio)
    if not flattened:
        raise ValueError("Kokoro produced empty audio")
    return flattened


def _pcm16(samples: list[float]) -> array.array:
    pcm = array.array("h")
    for sample in samples:
        # Integer audio samples are already in PCM units; Kokoro float output is normalized.
        if isinstance(sample, int):
            value = sample
        else:
            value = round(max(-1.0, min(1.0, sample)) * 32767)
        pcm.append(max(-32768, min(32767, value)))
    if sys.byteorder != "little":
        pcm.byteswap()
    return pcm


def _normalize_native_timings(
    tokens: Any, text: str, sample_rate: int, frame_count: int
) -> list[dict[str, Any]]:
    """Accept only complete, text-matching word tokens on valid sample boundaries."""
    if not isinstance(tokens, (list, tuple)) or not tokens or sample_rate <= 0:
        return []
    # Kokoro times the spoken word without its surrounding punctuation; punctuation-only words have no timing.
    expected = [word for word in text.split() if _WORD_EDGES.sub("", word)]
    if len(tokens) != len(expected):
        return []

    normalized: list[dict[str, Any]] = []
    for token, expected_word in zip(tokens, expected):
        if (
            not isinstance(token, dict)
            or _WORD_EDGES.sub("", str(token.get("text", ""))) != _WORD_EDGES.sub("", expected_word)
        ):
            return []
        start = token.get("startSample")
        end = token.get("endSample")
        if (
            isinstance(start, bool)
            or isinstance(end, bool)
            or not isinstance(start, int)
            or not isinstance(end, int)
            or start < 0
            or end <= start
            or end > frame_count
        ):
            return []
        start_us = round(start * 1_000_000 / sample_rate)
        end_us = round(end * 1_000_000 / sample_rate)
        if end_us > MAX_SAFE_INTEGER:
            return []
        word: dict[str, Any] = {
            "text": expected_word,
            "startUs": start_us,
            "endUs": end_us,
        }
        confidence = token.get("confidence")
        if confidence is not None:
            if (
                isinstance(confidence, bool)
                or not isinstance(confidence, (int, float))
                or not math.isfinite(confidence)
                or not 0 <= confidence <= 1
            ):
                return []
            word["confidence"] = confidence
        normalized.append(word)
    return normalized


def _timed_result_tokens(tokens: Any, offset_samples: int) -> list[dict[str, Any]] | None:
    """Turn a real KPipeline.Result.tokens list (seconds, relative to its chunk) into sample-clock tokens.

    Punctuation-only tokens carry no timing and are skipped. A word token without a start and end time makes the
    whole chunk untrustworthy, so the caller reports the timings as unavailable.
    """
    if not isinstance(tokens, (list, tuple)):
        return None
    timed: list[dict[str, Any]] = []
    for token in tokens:
        if isinstance(token, dict):
            token_text, start_ts, end_ts = token.get("text"), token.get("start_ts"), token.get("end_ts")
        else:
            token_text = getattr(token, "text", None)
            start_ts = getattr(token, "start_ts", None)
            end_ts = getattr(token, "end_ts", None)
        if not isinstance(token_text, str):
            return None
        if not _WORD_EDGES.sub("", token_text):
            continue
        if (
            isinstance(start_ts, bool)
            or isinstance(end_ts, bool)
            or not isinstance(start_ts, (int, float))
            or not isinstance(end_ts, (int, float))
            or not math.isfinite(start_ts)
            or not math.isfinite(end_ts)
        ):
            return None
        timed.append(
            {
                "text": token_text,
                "startSample": offset_samples + round(start_ts * SAMPLE_RATE),
                "endSample": offset_samples + round(end_ts * SAMPLE_RATE),
            }
        )
    return timed


def _generate_audio(engine: Any, voice: Any, text: str) -> tuple[list[float], Any]:
    chunks: list[float] = []
    native_tokens: Any = None
    collected: list[dict[str, Any]] = []
    collecting = True
    for result in engine(text, voice=voice):
        if isinstance(result, (tuple, list)) and len(result) >= 3:
            chunks.extend(_as_mono_samples(result[2]))
            # A fourth item is accepted only when it contains native timed word tokens.
            if len(result) >= 4:
                native_tokens = result[3]
            continue
        if not hasattr(result, "audio"):
            raise ValueError("Kokoro returned an unsupported result")
        # Real Kokoro (KPipeline.Result): .audio is a tensor and .tokens carry start_ts/end_ts seconds per chunk.
        if result.audio is None:
            collecting = False
            continue
        offset = len(chunks)
        chunks.extend(_as_mono_samples(result.audio))
        if collecting:
            timed = _timed_result_tokens(getattr(result, "tokens", None), offset)
            if timed is None:
                collecting = False
            else:
                collected.extend(timed)
    if not chunks:
        raise ValueError("Kokoro produced empty audio")
    if collecting and collected:
        native_tokens = collected
    return chunks, native_tokens


def synthesize(request: dict[str, Any], output_dir: Path) -> None:
    text, model_dir = _validate_request(request)
    config, weights_path, voice_path = _verify_local_setup(model_dir)
    engine = _load_engine(config, weights_path)
    voice = _load_voice(voice_path)
    samples, native_tokens = _generate_audio(engine, voice, text)
    pcm = _pcm16(samples)
    frame_count = len(pcm)
    duration_us = round(frame_count * 1_000_000 / SAMPLE_RATE)
    if duration_us > MAX_SAFE_INTEGER:
        raise ValueError("Audio duration exceeds the safe integer limit")
    words = _normalize_native_timings(native_tokens, text, SAMPLE_RATE, frame_count)
    timing_source = "native" if words else "unavailable"

    output_dir.mkdir(parents=True, exist_ok=True)
    wav_path = output_dir / "voice.wav"
    timings_path = output_dir / "timings.json"
    with wave.open(str(wav_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm.tobytes())
    timings_path.write_text(
        json.dumps(
            {"durationUs": duration_us, "timingSource": timing_source, "words": words},
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
        print(f"kokoro synthesis failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
