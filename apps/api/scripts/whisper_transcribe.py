#!/usr/bin/env python3
"""CLI: faster-whisper transcription → JSON on stdout.

Usage:
  whisper_transcribe.py --audio /path/to.wav --language fa [--model tiny]
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--language", required=True, help="fa | en | fa-IR | en-US")
    parser.add_argument(
        "--model",
        default=os.environ.get("JOY_MEDIA_WHISPER_MODEL", "tiny"),
    )
    parser.add_argument(
        "--download-root",
        default=os.environ.get(
            "JOY_MEDIA_WHISPER_MODEL_DIR",
            "/opt/joy-media/data/whisper-models",
        ),
    )
    args = parser.parse_args()

    lang = args.language.strip().lower()
    if lang.startswith("fa"):
        whisper_lang = "fa"
        out_lang = "fa-IR"
    elif lang.startswith("en"):
        whisper_lang = "en"
        out_lang = "en-US"
    else:
        whisper_lang = lang[:2]
        out_lang = args.language

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        print(json.dumps({"error": f"faster-whisper unavailable: {exc}"}), file=sys.stderr)
        return 2

    os.makedirs(args.download_root, exist_ok=True)
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=args.download_root,
    )
    segments, info = model.transcribe(
        args.audio,
        language=whisper_lang,
        word_timestamps=True,
        vad_filter=True,
    )

    words = []
    for segment in segments:
        segment_words = getattr(segment, "words", None) or []
        if segment_words:
            for word in segment_words:
                text = (word.word or "").strip()
                if not text:
                    continue
                words.append(
                    {
                        "text": text,
                        "startUs": int(round(float(word.start) * 1_000_000)),
                        "endUs": int(round(float(word.end) * 1_000_000)),
                        "confidence": float(getattr(word, "probability", 0.9) or 0.9),
                        "speakerId": "speaker-1",
                    }
                )
        else:
            text = (segment.text or "").strip()
            if text:
                words.append(
                    {
                        "text": text,
                        "startUs": int(round(float(segment.start) * 1_000_000)),
                        "endUs": int(round(float(segment.end) * 1_000_000)),
                        "confidence": 0.85,
                        "speakerId": "speaker-1",
                    }
                )

    payload = {
        "language": out_lang,
        "modelId": f"faster-whisper-{args.model}",
        "detectedLanguage": getattr(info, "language", whisper_lang),
        "speakers": [{"id": "speaker-1", "name": "Speaker 1"}],
        "words": words,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
