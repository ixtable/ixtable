#!/usr/bin/env bash
set -euo pipefail

# duckdb-rs 1.10505.0 embeds DuckDB 1.5.5. Extensions are ABI-specific, so
# these versions must move together. Runtime installation/autoload is disabled.
VERSION=1.5.5
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/resources/duckdb"

fetch() {
  platform="$1"; target="$2"; expected="$3"
  url="https://extensions.duckdb.org/v${VERSION}/${platform}/sqlite_scanner.duckdb_extension.gz"
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  curl --fail --location --proto '=https' --tlsv1.2 "$url" -o "$tmp"
  printf '%s  %s\n' "$expected" "$tmp" | shasum -a 256 -c -
  mkdir -p "$DEST/$target"
  gzip -dc "$tmp" > "$DEST/$target/sqlite_scanner.duckdb_extension"
  printf '%s\n' "$VERSION" > "$DEST/$target/VERSION"
}

case "${1:-}" in
  macos-universal)
    fetch osx_arm64 macos-arm64 d7514249b0cce24bb63856b4c752a889ef2f739c6fd821109988e4e13afd7058
    fetch osx_amd64 macos-x64 1b96e4ac03a4394708166f75236614a80fd1f9ab810fb3f35ea7aa5a9a833501
    ;;
  windows-x64) fetch windows_amd64 windows-x64 b6139c7f3b40a1b3ba5ef605e4590eda4a55e4e8deefc8182a2644e4a5797f69 ;;
  linux-x64) fetch linux_amd64 linux-x64 01292812092200c2d0b76324df9568d336ddaa5a198e7cc8fed124e84088e14e ;;
  *) echo "usage: $0 {macos-universal|windows-x64|linux-x64}" >&2; exit 2 ;;
esac
