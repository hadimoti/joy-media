#!/usr/bin/env bash
# Retains the Windows release artifacts of one candidate in the durable evidence store.
#
#   retain-release-artifacts.sh <staged-dir> <candidate-sha> <run-id> <attempt> <evidence-root>
#
# <staged-dir> is the artifact the Windows lane uploaded. It holds artifact-manifest.json and exactly
# the files that manifest lists. Every file is hashed here, not by the lane that wrote the manifest,
# and compared with the manifest. Where SHA256SUMS.txt names a file, its digest must agree too. A
# mismatch, a missing or extra file, a symlink, or an identity that does not match this run fails the
# step, and nothing is written to the evidence store.
#
# Files are copied byte for byte. Release binaries never pass through the redaction that the JSON and
# text evidence uses, because redaction rewrites bytes. The copy is written once, under the candidate
# and run, and the copy is verified against the same manifest before the step passes.
set -euo pipefail

staged="${1:?staged artifact directory}"
candidate="${2:?candidate sha}"
run_id="${3:?workflow run id}"
attempt="${4:?workflow run attempt}"
root="${5:?durable evidence root}"

[[ "$candidate" =~ ^[0-9a-f]{40}$ ]] || { echo 'retain-release-artifacts: candidate sha must be 40 lowercase hex characters' >&2; exit 1; }
[[ "$run_id" =~ ^[0-9]+$ && "$attempt" =~ ^[0-9]+$ ]] || { echo 'retain-release-artifacts: run id and attempt must be numbers' >&2; exit 1; }
[[ -d "$staged" ]] || { echo "retain-release-artifacts: staged directory is missing: $staged" >&2; exit 1; }
[[ -f "$staged/artifact-manifest.json" ]] || { echo 'retain-release-artifacts: artifact-manifest.json is missing' >&2; exit 1; }

mkdir -p "$root"
[[ -d "$root" && -w "$root" ]] || { echo "retain-release-artifacts: durable evidence root is not writable: $root" >&2; exit 1; }
case "$root" in
  *"${RUNNER_WORKSPACE:-__no_workspace__}"* | *"/_work/"* | *"/_temp/"*)
    echo 'retain-release-artifacts: the evidence root must be outside the checkout, _work and _temp' >&2
    exit 1
    ;;
esac

expected="$(mktemp)"
listed="$(mktemp)"
trap 'rm -f "$expected" "$listed"' EXIT

# The manifest's identity and its file list. Paths must stay inside the staged directory.
node -e '
  const fs = require("node:fs");
  const [manifestPath, candidate, runId, attempt] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== "joy-media-release-artifacts") throw new Error("unexpected manifest format");
  if (manifest.candidateSha !== candidate) throw new Error("manifest candidateSha does not match the candidate");
  if (String(manifest.runId) !== runId || String(manifest.attempt) !== attempt) {
    throw new Error("manifest run identity does not match this run");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("manifest lists no files");
  for (const entry of manifest.files) {
    const parts = String(entry.path).split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("manifest path is not a plain relative path: " + entry.path);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error("manifest entry is malformed: " + entry.path);
    }
    process.stdout.write(entry.path + "\t" + entry.sha256 + "\t" + entry.bytes + "\n");
  }
' "$staged/artifact-manifest.json" "$candidate" "$run_id" "$attempt" > "$expected"

# verify_tree <dir>: the directory holds exactly the manifest's files, each with the manifest's digest
# and size, and SHA256SUMS.txt agrees with every file it names. Digests are computed here.
verify_tree() {
  local dir="$1"
  if [[ -n "$(find "$dir" -type l -print -quit)" ]]; then
    echo "retain-release-artifacts: symlinks are not allowed in $dir" >&2
    return 1
  fi
  ( cd "$dir" && find . -type f ! -name artifact-manifest.json | sed 's#^\./##' | sort ) > "$listed"
  if ! diff <(cut -f1 "$expected" | sort) "$listed" > /dev/null; then
    echo "retain-release-artifacts: $dir does not hold exactly the manifest's files" >&2
    return 1
  fi
  local path sha bytes actual_sha actual_bytes
  while IFS=$'\t' read -r path sha bytes; do
    actual_sha="$(sha256sum "$dir/$path" | cut -d' ' -f1)"
    actual_bytes="$(wc -c < "$dir/$path" | tr -d ' ')"
    if [[ "$actual_sha" != "$sha" ]]; then
      echo "retain-release-artifacts: sha256 mismatch for $path in $dir" >&2
      return 1
    fi
    if [[ "$actual_bytes" != "$bytes" ]]; then
      echo "retain-release-artifacts: byte count mismatch for $path in $dir" >&2
      return 1
    fi
  done < "$expected"
  if [[ -f "$dir/SHA256SUMS.txt" ]]; then
    local sum name
    while read -r sum name; do
      name="${name%$'\r'}"
      [[ -n "${name:-}" ]] || continue
      name="${name#\*}"
      if [[ ! -f "$dir/$name" ]]; then
        echo "retain-release-artifacts: SHA256SUMS.txt names $name, which is not in $dir" >&2
        return 1
      fi
      actual_sha="$(sha256sum "$dir/$name" | cut -d' ' -f1)"
      if [[ "$actual_sha" != "$sum" ]]; then
        echo "retain-release-artifacts: SHA256SUMS.txt disagrees with $name" >&2
        return 1
      fi
    done < "$dir/SHA256SUMS.txt"
  fi
}

verify_tree "$staged"

dest="$root/$candidate/${run_id}-${attempt}-release-artifacts"
if [[ -e "$dest" ]]; then
  echo "retain-release-artifacts: retention is write-once, and $dest already exists" >&2
  exit 1
fi
mkdir -p "$dest"
cp -a "$staged/." "$dest/"

verify_tree "$dest"

count="$(cut -f1 "$expected" | wc -l | tr -d ' ')"
echo "retain-release-artifacts: retained and re-verified $count file(s) at $dest"
