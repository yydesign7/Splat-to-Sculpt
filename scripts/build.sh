#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "${COZE_WORKSPACE_PATH}"

# --- Optimize apt source for CN network (aliyun mirror) ---
if grep -q "archive.ubuntu.com" /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; then
  echo "Switching apt source to aliyun mirror..."
  sed -i 's|http://archive.ubuntu.com/ubuntu/|http://mirrors.aliyun.com/ubuntu/|g' /etc/apt/sources.list.d/ubuntu.sources
  sed -i 's|http://security.ubuntu.com/ubuntu/|http://mirrors.aliyun.com/ubuntu/|g' /etc/apt/sources.list.d/ubuntu.sources
fi

# --- System deps: ffmpeg, colmap ---
echo "Checking system dependencies..."
if ! command -v ffmpeg &>/dev/null; then
  echo "Installing ffmpeg..."
  apt-get update -qq && apt-get install -y -qq ffmpeg
else
  echo "ffmpeg: OK"
fi

if ! command -v colmap &>/dev/null; then
  echo "Installing colmap..."
  apt-get update -qq && apt-get install -y -qq colmap
else
  echo "colmap: OK"
fi

# --- Python deps: open3d (prefer local wheel cache) ---
echo "Checking Python dependencies..."
if ! python3 -c "import open3d" &>/dev/null; then
  PYPI_CACHE="${SCRIPT_DIR}/pypi-cache"
  if [ -d "$PYPI_CACHE" ] && ls "$PYPI_CACHE"/open3d-*.whl 1>/dev/null 2>&1; then
    echo "Installing open3d from local wheel cache (deps from PyPI if needed)..."
    pip3 install --find-links="$PYPI_CACHE" open3d
  else
    echo "Installing open3d from PyPI (no local cache)..."
    pip3 install --timeout 600 open3d
  fi
else
  echo "open3d: OK"
fi

# --- Node.js deps ---
echo "Installing dependencies..."
pnpm install --prefer-frozen-lockfile --prefer-offline --loglevel debug --reporter=append-only

echo "Building the Next.js project..."
pnpm next build

echo "Bundling server with tsup..."
pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify

echo "Build completed successfully!"
