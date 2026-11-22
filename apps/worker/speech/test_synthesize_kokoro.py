import json
import tempfile
import unittest
from array import array
from pathlib import Path
from unittest.mock import patch

import synthesize_kokoro as runner


class KokoroRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.model = self.root / "model"
        self.model.mkdir()
        (self.model / "config.json").write_text("{}", encoding="utf-8")
        (self.model / "kokoro-v1_0.pth").write_bytes(b"weights")
        self.voices = self.model / "voices"
        self.voices.mkdir()
        (self.voices / "af_heart.pt").write_bytes(b"voice")
        self.output = self.root / "out"
        self.request = {
            "protocol": "joy.speech.v1",
            "type": "speech.synthesize",
            "language": "en-US",
            "modelId": "kokoro-82m",
            "modelPath": str(self.model),
            "text": "Hello there.",
        }

    def tearDown(self):
        self.temp.cleanup()

    def tokenizer_specs(self, name):
        if name in {"misaki", "spacy", "en_core_web_sm", "kokoro", "torch"}:
            return object()
        return None

    def test_missing_config_stops_before_engine_load(self):
        (self.model / "config.json").unlink()
        with patch.object(runner, "_load_engine") as load:
            with self.assertRaisesRegex((FileNotFoundError, ValueError), "config"):
                runner.synthesize(self.request, self.output)
            load.assert_not_called()

    def test_missing_voice_stops_before_engine_load(self):
        (self.voices / "af_heart.pt").unlink()
        with patch.object(runner, "_load_engine") as load:
            with self.assertRaisesRegex(FileNotFoundError, "voice"):
                runner.synthesize(self.request, self.output)
            load.assert_not_called()

    def test_missing_tokenizer_stops_before_engine_load(self):
        with patch.object(runner.importlib.util, "find_spec", side_effect=lambda name: None if name == "misaki" else self.tokenizer_specs(name)):
            with patch.object(runner, "_load_engine") as load:
                with self.assertRaisesRegex(RuntimeError, "Misaki"):
                    runner.synthesize(self.request, self.output)
                load.assert_not_called()

    def test_rejects_language_mismatch(self):
        self.request["language"] = "fa-IR"
        with patch.object(runner, "_load_engine") as load:
            with self.assertRaisesRegex(ValueError, "en-US"):
                runner.synthesize(self.request, self.output)
            load.assert_not_called()

    def test_native_timings_use_sample_boundaries(self):
        timings = runner._normalize_native_timings(
            [{"text": "Hello", "startSample": 1, "endSample": 3}],
            "Hello",
            sample_rate=4,
            frame_count=4,
        )
        self.assertEqual(timings, [
            {"text": "Hello", "startUs": 250_000, "endUs": 750_000}
        ])

    def test_missing_or_invalid_timings_are_unavailable(self):
        self.assertEqual(runner._normalize_native_timings(None, "Hello there.", 4, 4), [])
        self.assertEqual(
            runner._normalize_native_timings(
                [{"text": "Wrong", "startSample": 1, "endSample": 2}],
                "Hello there.",
                4,
                4,
            ),
            [],
        )

    def test_writes_nonempty_pcm_wav_and_unavailable_timings(self):
        class FakeEngine:
            def __call__(self, text, voice):
                yield "Hello there.", "", array("f", [0.0, 0.5, -0.5])

        with patch.object(runner.importlib.util, "find_spec", side_effect=self.tokenizer_specs):
            with patch.object(runner, "_load_engine", return_value=FakeEngine()):
                with patch.object(runner, "_load_voice", return_value=object()):
                    runner.synthesize(self.request, self.output)

        wav_path = self.output / "voice.wav"
        timings_path = self.output / "timings.json"
        self.assertTrue(wav_path.is_file())
        self.assertGreater(wav_path.stat().st_size, 44)
        timings = json.loads(timings_path.read_text(encoding="utf-8"))
        self.assertEqual(timings["timingSource"], "unavailable")
        self.assertEqual(timings["words"], [])
        self.assertEqual(timings["durationUs"], round(3 * 1_000_000 / runner.SAMPLE_RATE))


if __name__ == "__main__":
    unittest.main()
