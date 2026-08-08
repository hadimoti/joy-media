---
name: alpha-asset-library-builder
description: Extract, split, organize, review, and import transparent PNG sheets as a resumable asset-library package. Use when separating alpha-channel graphics, splitting non-grid sprite sheets, processing old Precision Automation exports, cropping visible PNG elements, naming and tagging graphic assets, or preparing a JOY Media Asset Library migration. Do not use for ordinary rectangular crops, photo background removal, video work, or opaque images unless alpha segmentation is explicitly requested.
---

# Alpha Asset Library Builder

Use this skill to turn transparent PNG sheets into individual RGBA assets without modifying source files.

## Run The Extraction

1. Confirm the input is a PNG or directory of PNGs with usable alpha.
2. Choose a new output folder outside the source directory when possible.
3. Run the package with resume enabled:

```powershell
alpha-assets extract "C:\archive" --recursive --output "C:\joy-media-assets" --workers 4 --resume
```

4. Inspect contact-sheets/, review-needed.csv, and reports/failed-files.json.
5. Correct uncertain items with alpha-assets apply-review review-needed.csv --output <package>.

Never delete or modify source sheets. Never use --allow-opaque unless the user explicitly wants a fully opaque image copied as one asset.

## Extraction Behavior

- Use alpha > 4 to retain soft glows, blur, antialiasing, and shadows.
- Use alpha > 24 for stable eight-way core connected components.
- Filter only clearly accidental tiny, faint, narrow regions; retain legitimate lines and sparks.
- Group via low-alpha bridges, small attachments, shadows, and narrow text glyph alignment. Do not group neighboring icons solely from bounding-box overlap.
- Preserve exceptionally high-count, uniform dotted illustrations such as world maps as one visual, while keeping separate non-overlapping logos or charts independent.
- Crop original RGBA pixels with transparent padding. Do not flatten, resize, or overwrite assets.
- Skip exact RGBA duplicates by default; retain visual duplicates unless --skip-visual-duplicates is explicit.

## Semantic Review

The executable works offline with deterministic names and sends uncertain assets to review-needed.csv. For semantic names, use the agent's image understanding to inspect contact sheets or individual exported PNGs, then apply a review CSV.

For bulk model/agent results, produce a JSONL file matching [references/semantic-naming.md](references/semantic-naming.md) and pass it through --semantic-jsonl.

## Useful Commands

```powershell
alpha-assets analyze sheet.png --json
alpha-assets status C:\joy-media-assets
alpha-assets review C:\joy-media-assets
alpha-assets prepare-cloud C:\joy-media-assets --minimum-alpha-pixels 128 --json
alpha-assets rebuild-manifest C:\joy-media-assets
alpha-assets resume C:\archive --output C:\joy-media-assets --workers 4
alpha-assets reset-checkpoint C:\joy-media-assets --yes
```

reset-checkpoint deletes only resume records and requires --yes; it never deletes exported assets.

prepare-cloud uses immutable content-hash refs and records a quality gate in
the import manifest. The default gate excludes only sub-128-alpha-pixel
artifacts; adjust it explicitly only when tiny standalone assets are intended.

## Package Layout

```text
joy-media-assets/
  assets/<category>/*.png + *.json
  contact-sheets/
  manifests/manifest.json
  manifests/manifest.csv
  reports/
  checkpoints/checkpoint.sqlite3
  debug/
  review-needed.csv
```

Use typescript/joy-media-asset-adapter.ts as the importer-neutral JOY Media adapter. Read [README.md](README.md) for installation, configuration, and the complete CLI reference.
