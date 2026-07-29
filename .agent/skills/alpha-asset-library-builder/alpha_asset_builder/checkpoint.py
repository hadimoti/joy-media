"""SQLite checkpoint storage for safe, resumable batch processing."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .models import PROCESSING_VERSION, SourceResult, utc_now


class CheckpointStore:
    def __init__(self, database_path: Path) -> None:
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(database_path)
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS source_checkpoints (
              source_path TEXT PRIMARY KEY,
              source_hash TEXT NOT NULL,
              status TEXT NOT NULL,
              extracted_assets INTEGER NOT NULL DEFAULT 0,
              skipped_exact_duplicates INTEGER NOT NULL DEFAULT 0,
              error TEXT,
              output_paths TEXT NOT NULL DEFAULT '[]',
              processing_version TEXT NOT NULL,
              processed_at TEXT NOT NULL
            )
            """
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def is_complete(self, source_path: str, source_hash: str) -> bool:
        row = self.connection.execute(
            "SELECT status, source_hash FROM source_checkpoints WHERE source_path = ?",
            (source_path,),
        ).fetchone()
        return bool(row and row[0] == "complete" and row[1] == source_hash)

    def mark(self, result: SourceResult, output_paths: list[str] | None = None) -> None:
        self.connection.execute(
            """
            INSERT INTO source_checkpoints (
              source_path, source_hash, status, extracted_assets,
              skipped_exact_duplicates, error, output_paths,
              processing_version, processed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_path) DO UPDATE SET
              source_hash=excluded.source_hash,
              status=excluded.status,
              extracted_assets=excluded.extracted_assets,
              skipped_exact_duplicates=excluded.skipped_exact_duplicates,
              error=excluded.error,
              output_paths=excluded.output_paths,
              processing_version=excluded.processing_version,
              processed_at=excluded.processed_at
            """,
            (
                result.source_path,
                result.source_hash,
                result.status,
                result.extracted_assets,
                result.skipped_exact_duplicates,
                result.error,
                json.dumps(output_paths or []),
                PROCESSING_VERSION,
                utc_now(),
            ),
        )
        self.connection.commit()

    def summary(self) -> dict[str, int]:
        rows = self.connection.execute(
            "SELECT status, COUNT(*) FROM source_checkpoints GROUP BY status"
        ).fetchall()
        return {str(status): int(count) for status, count in rows}

    def reset(self) -> int:
        cursor = self.connection.execute("DELETE FROM source_checkpoints")
        self.connection.commit()
        return int(cursor.rowcount)

