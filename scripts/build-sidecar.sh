#!/usr/bin/env bash
# Compile the TypeScript router into a single native binary for Tauri's sidecar slot.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v bun >/dev/null || { echo "bun is required: curl -fsSL https://bun.sh/install | bash"; exit 1; }
TRIPLE="${TAURI_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
case "$TRIPLE" in
  aarch64-apple-darwin) BUN_TARGET=bun-darwin-arm64 ;;
  x86_64-apple-darwin)  BUN_TARGET=bun-darwin-x64 ;;
  x86_64-unknown-linux-gnu) BUN_TARGET=bun-linux-x64 ;;
  aarch64-unknown-linux-gnu) BUN_TARGET=bun-linux-arm64 ;;
  *) echo "Unsupported target $TRIPLE"; exit 1 ;;
esac
mkdir -p src-tauri/binaries
bun build router/src/index.ts --compile --minify --target="$BUN_TARGET" --outfile "src-tauri/binaries/ofr-router-$TRIPLE"
echo "sidecar → src-tauri/binaries/ofr-router-$TRIPLE"
