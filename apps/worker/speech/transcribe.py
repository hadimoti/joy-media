#!/usr/bin/env python3
"""JOY Media faster-whisper speech transcription runner.

Receives a job-private JSON request with local file paths.
Outputs transcript.json conforming to joy.speech.v1 / SpeechTranscript.
Bounded FFmpeg decode windows with deterministic overlap reconciliation.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Dict, List, Optional, Tuple

# Import Torch first on Windows for the CUDA 12 DLLs
if sys.platform == "win32":
    try:
        import torch  # type: ignore # noqa: F401
    except ImportError:
        pass

try:
    from faster_whisper import WhisperModel  # type: ignore
except ImportError:
    WhisperModel = None

CHUNK_DURATION_S = 30.0
OVERLAP_S = 1.0
WINDOW_SIZE_S = CHUNK_DURATION_S + OVERLAP_S  # 31.0 seconds
SAMPLE_RATE = 16000

_PUNCT_RE = re.compile(r"[\s\.,\/#!$%\^&\*;:{}=\-_`~()?'\"«»،؛؟\u200c\u200e\u200f]+")


def normalize_token(text: str) -> str:
    """Normalize token text for deterministic overlap comparison only."""
    return _PUNCT_RE.sub("", text).strip().lower()


def words_overlap_match(w1: Dict[str, Any], w2: Dict[str, Any]) -> bool:
    """Check if two word instances represent the same spoken token occurrence."""
    t1 = normalize_token(w1.get("text", ""))
    t2 = normalize_token(w2.get("text", ""))
    if not t1 or not t2 or t1 != t2:
        return False

    s1, e1 = w1["startUs"], w1["endUs"]
    s2, e2 = w2["startUs"], w2["endUs"]

    # Overlap in time: max(start) < min(end)
    overlap = min(e1, e2) - max(s1, s2)
    if overlap > 0:
        return True

    # Or near-identical start and end timestamps (within 150ms = 150,000 µs)
    if abs(s1 - s2) <= 150_000 and abs(e1 - e2) <= 150_000:
        return True

    return False


def reconcile_overlap(
    existing_words: List[Dict[str, Any]],
    new_words: List[Dict[str, Any]],
    overlap_start_us: int,
    overlap_end_us: int,
) -> List[Dict[str, Any]]:
    """Deterministically merge words from a new chunk with existing words.

    Words occurring in the overlap region that were already present in
    existing_words are deduplicated, while genuine repeated tokens (e.g. repeated
    words spoken at different times) are preserved.
    """
    if not existing_words:
        return list(new_words)
    if not new_words:
        return list(existing_words)

    # Words in existing_words that end after the start of this chunk's window
    # and could potentially overlap with new_words
    candidate_indices = [
        i for i, w in enumerate(existing_words) if w["endUs"] > overlap_start_us
    ]

    matched_candidate_indices = set()
    words_to_append: List[Dict[str, Any]] = []

    for new_w in new_words:
        match_found = False
        # Only words in the overlap zone can match existing words
        if new_w["startUs"] < overlap_end_us:
            for c_idx in candidate_indices:
                if c_idx in matched_candidate_indices:
                    continue
                cand = existing_words[c_idx]
                if words_overlap_match(cand, new_w):
                    matched_candidate_indices.add(c_idx)
                    match_found = True
                    break

        if not match_found:
            words_to_append.append(new_w)

    return existing_words + words_to_append


def validate_request(
    request: Dict[str, Any],
) -> Tuple[str, str, Path, Path, Optional[str], Optional[Tuple[int, Optional[int]]]]:
    """Validate the incoming request dictionary.

    Returns (language, modelId, modelPath, sourcePath, ffmpegPath, range_us)
    """
    if not isinstance(request, dict):
        raise ValueError("Request must be a JSON object")

    if request.get("protocol") != "joy.speech.v1":
        raise ValueError(
            f"Invalid protocol: expected 'joy.speech.v1', got {request.get('protocol')!r}"
        )

    if request.get("type") != "speech.transcribe":
        raise ValueError(
            f"Invalid type: expected 'speech.transcribe', got {request.get('type')!r}"
        )

    language = request.get("language")
    if not isinstance(language, str) or not language.strip():
        raise ValueError("language must be a non-empty string")
    language = language.strip()

    model_id = request.get("modelId")
    if not isinstance(model_id, str) or not model_id.strip():
        raise ValueError("modelId must be a non-empty string")
    model_id = model_id.strip()

    model_path_str = request.get("modelPath")
    if not isinstance(model_path_str, str) or not model_path_str.strip():
        raise ValueError("modelPath is required")
    model_path = Path(model_path_str)
    if not model_path.is_dir():
        raise FileNotFoundError(f"Local model directory does not exist: {model_path_str}")

    source_path_str = request.get("sourcePath")
    if not isinstance(source_path_str, str) or not source_path_str.strip():
        raise ValueError("sourcePath is required for speech.transcribe")
    source_path = Path(source_path_str)
    if not source_path.is_file():
        raise FileNotFoundError(f"Source file does not exist: {source_path_str}")

    ffmpeg_path = request.get("ffmpegPath")
    if ffmpeg_path is not None and (not isinstance(ffmpeg_path, str) or not ffmpeg_path.strip()):
        ffmpeg_path = None

    range_us = None
    range_spec = request.get("range")
    if range_spec is not None:
        if not isinstance(range_spec, dict):
            raise ValueError("range must be a JSON object")
        start_us = range_spec.get("startUs")
        if start_us is None:
            start_us = range_spec.get("inUs", 0)
        end_us = range_spec.get("endUs")
        if end_us is None:
            end_us = range_spec.get("outUs")

        if not isinstance(start_us, int) or start_us < 0:
            raise ValueError(f"range startUs must be a non-negative integer, got {start_us!r}")

        if end_us is not None:
            if not isinstance(end_us, int) or end_us <= start_us:
                raise ValueError(
                    f"range endUs must be an integer greater than startUs ({start_us}), got {end_us!r}"
                )
            range_us = (start_us, end_us)
        else:
            range_us = (start_us, None)

    return language, model_id, model_path, source_path, ffmpeg_path, range_us


def probe_duration_s(ffmpeg_bin: str, source_path: Path) -> Optional[float]:
    """Probe media duration using FFmpeg without logging file paths."""
    try:
        cmd = [ffmpeg_bin, "-i", str(source_path)]
        result = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
        )
        stderr_text = result.stderr.decode("utf-8", errors="replace")
        match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", stderr_text)
        if match:
            hours, minutes, seconds = match.groups()
            return int(hours) * 3600.0 + int(minutes) * 60.0 + float(seconds)
    except Exception:
        pass
    return None


def decode_window_wav(
    ffmpeg_bin: str,
    source_path: Path,
    start_s: float,
    duration_s: float,
    output_wav: Path,
) -> bool:
    """Extract a bounded audio window to WAV (16kHz mono pcm_s16le).

    Returns True if audio samples were decoded, False if EOF / empty.
    """
    cmd = [
        ffmpeg_bin,
        "-y",
        "-ss",
        f"{start_s:.6f}",
        "-t",
        f"{duration_s:.6f}",
        "-i",
        str(source_path),
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        str(SAMPLE_RATE),
        "-ac",
        "1",
        str(output_wav),
    ]
    result = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        if output_wav.is_file() and output_wav.stat().st_size > 44:
            return True
        return False

    if not output_wav.is_file():
        return False

    # A standard WAV header is 44 bytes. Anything <= 44 bytes has 0 audio data.
    if output_wav.stat().st_size <= 44:
        return False

    return True


def emit_progress(percent: float) -> None:
    """Emit JSON progress line without leaking paths or text."""
    clamped = max(0.0, min(100.0, float(percent)))
    payload = json.dumps({"type": "progress", "percent": round(clamped, 1)})
    sys.stdout.write(payload + "\n")
    sys.stdout.flush()


def transcribe(request: dict, output_dir: Path) -> None:
    """Execute speech transcription according to the joy.speech.v1 protocol."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "transcript.json"
    temp_output = output_dir / f"transcript.json.tmp.{os.getpid()}"

    # Validate request
    language, model_id, model_path, source_path, ffmpeg_bin_opt, range_us = (
        validate_request(request)
    )
    ffmpeg_bin = ffmpeg_bin_opt or "ffmpeg"

    # Initialize model: require local model directory and pass CUDA float16, local_files_only
    whisper_cls = WhisperModel
    if whisper_cls is None:
        raise RuntimeError("faster_whisper is not available")

    # Import Torch first on Windows for the CUDA 12 DLLs
    if sys.platform == "win32":
        try:
            import torch  # type: ignore # noqa: F401
        except ImportError:
            pass

    model = whisper_cls(
        str(model_path),
        device="cuda",
        compute_type="float16",
        local_files_only=True,
    )

    # Determine processing boundaries
    start_us = 0
    end_us = None
    if range_us is not None:
        start_us, end_us = range_us

    media_duration_s = probe_duration_s(ffmpeg_bin, source_path)
    start_s = start_us / 1_000_000.0

    if end_us is not None:
        total_duration_s = (end_us - start_us) / 1_000_000.0
        end_s = end_us / 1_000_000.0
    elif media_duration_s is not None:
        total_duration_s = max(0.0, media_duration_s - start_s)
        end_s = media_duration_s
    else:
        total_duration_s = None
        end_s = None

    all_words: List[Dict[str, Any]] = []

    # Bounded FFmpeg decode windows (30s plus 1s overlap)
    current_start_s = start_s
    temp_dir = tempfile.mkdtemp(prefix="joy_stt_")

    try:
        emit_progress(0.0)
        chunk_index = 0

        while True:
            if end_s is not None and current_start_s >= end_s:
                break

            if end_s is not None:
                window_duration_s = min(WINDOW_SIZE_S, end_s - current_start_s)
            else:
                window_duration_s = WINDOW_SIZE_S

            if window_duration_s <= 0:
                break

            chunk_wav = Path(temp_dir) / f"chunk_{chunk_index}.wav"
            has_audio = decode_window_wav(
                ffmpeg_bin=ffmpeg_bin,
                source_path=source_path,
                start_s=current_start_s,
                duration_s=window_duration_s,
                output_wav=chunk_wav,
            )

            if not has_audio:
                # Reached EOF or no audio decoded
                break

            # Transcribe chunk
            transcribe_lang = {
                "en-US": "en",
                "fa-IR": "fa",
            }.get(language, language) if language != "auto" else None
            segments, _info = model.transcribe(
                str(chunk_wav),
                language=transcribe_lang,
                word_timestamps=True,
            )

            # Extract words with source-clock timestamps
            chunk_words: List[Dict[str, Any]] = []
            chunk_start_us = int(round(current_start_s * 1_000_000))

            for segment in segments:
                words = getattr(segment, "words", None)
                if words is None and isinstance(segment, dict):
                    words = segment.get("words")
                if not words:
                    continue

                for w in words:
                    w_text = (
                        getattr(w, "word", None)
                        or getattr(w, "text", None)
                        or (w.get("word") if isinstance(w, dict) else None)
                        or (w.get("text") if isinstance(w, dict) else "")
                    )
                    w_start = (
                        getattr(w, "start", None)
                        if not isinstance(w, dict)
                        else w.get("start")
                    )
                    w_end = (
                        getattr(w, "end", None)
                        if not isinstance(w, dict)
                        else w.get("end")
                    )
                    w_prob = (
                        getattr(w, "probability", None)
                        if not isinstance(w, dict)
                        else w.get("probability")
                    )
                    if w_prob is None and isinstance(w, dict):
                        w_prob = w.get("confidence")

                    if w_start is None or w_end is None:
                        continue

                    # Source-clock integer microseconds
                    w_start_us = chunk_start_us + int(round(float(w_start) * 1_000_000))
                    w_end_us = chunk_start_us + int(round(float(w_end) * 1_000_000))

                    # If range end is specified, ignore words starting beyond range end
                    if end_us is not None and w_start_us >= end_us:
                        continue
                    if end_us is not None and w_end_us > end_us:
                        w_end_us = end_us

                    if w_end_us <= w_start_us:
                        w_end_us = w_start_us + 10_000  # Minimum 10ms

                    word_entry: Dict[str, Any] = {
                        "text": str(w_text).strip(),
                        "startUs": w_start_us,
                        "endUs": w_end_us,
                    }
                    if w_prob is not None:
                        word_entry["confidence"] = round(float(w_prob), 4)

                    chunk_words.append(word_entry)

            # Deterministic overlap reconciliation
            overlap_start_us = chunk_start_us
            overlap_end_us = chunk_start_us + int(round(OVERLAP_S * 1_000_000))

            all_words = reconcile_overlap(
                existing_words=all_words,
                new_words=chunk_words,
                overlap_start_us=overlap_start_us,
                overlap_end_us=overlap_end_us,
            )

            # Clean up chunk wav
            try:
                chunk_wav.unlink(missing_ok=True)
            except OSError:
                pass

            # Update progress
            chunk_index += 1
            current_start_s += CHUNK_DURATION_S

            if total_duration_s and total_duration_s > 0:
                processed_s = min(total_duration_s, current_start_s - start_s)
                percent = (processed_s / total_duration_s) * 95.0
                emit_progress(percent)

        # Sort and ensure non-decreasing timestamps
        all_words.sort(key=lambda x: (x["startUs"], x["endUs"]))

        # Prepare SpeechTranscript metadata
        created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        transcript_doc: Dict[str, Any] = {
            "language": language,
            "words": all_words,
            "speakers": [],
            "provenance": {
                "providerId": "local",
                "modelId": model_id,
                "createdAt": created_at,
            },
        }

        # Write output to temporary file first, then atomically replace
        with open(temp_output, "w", encoding="utf-8") as f:
            json.dump(transcript_doc, f, ensure_ascii=False, indent=2)
        temp_output.replace(output_file)

        emit_progress(100.0)

    except Exception:
        # Treat script failure as failure, and clean incomplete output
        if output_file.is_file():
            try:
                output_file.unlink()
            except OSError:
                pass
        if temp_output.is_file():
            try:
                temp_output.unlink()
            except OSError:
                pass
        raise
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="JOY Media faster-whisper runner")
    parser.add_argument(
        "--request",
        required=True,
        help="JSON string or path to JSON request file",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory to write transcript.json",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    req_raw = args.request
    if os.path.isfile(req_raw):
        with open(req_raw, "r", encoding="utf-8") as f:
            request = json.load(f)
    else:
        request = json.loads(req_raw)

    output_dir = Path(args.output_dir)
    try:
        transcribe(request, output_dir)
        return 0
    except Exception as err:
        # Short failure report without paths or text in logs
        sys.stderr.write(f"Transcription failed: {type(err).__name__}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
