"""Source discovery and hashing. The scanner never writes to source folders."""

from __future__ import annotations

from hashlib import sha256
from pathlib import Path


PNG_SUFFIXES = {".png"}


def scan_sources(input_path: Path, recursive: bool = False) -> list[Path]:
    """Return a deterministic list of PNG files from a file or folder."""
    path = input_path.expanduser().resolve()
    if path.is_file():
        return [path] if path.suffix.lower() in PNG_SUFFIXES else []
    if not path.is_dir():
        raise FileNotFoundError(f"Input path does not exist: {path}")
    iterator = path.rglob("*") if recursive else path.glob("*")
    return sorted(
        (candidate.resolve() for candidate in iterator if candidate.is_file() and candidate.suffix.lower() in PNG_SUFFIXES),
        key=lambda candidate: str(candidate).casefold(),
    )


def source_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_relative_path(source: Path, root: Path) -> str:
    try:
        return source.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return source.name

