# Alpha Asset Library Builder

This temporary migration skill splits transparent PNG sheets into reusable RGBA assets for the JOY Media Asset Library. It is copy-only: source files are never modified, and exported assets are never silently overwritten.

## Installed Components

- Python package and alpha-assets CLI
- Alpha-channel detector using Pillow, NumPy, and OpenCV
- Conservative detached-piece/text grouping
- Exact RGBA and perceptual duplicate tracking
- SQLite checkpoints for safe resume
- PNG metadata sidecars, JSON/CSV manifests, reports, review CSVs, and paginated contact sheets
- Optional TypeScript reader at typescript/joy-media-asset-adapter.ts

## Setup

The skill has an isolated environment at .venv. Reinstall after dependency changes:

```powershell
.\.venv\Scripts\python.exe -m pip install -e . pytest
```

The local alpha-assets wrapper invokes that environment. Verify it:

```powershell
alpha-assets --help
```

## Migration

Run a resumable batch:

```powershell
alpha-assets extract "H:\1 - start new win\files\momentum\posts\RAW GRAPHICS\New folder" --recursive --output "H:\1 - start new win\files\momentum\posts\RAW GRAPHICS\joy-media-assets" --workers 4 --resume
```

Only .png files are considered. Files with no usable alpha are recorded in reports/failed-files.json and do not interrupt the batch. Use --allow-opaque only to export a fully opaque source as one item.

## Review And Naming

The CLI never requires a local heavyweight vision model. It creates deterministic offline names such as unknown-visual-0001.png and routes uncertain assets to assets/unknown/.

Use Codex image understanding to review the contact sheets and fill review-needed.csv, then apply changes:

```powershell
alpha-assets apply-review "H:\...\joy-media-assets\review-needed.csv" --output "H:\...\joy-media-assets"
```

The reports/semantic-review-requests.jsonl file lists uncertain crop keys for a batch vision handoff. Pass the completed semantic-results.jsonl through --semantic-jsonl; the result format is in references/semantic-naming.md.

## Commands

```text
alpha-assets extract <image-or-folder> [--recursive] [--output PATH] [--resume]
alpha-assets resume <folder> [--output PATH] [--workers N]
alpha-assets analyze <image> [--json]
alpha-assets review <package>
alpha-assets status <package> [--json]
alpha-assets prepare-cloud <package> [--minimum-alpha-pixels 128] [--json]
alpha-assets rebuild-manifest <package>
alpha-assets reset-checkpoint <package> --yes
alpha-assets apply-review <corrections.csv> [--output PATH]
```

Useful extraction switches:

```text
--alpha-threshold --core-alpha-threshold --padding --workers --force
--no-grouping --split-text-characters --no-visual-naming --semantic-jsonl
--no-contact-sheet --debug --largest-only --minimum-area --dry-run
--keep-exact-duplicates --skip-visual-duplicates --duplicate-threshold --allow-opaque
```

## Outputs

```text
joy-media-assets/
  assets/
    arrows/ characters/ decorations/ effects/ fire/ icons/ light/
    logos/ objects/ shapes/ smoke/ text/ ui/ unknown/
  contact-sheets/
  manifests/manifest.json
  manifests/manifest.csv
  reports/processing-report.json
  reports/failed-files.json
  reports/duplicate-assets.json
  checkpoints/checkpoint.sqlite3
  debug/
  review-needed.csv
```

Each exported PNG has a same-name JSON sidecar. Manifests use portable asset paths and include source bounds, export bounds, alpha area, hashes, confidence, and duplicate relationships.

prepare-cloud stages immutable joylib-<sha256> objects and excludes only
sub-128-alpha-pixel artifacts by default. Its cloud manifest records every
excluded item and the active threshold in qualityGate.

## Test Fixtures

Generate deterministic fixtures with:

```powershell
.\.venv\Scripts\python.exe scripts\generate_fixtures.py
```

The suite covers single and multiple assets, a detached shadow, low-alpha glow, text with a dotted letter, tiny noise, 121 independent objects, edge crops, a semi-transparent-only asset, opaque handling, duplicate sheets, resume behavior, corrupted inputs, and Unicode source names.

Run it in a writable local temp location:

```powershell
New-Item -ItemType Directory -Force test-output\pytest | Out-Null
.\.venv\Scripts\pytest.exe --basetemp test-output\pytest
```
