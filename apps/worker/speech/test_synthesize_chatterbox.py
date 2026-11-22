import importlib.metadata
import json
import tempfile
import unittest
import wave
from array import array
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

import synthesize_chatterbox as runner


class ChatterboxRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.model = self.root / "model"
        self.model.mkdir()
        (self.model / "config.json").write_text("{}", encoding="utf-8")
        (self.model / "t3.safetensors").write_bytes(b"checkpoint")
        (self.model / "s3gen.safetensors").write_bytes(b"checkpoint")
        (self.model / "ve.pt").write_bytes(b"checkpoint")
        (self.model / "tokenizer.json").write_text("{}", encoding="utf-8")
        self.reference = self.root / "reference.wav"
        with wave.open(str(self.reference), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(24_000)
            audio.writeframes(array("h", [0, 1, 2]).tobytes())
        self.output = self.root / "out"
        self.request = {
            "protocol": "joy.speech.v1",
            "type": "speech.synthesize",
            "language": "en-US",
            "modelId": "chatterbox-en",
            "modelPath": str(self.model),
            "text": "Hello there.",
        }

    def tearDown(self):
        self.temp.cleanup()

    def _with_fake_chatterbox(self, model=None):
        package = ModuleType("chatterbox")
        package.__path__ = []
        tts = ModuleType("chatterbox.tts")
        if model is None:
            class FakeModel:
                sample_rate = 24_000

                def generate(self, text, audio_prompt_path=None):
                    self.audio_prompt_path = audio_prompt_path
                    return array("f", [0.0, 0.5, -0.5])

            model = FakeModel()
        tts.ChatterboxTTS = type(
            "FakeChatterboxTTS",
            (),
            {"from_local": staticmethod(lambda path: model)},
        )
        return patch.dict("sys.modules", {"chatterbox": package, "chatterbox.tts": tts})

    def _patch_version(self, version="0.1.7"):
        return patch.object(importlib.metadata, "version", return_value=version)

    def test_rejects_language_model_mismatch(self):
        self.request["language"] = "fa-IR"
        with patch.object(runner, "_load_engine") as load:
            with self.assertRaisesRegex(ValueError, "en-US"):
                runner.synthesize(self.request, self.output)
            load.assert_not_called()

    def test_missing_expanded_tokenizer_stops_before_engine_load(self):
        (self.model / "tokenizer.json").unlink()
        self.request.update(language="fa-IR", modelId="chatterbox-fa", nonCommercial=True)
        with self._patch_version(), patch.object(runner, "_load_engine") as load:
            with self.assertRaisesRegex(FileNotFoundError, "tokenizer"):
                runner.synthesize(self.request, self.output)
            load.assert_not_called()

    def test_persian_requires_staged_reference(self):
        self.request.update(language="fa-IR", modelId="chatterbox-fa", nonCommercial=True)
        with self._patch_version(), self._with_fake_chatterbox():
            with self.assertRaisesRegex(ValueError, "reference"):
                runner.synthesize(self.request, self.output)

    def test_persian_requires_trusted_non_commercial_flag(self):
        self.request.update(language="fa-IR", modelId="chatterbox-fa")
        self.request["referencePath"] = str(self.reference)
        with self._patch_version():
            with self.assertRaisesRegex(ValueError, "non-commercial"):
                runner.synthesize(self.request, self.output)

    def test_english_reference_is_optional_or_used_when_present(self):
        with self._patch_version(), self._with_fake_chatterbox():
            runner.synthesize(self.request, self.output)
        self.assertTrue((self.output / "voice.wav").is_file())

        self.request["referencePath"] = str(self.reference)
        model = type(
            "FakeModel",
            (),
            {
                "sample_rate": 24_000,
                "generate": lambda self, text, audio_prompt_path=None: setattr(
                    self, "audio_prompt_path", audio_prompt_path
                )
                or array("f", [0.0, 0.25]),
            },
        )()
        with self._patch_version(), self._with_fake_chatterbox(model):
            runner.synthesize(self.request, self.output)
        self.assertEqual(model.audio_prompt_path, str(self.reference))

    def test_unavailable_native_timing_writes_truthful_duration(self):
        with self._patch_version(), self._with_fake_chatterbox():
            runner.synthesize(self.request, self.output)
        timings = json.loads((self.output / "timings.json").read_text(encoding="utf-8"))
        self.assertEqual(timings, {
            "durationUs": round(3 * 1_000_000 / 24_000),
            "timingSource": "unavailable",
            "words": [],
        })

    def test_engine_uses_only_local_loader(self):
        calls = []

        class FakeTTS:
            @classmethod
            def from_local(cls, path):
                calls.append(("local", path))
                return object()

            @classmethod
            def from_pretrained(cls, *args, **kwargs):
                calls.append(("download", args, kwargs))
                raise AssertionError("download loader must not be called")

        package = ModuleType("chatterbox")
        package.__path__ = []
        tts = ModuleType("chatterbox.tts")
        tts.ChatterboxTTS = FakeTTS
        with patch.dict("sys.modules", {"chatterbox": package, "chatterbox.tts": tts}):
            runner._load_engine(self.model)
        self.assertEqual(calls, [("local", str(self.model))])

    def test_rejects_old_chatterbox_version(self):
        with patch.object(importlib.metadata, "version", return_value="0.1.6"):
            with self.assertRaisesRegex(RuntimeError, "0.1.7"):
                runner._verify_local_setup(self.model, "en-US")


if __name__ == "__main__":
    unittest.main()
