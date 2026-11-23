import importlib.metadata
import json
import tempfile
import unittest
import wave
from array import array
from pathlib import Path
from unittest.mock import patch

import synthesize_chatterbox as runner


def touch(path: Path, content: bytes = b"x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


class FakeEnglish:
    sr = 24_000

    def generate(self, text, audio_prompt_path=None):
        self.reference = audio_prompt_path
        return array("f", [0.0, 0.25, -0.25])


class FakePersian:
    sr = 24_000

    def synthesize(self, text, reference, exaggeration, seed, auto_ezafe):
        self.args = (text, reference, exaggeration, seed, auto_ezafe)
        return array("f", [0.0, 0.3, -0.3])


class ChatterboxRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.model = self.root / "model"
        self.model.mkdir()
        self.reference = self.root / "reference.wav"
        self.reference.write_bytes(b"reference")
        self.output = self.root / "out"
        self.request = {
            "protocol": "joy.speech.v1", "type": "speech.synthesize",
            "language": "en-US", "modelId": "chatterbox-en",
            "modelPath": str(self.model), "text": "Hello there.",
        }

    def tearDown(self):
        self.temp.cleanup()

    def _english_files(self, legacy=False):
        names = ("ve.pt", "s3gen.pt", "t3.safetensors", "tokenizer.json") if legacy else (
            "conds.pt", "s3gen.safetensors", "t3_cfg.safetensors", "tokenizer.json", "ve.safetensors"
        )
        for name in names:
            touch(self.model / name)

    def _persian_files(self, base):
        touch(self.model / "t3_fa_expressive.safetensors")
        touch(self.model / "persian_tts_engine.py")
        touch(self.model / "grapheme_mtl_merged_expanded_v1.json")
        touch(base / "ve.safetensors")
        touch(base / "s3gen.safetensors")

    def _patch_version(self):
        return patch.object(importlib.metadata, "version", return_value="0.1.7")

    def test_english_accepts_real_layout_and_generates_pcm16_wav(self):
        self._english_files()
        engine = FakeEnglish()
        with self._patch_version(), patch.object(runner, "_load_engine", return_value=engine):
            runner.synthesize(self.request, self.output)
        with wave.open(str(self.output / "voice.wav"), "rb") as wav:
            self.assertEqual((wav.getframerate(), wav.getsampwidth(), wav.getnframes()), (24_000, 2, 3))
        self.assertEqual(engine.reference, None)
        self.assertEqual(json.loads((self.output / "timings.json").read_text()), {
            "durationUs": 125, "timingSource": "unavailable", "words": []
        })

    def test_english_accepts_legacy_names_as_alternates(self):
        self._english_files(legacy=True)
        with self._patch_version(), patch.object(runner, "_load_engine", return_value=FakeEnglish()):
            runner.synthesize(self.request, self.output)
        self.assertTrue((self.output / "voice.wav").is_file())

    def test_persian_loads_from_explicit_base_and_uses_fixed_defaults(self):
        base = self.root / "explicit-base"
        self._persian_files(base)
        self.request.update(language="fa-IR", modelId="chatterbox-fa", nonCommercial=True,
                            referencePath=str(self.reference), basePath=str(base), text="سلام دنیا")
        engine = FakePersian()
        with self._patch_version(), patch.object(runner, "_load_persian_engine", return_value=engine):
            runner.synthesize(self.request, self.output)
        self.assertEqual(engine.args, ("سلام دنیا", str(self.reference), 0.45, 7, False))
        self.assertEqual(json.loads((self.output / "timings.json").read_text())["timingSource"], "unavailable")

    def test_persian_finds_sibling_english_base(self):
        base = self.root / "chatterbox-en"
        self._persian_files(base)
        self.request.update(language="fa-IR", modelId="chatterbox-fa", nonCommercial=True,
                            referencePath=str(self.reference))
        with self._patch_version(), patch.object(runner, "_load_persian_engine", return_value=FakePersian()):
            runner.synthesize(self.request, self.output)

    def test_persian_requires_consent_reference_tokenizer_and_base_files(self):
        self._persian_files(self.root / "chatterbox-english")
        self.request.update(language="fa-IR", modelId="chatterbox-fa", referencePath=str(self.reference))
        with self._patch_version(), self.assertRaisesRegex(ValueError, "non-commercial"):
            runner.synthesize(self.request, self.output)
        self.request["nonCommercial"] = True
        self.request.pop("referencePath")
        with self._patch_version(), self.assertRaisesRegex(ValueError, "reference"):
            runner.synthesize(self.request, self.output)
        self.request["referencePath"] = str(self.reference)
        (self.model / "grapheme_mtl_merged_expanded_v1.json").unlink()
        with self._patch_version(), self.assertRaisesRegex(FileNotFoundError, "tokenizer"):
            runner.synthesize(self.request, self.output)
        (self.model / "tokenizer.json").write_text("{}")
        (self.root / "chatterbox-english" / "ve.safetensors").unlink()
        with self._patch_version(), self.assertRaisesRegex(FileNotFoundError, "base"):
            runner.synthesize(self.request, self.output)

    def test_language_mismatch_is_refused_before_loading(self):
        self.request["language"] = "fa-IR"
        with patch.object(runner, "_load_engine") as load, self.assertRaisesRegex(ValueError, "en-US"):
            runner.synthesize(self.request, self.output)
        load.assert_not_called()


if __name__ == "__main__":
    unittest.main()
