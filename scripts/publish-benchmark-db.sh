#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Publish a benchmark DB snapshot to a GitHub Release.

Usage:
  scripts/publish-benchmark-db.sh [options]

Options:
  --db-path PATH         SQLite DB path (default: parallel_eval/wikihop.db)
  --wiki NAME            Wiki label for naming (default: simplewiki)
  --dump-date YYYYMMDD   Dump date label for naming (default: mtime date of --db-path)
  --asset-base NAME      Asset basename (default: wikihop-benchmark-<wiki>-<dump-date>)
  --tag TAG              Release tag (default: benchmark-db-<wiki>-<dump-date>)
  --repo OWNER/REPO      GitHub repo (default: current gh repo)
  --title TITLE          Release title (default: Benchmark DB: <wiki> <dump-date>)
  --notes TEXT           Release notes (default: auto-generated)
  --compression-level N  zstd level (default: 15)
  --help                 Show this help
EOF
}

file_size_bytes() {
  case "$(uname -s)" in
    Darwin|FreeBSD)
      stat -f%z "$1"
      ;;
    *)
      stat -c%s "$1"
      ;;
  esac
}

DB_PATH="parallel_eval/wikihop.db"
WIKI="simplewiki"
DUMP_DATE=""
ASSET_BASE=""
TAG=""
REPO=""
TITLE=""
NOTES=""
COMPRESSION_LEVEL="15"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-path)
      DB_PATH="$2"
      shift 2
      ;;
    --wiki)
      WIKI="$2"
      shift 2
      ;;
    --dump-date)
      DUMP_DATE="$2"
      shift 2
      ;;
    --asset-base)
      ASSET_BASE="$2"
      shift 2
      ;;
    --tag)
      TAG="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --title)
      TITLE="$2"
      shift 2
      ;;
    --notes)
      NOTES="$2"
      shift 2
      ;;
    --compression-level)
      COMPRESSION_LEVEL="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ ! -f "$DB_PATH" ]]; then
  echo "DB not found: $DB_PATH" >&2
  exit 1
fi

if [[ -z "$DUMP_DATE" ]]; then
  DUMP_DATE="$(date -u -r "$DB_PATH" +%Y%m%d)"
fi

if [[ -z "$ASSET_BASE" ]]; then
  ASSET_BASE="wikihop-benchmark-${WIKI}-${DUMP_DATE}"
fi

if [[ -z "$TAG" ]]; then
  TAG="benchmark-db-${WIKI}-${DUMP_DATE}"
fi

if [[ -z "$TITLE" ]]; then
  TITLE="Benchmark DB: ${WIKI} ${DUMP_DATE}"
fi

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi

if [[ -z "$NOTES" ]]; then
  NOTES=$(cat <<EOF
Benchmark reproducibility artifact for WikiRace benchmarking.

Asset base name: ${ASSET_BASE}
Contains:
- ${ASSET_BASE}.db.zst
- ${ASSET_BASE}.db.zst.sha256
- ${ASSET_BASE}.manifest.json
EOF
)
fi

if ! command -v zstd >/dev/null 2>&1; then
  echo "zstd is required but not found." >&2
  exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required but not found." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required but not found." >&2
  exit 1
fi

WORKDIR="$(mktemp -d /tmp/wikihop-benchmark-release.XXXXXX)"
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

OUT_ZST="$WORKDIR/${ASSET_BASE}.db.zst"
OUT_SHA="$WORKDIR/${ASSET_BASE}.db.zst.sha256"
OUT_MANIFEST="$WORKDIR/${ASSET_BASE}.manifest.json"

echo "Compressing $DB_PATH -> $OUT_ZST"
zstd -T0 "-${COMPRESSION_LEVEL}" -f "$DB_PATH" -o "$OUT_ZST"

DB_SHA="$(sha256sum "$DB_PATH" | awk '{print $1}')"
ZST_SHA="$(sha256sum "$OUT_ZST" | awk '{print $1}')"
DB_SIZE="$(file_size_bytes "$DB_PATH")"
ZST_SIZE="$(file_size_bytes "$OUT_ZST")"
GIT_SHA="$(git rev-parse HEAD)"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf "%s  %s\n" "$ZST_SHA" "${ASSET_BASE}.db.zst" > "$OUT_SHA"

cat > "$OUT_MANIFEST" <<EOF
{
  "name": "${ASSET_BASE}",
  "usage": "benchmarking",
  "wiki": "${WIKI}",
  "dump_date": "${DUMP_DATE}",
  "created_at": "${CREATED_AT}",
  "git_sha": "${GIT_SHA}",
  "db_sha256": "${DB_SHA}",
  "db_size_bytes": ${DB_SIZE},
  "compressed": {
    "filename": "${ASSET_BASE}.db.zst",
    "sha256": "${ZST_SHA}",
    "size_bytes": ${ZST_SIZE},
    "codec": "zstd"
  },
  "notes": "Built from Wikimedia SQL dumps via get_wikihop.py. Intended for benchmarking reproducibility."
}
EOF

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release exists; uploading assets with --clobber: $REPO@$TAG"
  gh release upload "$TAG" \
    "$OUT_ZST" \
    "$OUT_SHA" \
    "$OUT_MANIFEST" \
    --repo "$REPO" \
    --clobber
else
  echo "Creating release: $REPO@$TAG"
  gh release create "$TAG" \
    "$OUT_ZST" \
    "$OUT_SHA" \
    "$OUT_MANIFEST" \
    --repo "$REPO" \
    --title "$TITLE" \
    --notes "$NOTES"
fi

echo
echo "Published release:"
gh release view "$TAG" --repo "$REPO" --json url --jq .url
