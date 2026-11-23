#!/usr/bin/env python3
"""Standard-library unittest test suite for faster-whisper speech transcription runner.

Tests cover:
- Chunk offset and overlap
- Repeated real token
- Silence
- Invalid range
- Persian/English switches
- Missing model
- No network-fetch invocation
- Script failure and cleanup
- CLI invocation
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import urllib.request

# Ensure apps/worker/speech and workspace root are in sys.path
_CURRENT_DIR = Path(__file__).resolve().parent
if str(_CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(_CURRENT_DIR))

_ROOT_DIR = _CURRENT_DIR.parents[2]
if str(_ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(_ROOT_DIR))

try:
    from apps.worker.speech import transcribe as runner
except ImportError:
    import transcribe as runner


class MockWord:
    def __init__(self, text: str, start: float, end: float, probability: float = 0.95):
        self.word = text
        self.start = start
        self.end = end
        self.probability = probability


class MockSegment:
    def __init__(self, words: list[MockWord]):
        self.words = words


class TestTranscribeRunner(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="joy_test_stt_")
        self.test_dir = Path(self.temp_dir)
        self.model_dir = self.test_dir / "models" / "large-v3-turbo"
        self.model_dir.mkdir(parents=True, exist_ok=True)

        self.source_file = self.test_dir / "sample.mp4"
        self.source_file.write_bytes(b"\x00" * 1024)

        self.output_dir = self.test_dir / "output"

        self.base_request = {
            "protocol": "joy.speech.v1",
            "type": "speech.transcribe",
            "language": "en",
            "modelId": "large-v3-turbo",
            "modelPath": str(self.model_dir),
            "sourcePath": str(self.source_file),
            "ffmpegPath": "ffmpeg",
        }

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    @patch("apps.worker.speech.transcribe.probe_duration_s")
    @patch("apps.worker.speech.transcribe.decode_window_wav")
    def test_chunk_offset_and_overlap(self, mock_decode, mock_probe):
        """Test bounded decode windows, source-clock offset, and overlap reconciliation."""
        # 45 second media file -> two 31s chunks (chunk 0: 0-31s, chunk 1: 30-45s)
        mock_probe.return_value = 45.0

        def fake_decode(ffmpeg_bin, source_path, start_s, duration_s, output_wav):
            if start_s >= 45.0:
                return False
            output_wav.write_bytes(b"\x00" * 100)
            return True

        mock_decode.side_effect = fake_decode

        chunk0_words = [
            MockWord("hello", start=1.0, end=1.5, probability=0.98),
            MockWord("world", start=29.5, end=29.9, probability=0.95),
            MockWord("bridge", start=30.2, end=30.6, probability=0.90),
        ]
        chunk1_words = [
            # "bridge" repeated in overlap window [30.0 - 31.0s]
            MockWord("bridge", start=0.2, end=0.6, probability=0.92),
            MockWord("future", start=5.0, end=5.5, probability=0.94),
        ]

        mock_model = MagicMock()
        mock_model.transcribe.side_effect = [
            ([MockSegment(chunk0_words)], MagicMock()),
            ([MockSegment(chunk1_words)], MagicMock()),
        ]

        mock_whisper_cls = MagicMock(return_value=mock_model)

        with patch.object(runner, "WhisperModel", mock_whisper_cls):
            runner.transcribe(self.base_request, self.output_dir)

        # Verify model initialization parameters
        mock_whisper_cls.assert_called_once_with(
            str(self.model_dir),
            device="cuda",
            compute_type="float16",
            local_files_only=True,
        )

        out_json = self.output_dir / "transcript.json"
        self.assertTrue(out_json.is_file())
        with open(out_json, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data["language"], "en")
        self.assertEqual(data["speakers"], [])
        self.assertEqual(data["provenance"]["providerId"], "local")
        self.assertEqual(data["provenance"]["modelId"], "large-v3-turbo")

        words = data["words"]
        # Expected 4 words: "hello", "world", "bridge" (deduplicated), "future"
        self.assertEqual(len(words), 4)

        # Word 1: hello in chunk 0
        self.assertEqual(words[0]["text"], "hello")
        self.assertEqual(words[0]["startUs"], 1_000_000)
        self.assertEqual(words[0]["endUs"], 1_500_000)

        # Word 2: world in chunk 0
        self.assertEqual(words[1]["text"], "world")
        self.assertEqual(words[1]["startUs"], 29_500_000)
        self.assertEqual(words[1]["endUs"], 29_900_000)

        # Word 3: bridge (reconciled overlap from 30.2s - 30.6s)
        self.assertEqual(words[2]["text"], "bridge")
        self.assertEqual(words[2]["startUs"], 30_200_000)
        self.assertEqual(words[2]["endUs"], 30_600_000)

        # Word 4: future in chunk 1 (start 5.0s relative to chunk start 30.0s -> 35_000_000)
        self.assertEqual(words[3]["text"], "future")
        self.assertEqual(words[3]["startUs"], 35_000_000)
        self.assertEqual(words[3]["endUs"], 35_500_000)

    @patch("apps.worker.speech.transcribe.probe_duration_s")
    @patch("apps.worker.speech.transcribe.decode_window_wav")
    def test_repeated_real_token(self, mock_decode, mock_probe):
        """Test that genuine repeated tokens spoken by the user are preserved."""
        mock_probe.return_value = 45.0

        def fake_decode(ffmpeg_bin, source_path, start_s, duration_s, output_wav):
            if start_s >= 45.0:
                return False
            output_wav.write_bytes(b"\x00" * 100)
            return True

        mock_decode.side_effect = fake_decode

        # Speaker legitimately said "no no" across the boundary:
        # First "no" at 29.4s, second "no" at 30.3s.
        # Chunk 0 heard both [29.4s, 29.7s] and [30.3s, 30.6s].
        # Chunk 1 (starts at 30.0s) heard the second "no" at [0.3s, 0.6s] -> [30.3s, 30.6s]
        # and "way" at [1.0s, 1.4s] -> [31.0s, 31.4s].
        chunk0_words = [
            MockWord("no", start=29.4, end=29.7),
            MockWord("no", start=30.3, end=30.6),
        ]
        chunk1_words = [
            MockWord("no", start=0.3, end=0.6),
            MockWord("way", start=1.0, end=1.4),
        ]

        mock_model = MagicMock()
        mock_model.transcribe.side_effect = [
            ([MockSegment(chunk0_words)], MagicMock()),
            ([MockSegment(chunk1_words)], MagicMock()),
        ]

        with patch.object(runner, "WhisperModel", MagicMock(return_value=mock_model)):
            runner.transcribe(self.base_request, self.output_dir)

        out_json = self.output_dir / "transcript.json"
        with open(out_json, "r", encoding="utf-8") as f:
            data = json.load(f)

        words = data["words"]
        # Both distinct "no" utterances must be retained; chunk 1's duplicate of the second "no" removed
        self.assertEqual(len(words), 3)
        self.assertEqual(words[0]["text"], "no")
        self.assertEqual(words[0]["startUs"], 29_400_000)

        self.assertEqual(words[1]["text"], "no")
        self.assertEqual(words[1]["startUs"], 30_300_000)

        self.assertEqual(words[2]["text"], "way")
        self.assertEqual(words[2]["startUs"], 31_000_000)

    @patch("apps.worker.speech.transcribe.probe_duration_s")
    @patch("apps.worker.speech.transcribe.decode_window_wav")
    def test_hyphen_and_apostrophe_pieces_continue_the_previous_word(
        self, mock_decode, mock_probe
    ):
        """Whisper gives 'text-to-speech' as ' text', '-to', '-speech': one word, not three."""
        mock_probe.return_value = 10.0

        def fake_decode(ffmpeg_bin, source_path, start_s, duration_s, output_wav):
            if start_s >= 10.0:
                return False
            output_wav.write_bytes(b"\x00" * 100)
            return True

        mock_decode.side_effect = fake_decode
        pieces = [
            MockWord(" local", start=1.0, end=1.3),
            MockWord(" text", start=1.3, end=1.6),
            MockWord("-to", start=1.6, end=1.8),
            MockWord("-speech", start=1.8, end=2.3),
            MockWord(" it", start=2.4, end=2.5),
            MockWord("'s", start=2.5, end=2.7),
            MockWord(" fine.", start=2.8, end=3.1),
        ]
        mock_model = MagicMock()
        mock_model.transcribe.side_effect = [([MockSegment(pieces)], MagicMock())]

        with patch.object(runner, "WhisperModel", MagicMock(return_value=mock_model)):
            runner.transcribe(self.base_request, self.output_dir)

        with open(self.output_dir / "transcript.json", "r", encoding="utf-8") as f:
            words = json.load(f)["words"]
        self.assertEqual(
            [word["text"] for word in words], ["local", "text-to-speech", "it's", "fine."]
        )
        # The merged word spans all of its pieces.
        self.assertEqual(words[1]["startUs"], 1_300_000)
        self.assertEqual(words[1]["endUs"], 2_300_000)

    @patch("apps.worker.speech.transcribe.probe_duration_s")
    @patch("apps.worker.speech.transcribe.decode_window_wav")
    def test_silence(self, mock_decode, mock_probe):
        """Test audio with no speech / pure silence produces empty words without error."""
        mock_probe.return_value = 10.0

        def fake_decode(ffmpeg_bin, source_path, start_s, duration_s, output_wav):
            if start_s >= 10.0:
                return False
            output_wav.write_bytes(b"\x00" * 100)
            return True

        mock_decode.side_effect = fake_decode

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([], MagicMock())

        with patch.object(runner, "WhisperModel", MagicMock(return_value=mock_model)):
            runner.transcribe(self.base_request, self.output_dir)

        out_json = self.output_dir / "transcript.json"
        self.assertTrue(out_json.is_file())
        with open(out_json, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data["words"], [])
        self.assertEqual(data["language"], "en")
        self.assertEqual(data["speakers"], [])
        self.assertEqual(data["provenance"]["modelId"], "large-v3-turbo")

    def test_invalid_range(self):
        """Test invalid range specifications raise ValueError and clean up output."""
        invalid_ranges = [
            {"startUs": -100, "endUs": 5000},
            {"startUs": 5000, "endUs": 4000},
            {"startUs": 5000, "endUs": 5000},
            {"startUs": "zero", "endUs": 5000},
            {"startUs": 1000, "endUs": "ten"},
            "not_a_dict",
        ]

        for bad_range in invalid_ranges:
            req = dict(self.base_request)
            req["range"] = bad_range

            out_dir = self.test_dir / f"out_bad_{abs(hash(str(bad_range)))}"
            with self.assertRaises(ValueError):
                runner.transcribe(req, out_dir)

            # Ensure no incomplete output left
            self.assertFalse((out_dir / "transcript.json").exists())

    @patch("apps.worker.speech.transcribe.probe_duration_s")
    @patch("apps.worker.speech.transcribe.decode_window_wav")
    def test_persian_english_switches(self, mock_decode, mock_probe):
        """Test multilingual Persian and English switches and unicode character preservation."""
        mock_probe.return_value = 10.0

        def fake_decode(ffmpeg_bin, source_path, start_s, duration_s, output_wav):
            if start_s >= 10.0:
                return False
            output_wav.write_bytes(b"\x00" * 100)
            return True

        mock_decode.side_effect = fake_decode

        bilingual_words = [
            MockWord("سلام", start=0.5, end=1.0, probability=0.98),
            MockWord("world", start=1.2, end=1.7, probability=0.96),
            MockWord("پروژه", start=2.0, end=2.5, probability=0.97),
            MockWord("JOY", start=2.7, end=3.1, probability=0.99),
        ]

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([MockSegment(bilingual_words)], MagicMock())

        req = dict(self.base_request)
        req["language"] = "fa"

        with patch.object(runner, "WhisperModel", MagicMock(return_value=mock_model)):
            runner.transcribe(req, self.output_dir)

        out_json = self.output_dir / "transcript.json"
        raw_text = out_json.read_text(encoding="utf-8")

        # Must contain verbatim Persian characters, not escaped unicode sequences like \u0633
        self.assertIn("سلام", raw_text)
        self.assertIn("پروژه", raw_text)
        self.assertIn("world", raw_text)
        self.assertIn("JOY", raw_text)

        data = json.loads(raw_text)
        self.assertEqual(data["language"], "fa")
        self.assertEqual(mock_model.transcribe.call_args.kwargs["language"], "fa")
        words = data["words"]
        self.assertEqual(len(words), 4)
        self.assertEqual(words[0]["text"], "سلام")
        self.assertEqual(words[0]["startUs"], 500_000)
        self.assertEqual(words[1]["text"], "world")
        self.assertEqual(words[1]["startUs"], 1_200_000)
        self.assertEqual(words[2]["text"], "پروژه")
        self.assertEqual(words[2]["startUs"], 2_000_000)
        self.assertEqual(words[3]["text"], "JOY")
        self.assertEqual(words[3]["startUs"], 2_700_000)

    @patch("apps.worker.speech.transcribe.probe_duration_s", return_value=5.0)
    @patch("apps.worker.speech.transcribe.decode_window_wav", return_value=True)
    def test_contract_locale_is_mapped_for_whisper_and_preserved_in_transcript(self, _decode, _probe):
        for locale, model_language in (("en-US", "en"), ("fa-IR", "fa")):
            with self.subTest(locale=locale):
                request = dict(self.base_request, language=locale)
                model = MagicMock()
                model.transcribe.return_value = ([], MagicMock())
                with patch.object(runner, "WhisperModel", MagicMock(return_value=model)):
                    runner.transcribe(request, self.output_dir)
                self.assertEqual(model.transcribe.call_args.kwargs["language"], model_language)
                transcript = json.loads((self.output_dir / "transcript.json").read_text(encoding="utf-8"))
                self.assertEqual(transcript["language"], locale)

    def test_missing_model(self):
        """Test missing model directory raises FileNotFoundError before any model load."""
        req = dict(self.base_request)
        req["modelPath"] = str(self.test_dir / "non_existent_model_dir")

        with self.assertRaises(FileNotFoundError):
            runner.transcribe(req, self.output_dir)

        self.assertFalse((self.output_dir / "transcript.json").exists())

    @patch("apps.worker.speech.transcribe.probe_duration_s")
    @patch("apps.worker.speech.transcribe.decode_window_wav")
    def test_no_network_fetch_invocation(self, mock_decode, mock_probe):
        """Verify model uses local_files_only=True and never makes network calls."""
        mock_probe.return_value = 5.0
        mock_decode.return_value = True

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([], MagicMock())
        mock_whisper_cls = MagicMock(return_value=mock_model)

        # Mock network sockets to fail if any network access is attempted
        with patch.object(socket, "create_connection", side_effect=AssertionError("Network accessed!")):
            with patch.object(urllib.request, "urlopen", side_effect=AssertionError("Network accessed!")):
                with patch.object(runner, "WhisperModel", mock_whisper_cls):
                    runner.transcribe(self.base_request, self.output_dir)

        mock_whisper_cls.assert_called_once_with(
            str(self.model_dir),
            device="cuda",
            compute_type="float16",
            local_files_only=True,
        )

    @patch("apps.worker.speech.transcribe.probe_duration_s")
    @patch("apps.worker.speech.transcribe.decode_window_wav")
    def test_failure_cleans_incomplete_output(self, mock_decode, mock_probe):
        """Verify that an error during transcription removes partial output files."""
        mock_probe.return_value = 30.0
        mock_decode.return_value = True

        mock_model = MagicMock()
        mock_model.transcribe.side_effect = RuntimeError("Simulated GPU crash")

        with patch.object(runner, "WhisperModel", MagicMock(return_value=mock_model)):
            with self.assertRaises(RuntimeError):
                runner.transcribe(self.base_request, self.output_dir)

        out_json = self.output_dir / "transcript.json"
        self.assertFalse(out_json.exists())

    @patch("apps.worker.speech.transcribe.probe_duration_s")
    @patch("apps.worker.speech.transcribe.decode_window_wav")
    def test_cli_invocation(self, mock_decode, mock_probe):
        """Verify CLI interface with --request and --output-dir."""
        mock_probe.return_value = 5.0
        mock_decode.return_value = True

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([], MagicMock())

        # Test CLI with JSON file
        req_file = self.test_dir / "request.json"
        req_file.write_text(json.dumps(self.base_request), encoding="utf-8")

        with patch.object(runner, "WhisperModel", MagicMock(return_value=mock_model)):
            exit_code = runner.main(["--request", str(req_file), "--output-dir", str(self.output_dir)])

        self.assertEqual(exit_code, 0)
        self.assertTrue((self.output_dir / "transcript.json").is_file())

        # Test CLI with raw JSON string
        out_dir2 = self.test_dir / "output2"
        with patch.object(runner, "WhisperModel", MagicMock(return_value=mock_model)):
            exit_code2 = runner.main(["--request", json.dumps(self.base_request), "--output-dir", str(out_dir2)])

        self.assertEqual(exit_code2, 0)
        self.assertTrue((out_dir2 / "transcript.json").is_file())


if __name__ == "__main__":
    unittest.main()
