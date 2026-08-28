#!/usr/bin/env bash
set -euo pipefail

readonly JOY_MEDIA_RELEASE_IDENTITY_KEYS=(
  JOY_MEDIA_RELEASE_COMMIT_SHA
  JOY_MEDIA_RELEASE_TREE_HASH
  JOY_MEDIA_RELEASE_LOCKFILE_SHA256
  JOY_MEDIA_RELEASE_SCHEMA_VERSION
)

is_release_identity_key() {
  local candidate="${1:-}"
  local key
  for key in "${JOY_MEDIA_RELEASE_IDENTITY_KEYS[@]}"; do
    if [[ "$candidate" == "$key" ]]; then
      return 0
    fi
  done
  return 1
}

normalize_release_identity_key() {
  local line="$1"
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  printf '%s\n' "$line"
}

validate_release_identity_value() {
  local key="$1"
  local value="$2"
  case "$key" in
    JOY_MEDIA_RELEASE_COMMIT_SHA | JOY_MEDIA_RELEASE_TREE_HASH)
      [[ "$value" =~ ^[0-9a-f]{40,64}$ ]] || {
        echo "invalid $key value: $value" >&2
        return 1
      }
      ;;
    JOY_MEDIA_RELEASE_LOCKFILE_SHA256)
      [[ "$value" =~ ^[0-9a-f]{64}$ ]] || {
        echo "invalid $key value: $value" >&2
        return 1
      }
      ;;
    JOY_MEDIA_RELEASE_SCHEMA_VERSION)
      [[ "$value" =~ ^[0-9]+$ ]] || {
        echo "invalid $key value: $value" >&2
        return 1
      }
      ;;
    *)
      echo "unexpected release identity key: $key" >&2
      return 1
      ;;
  esac
}

load_release_identity_file() {
  local identity_file="$1"
  [[ -f "$identity_file" ]] || {
    echo "release identity file missing: $identity_file" >&2
    return 1
  }

  declare -gA JOY_MEDIA_RELEASE_IDENTITY=()
  local line trimmed key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(normalize_release_identity_key "$line")"
    [[ -z "$trimmed" ]] && continue
    [[ "$trimmed" == \#* ]] && continue
    [[ "$trimmed" == *=* ]] || {
      echo "invalid release identity line: $line" >&2
      return 1
    }
    key="${trimmed%%=*}"
    value="${trimmed#*=}"
    is_release_identity_key "$key" || {
      echo "unexpected release identity key in $identity_file: $key" >&2
      return 1
    }
    [[ -z "${JOY_MEDIA_RELEASE_IDENTITY[$key]+x}" ]] || {
      echo "duplicate release identity key in $identity_file: $key" >&2
      return 1
    }
    validate_release_identity_value "$key" "$value"
    JOY_MEDIA_RELEASE_IDENTITY["$key"]="$value"
  done <"$identity_file"

  local required_key
  for required_key in "${JOY_MEDIA_RELEASE_IDENTITY_KEYS[@]}"; do
    [[ -n "${JOY_MEDIA_RELEASE_IDENTITY[$required_key]+x}" ]] || {
      echo "missing release identity key in $identity_file: $required_key" >&2
      return 1
    }
  done
}

write_release_identity_file() {
  local destination="$1"
  local commit_sha="$2"
  local tree_hash="$3"
  local lockfile_sha256="$4"
  local schema_version="$5"
  validate_release_identity_value JOY_MEDIA_RELEASE_COMMIT_SHA "$commit_sha"
  validate_release_identity_value JOY_MEDIA_RELEASE_TREE_HASH "$tree_hash"
  validate_release_identity_value JOY_MEDIA_RELEASE_LOCKFILE_SHA256 "$lockfile_sha256"
  validate_release_identity_value JOY_MEDIA_RELEASE_SCHEMA_VERSION "$schema_version"

  local destination_dir
  destination_dir="$(dirname -- "$destination")"
  mkdir -p -- "$destination_dir"

  cat >"$destination" <<EOF
JOY_MEDIA_RELEASE_COMMIT_SHA=$commit_sha
JOY_MEDIA_RELEASE_TREE_HASH=$tree_hash
JOY_MEDIA_RELEASE_LOCKFILE_SHA256=$lockfile_sha256
JOY_MEDIA_RELEASE_SCHEMA_VERSION=$schema_version
EOF
}

merge_release_identity_into_env() {
  local base_env_file="$1"
  local identity_file="$2"
  local destination_file="$3"
  [[ -f "$base_env_file" ]] || {
    echo "base environment file missing: $base_env_file" >&2
    return 1
  }
  load_release_identity_file "$identity_file"

  local destination_dir temp_file
  destination_dir="$(dirname -- "$destination_file")"
  mkdir -p -- "$destination_dir"
  temp_file="$(mktemp "$destination_dir/.joy-media-api-env.XXXXXX")"

  local line trimmed key
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(normalize_release_identity_key "$line")"
    if [[ "$trimmed" == *=* ]]; then
      key="${trimmed%%=*}"
      if is_release_identity_key "$key"; then
        continue
      fi
    fi
    printf '%s\n' "$line" >>"$temp_file"
  done <"$base_env_file"

  local release_key
  for release_key in "${JOY_MEDIA_RELEASE_IDENTITY_KEYS[@]}"; do
    printf '%s=%s\n' "$release_key" "${JOY_MEDIA_RELEASE_IDENTITY[$release_key]}" >>"$temp_file"
  done

  chmod --reference="$base_env_file" "$temp_file"
  chown --reference="$base_env_file" "$temp_file"
  mv -Tf -- "$temp_file" "$destination_file"
}

main() {
  local command="${1:-}"
  case "$command" in
    emit)
      [[ "$#" -eq 5 ]] || {
        echo "usage: $0 emit <commit-sha> <tree-hash> <lockfile-sha256> <schema-version>" >&2
        exit 2
      }
      local commit_sha="$2"
      local tree_hash="$3"
      local lockfile_sha256="$4"
      local schema_version="$5"
      validate_release_identity_value JOY_MEDIA_RELEASE_COMMIT_SHA "$commit_sha"
      validate_release_identity_value JOY_MEDIA_RELEASE_TREE_HASH "$tree_hash"
      validate_release_identity_value JOY_MEDIA_RELEASE_LOCKFILE_SHA256 "$lockfile_sha256"
      validate_release_identity_value JOY_MEDIA_RELEASE_SCHEMA_VERSION "$schema_version"
      printf 'JOY_MEDIA_RELEASE_COMMIT_SHA=%s\n' "$commit_sha"
      printf 'JOY_MEDIA_RELEASE_TREE_HASH=%s\n' "$tree_hash"
      printf 'JOY_MEDIA_RELEASE_LOCKFILE_SHA256=%s\n' "$lockfile_sha256"
      printf 'JOY_MEDIA_RELEASE_SCHEMA_VERSION=%s\n' "$schema_version"
      ;;
    write)
      [[ "$#" -eq 6 ]] || {
        echo "usage: $0 write <destination> <commit-sha> <tree-hash> <lockfile-sha256> <schema-version>" >&2
        exit 2
      }
      write_release_identity_file "$2" "$3" "$4" "$5" "$6"
      ;;
    merge)
      [[ "$#" -eq 4 ]] || {
        echo "usage: $0 merge <base-env-file> <identity-file> <destination-file>" >&2
        exit 2
      }
      merge_release_identity_into_env "$2" "$3" "$4"
      ;;
    "" )
      echo "usage: $0 <emit|write|merge> ..." >&2
      exit 2
      ;;
    *)
      echo "unknown command: $command" >&2
      exit 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
