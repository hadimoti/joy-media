from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.generate_fixtures import generate  # noqa: E402


@pytest.fixture(scope="session")
def fixtures() -> Path:
    directory = ROOT / "tests" / "fixtures"
    generate(directory)
    return directory

