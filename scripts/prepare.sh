#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

cd "${COZE_WORKSPACE_PATH}"

# --- Node.js deps (fast, blocking) ---
echo "Installing Node.js dependencies..."
pnpm install --prefer-frozen-lockfile --prefer-offline --loglevel debug --reporter=append-only

# Note: System deps (ffmpeg, colmap) and Python deps (open3d) are installed
# asynchronously by install-deps-async.sh during dev startup,
# so they don't block the preview from loading.
