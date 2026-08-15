#!/usr/bin/env python3
"""Route JOY masking requests to the local BiRefNet or SAM 2 adapter.

Both adapters keep source paths and model weights on the paired Worker. This
small dispatcher lets one qualified local Python environment expose precise
SAM selection/tracking and fast BiRefNet foreground mattes through the same
Worker contract.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def runner_for(request_path: Path) -> Path:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    settings = request.get("settings", {})
    selection = settings.get("selection", {}) if isinstance(settings, dict) else {}
    provider = settings.get("provider") if isinstance(settings, dict) else None
    mode = selection.get("mode") if isinstance(selection, dict) else None
    # Auto preserves the fast local matte path for the two modes BiRefNet
    # understands; all precise or temporal modes require SAM 2.
    use_birefnet = provider == "birefnet" or (provider == "auto" and mode in {"subject", "person"})
    return Path(__file__).with_name("joy_mask_runner.py" if use_birefnet else "joy_sam2_runner.py")


def main() -> int:
    args = parse_args()
    runner = runner_for(Path(args.request))
    result = subprocess.run(
        [sys.executable, str(runner), "--request", args.request, "--output", args.output],
        check=False,
    )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
