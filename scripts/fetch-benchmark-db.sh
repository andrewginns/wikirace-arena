#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Fetch and verify a benchmark DB snapshot from a GitHub Release.

Usage:
  scripts/fetch-benchmark-db.sh [options]

Options:
  --tag TAG              Release tag (required)
  --asset-base NAME      Asset basename (required, e.g. wikihop-benchmark-simplewiki-20260123)
  --repo OWNER/REPO      GitHub repo (default: current gh repo)
  --out PATH             Output SQLite DB path (default: parallel_eval/wikihop.db)
  --help                 Show this help
EOF
}

TAG=""
ASSET_BASE=""
REPO=""
OUT_PATH="parallel_eval/wikihop.db"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="$2"
      shift 2
      ;;
    --asset-base)
      ASSET_BASE="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --out)
      OUT_PATH="$2"
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

if [[ -z "$TAG" || -z "$ASSET_BASE" ]]; then
  echo "--tag and --asset-base are required." >&2
  usage
  exit 2
fi

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required but not found." >&2
  exit 1
fi

if ! command -v zstd >/dev/null 2>&1; then
  echo "zstd is required but not found." >&2
  exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required but not found." >&2
  exit 1
fi

WORKDIR="$(mktemp -d /tmp/wikihop-benchmark-fetch.XXXXXX)"
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

ZST_NAME="${ASSET_BASE}.db.zst"
SHA_NAME="${ASSET_BASE}.db.zst.sha256"
MANIFEST_NAME="${ASSET_BASE}.manifest.json"
ZST_PATH="$WORKDIR/$ZST_NAME"
SHA_PATH="$WORKDIR/$SHA_NAME"
MANIFEST_PATH="$WORKDIR/$MANIFEST_NAME"

echo "Downloading release assets from $REPO@$TAG"
gh release download "$TAG" --repo "$REPO" --pattern "$ZST_NAME" --dir "$WORKDIR" --clobber
gh release download "$TAG" --repo "$REPO" --pattern "$SHA_NAME" --dir "$WORKDIR" --clobber
gh release download "$TAG" --repo "$REPO" --pattern "$MANIFEST_NAME" --dir "$WORKDIR" --clobber

echo "Verifying compressed checksum"
(
  cd "$WORKDIR"
  sha256sum -c "$SHA_NAME"
)

mkdir -p "$(dirname "$OUT_PATH")"
echo "Decompressing to $OUT_PATH"
zstd -d -f "$ZST_PATH" -o "$OUT_PATH"

EXPECTED_DB_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["db_sha256"])' "$MANIFEST_PATH")"
ACTUAL_DB_SHA="$(sha256sum "$OUT_PATH" | awk '{print $1}')"

if [[ "$EXPECTED_DB_SHA" != "$ACTUAL_DB_SHA" ]]; then
  echo "DB checksum mismatch." >&2
  echo "Expected: $EXPECTED_DB_SHA" >&2
  echo "Actual:   $ACTUAL_DB_SHA" >&2
  exit 1
fi

echo "DB checksum verified: $ACTUAL_DB_SHA"
echo "Done: $OUT_PATH"
