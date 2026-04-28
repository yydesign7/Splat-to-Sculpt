#!/bin/bash
# Async dependency installer — runs in background so the dev server starts fast.
# Logs to /app/work/logs/bypass/deps-install.log

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
LOG="/app/work/logs/bypass/deps-install.log"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG" 2>/dev/null || echo "$1"; }

cd "${COZE_WORKSPACE_PATH}"

log "=== Background dependency installation started ==="

# --- Optimize apt source for CN network (aliyun mirror) ---
if grep -q "archive.ubuntu.com" /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null; then
  log "Switching apt source to aliyun mirror for faster downloads..."
  sed -i 's|http://archive.ubuntu.com/ubuntu/|http://mirrors.aliyun.com/ubuntu/|g' /etc/apt/sources.list.d/ubuntu.sources
  sed -i 's|http://security.ubuntu.com/ubuntu/|http://mirrors.aliyun.com/ubuntu/|g' /etc/apt/sources.list.d/ubuntu.sources
  log "Apt source switched to aliyun mirror"
fi

# --- System deps: ffmpeg, colmap, libosmesa6-dev (via apt, fast with aliyun mirror) ---
log "Checking system dependencies..."
if ! command -v ffmpeg &>/dev/null; then
  log "Installing ffmpeg..."
  apt-get update -qq && apt-get install -y -qq ffmpeg && log "ffmpeg: installed" || log "ffmpeg: FAILED"
else
  log "ffmpeg: OK"
fi

if ! command -v colmap &>/dev/null; then
  log "Installing colmap..."
  apt-get update -qq && apt-get install -y -qq colmap && log "colmap: installed" || log "colmap: FAILED"
else
  log "colmap: OK"
fi

if ! command -v apt-get &>/dev/null || ! command -v dpkg &>/dev/null; then
  log "libosmesa6-dev: skipped (apt/dpkg not available on this system)"
elif ! dpkg -s libosmesa6-dev &>/dev/null; then
  log "Installing libosmesa6-dev (for pyrender offscreen rendering)..."
  apt-get update -qq && apt-get install -y -qq libosmesa6-dev && log "libosmesa6-dev: installed" || log "libosmesa6-dev: FAILED"
else
  log "libosmesa6-dev: OK"
fi

if ! command -v blender &>/dev/null; then
  log "Installing blender..."
  apt-get update -qq && apt-get install -y -qq blender && log "blender: installed" || log "blender: FAILED"
else
  log "blender: OK"
fi

# --- Python deps: open3d, trimesh, pyrender, opencv (prefer local wheel cache) ---
log "Checking Python dependencies..."

# trimesh + numpy + rotation video deps — always upgrade so merge_glbs / GLB stays current
REQ_PY="${SCRIPT_DIR}/requirements-python.txt"
if [ -f "$REQ_PY" ]; then
  log "Installing/upgrading Python packages from requirements-python.txt..."
  pip3 install --upgrade --timeout 300 -r "$REQ_PY" && log "requirements-python.txt: OK" || log "requirements-python.txt: FAILED"
else
  log "requirements-python.txt missing; falling back to pip install trimesh numpy pyrender opencv-python-headless"
  pip3 install --upgrade --timeout 300 trimesh numpy pyrender opencv-python-headless && log "Python AV/merge deps: OK" || log "Python AV/merge deps: FAILED"
fi

# Ensure PyOpenGL >= 3.1.10 for OSMesa support
PYOPENGL_VER=$(python3 -c "import OpenGL; print(OpenGL.__version__)" 2>/dev/null || echo "0.0.0")
if [ "$(printf '%s\n' '3.1.10' "$PYOPENGL_VER" | sort -V | head -1)" != "3.1.10" ]; then
  log "Upgrading PyOpenGL (current: $PYOPENGL_VER, need >= 3.1.10 for OSMesa)..."
  pip3 install --timeout 300 'PyOpenGL>=3.1.10' 'PyOpenGL-accelerate>=3.1.10' && log "PyOpenGL: upgraded" || log "PyOpenGL upgrade: FAILED"
else
  log "PyOpenGL: OK ($PYOPENGL_VER)"
fi

# Open3D for mesh generation
if ! python3 -c "import open3d" &>/dev/null; then
  PYPI_CACHE="${SCRIPT_DIR}/pypi-cache"
  if [ -d "$PYPI_CACHE" ] && ls "$PYPI_CACHE"/open3d-*.whl 1>/dev/null 2>&1; then
    log "Installing open3d from local wheel cache (deps from PyPI if needed)..."
    pip3 install --find-links="$PYPI_CACHE" open3d && log "open3d: installed (from cache)" || log "open3d: FAILED"
  else
    log "Installing open3d from PyPI (no local cache)..."
    pip3 install --timeout 600 open3d && log "open3d: installed" || log "open3d: FAILED"
  fi
else
  log "open3d: OK"
fi

log "=== Background dependency installation completed ==="

# Write marker file so API routes know deps are ready
touch /tmp/deps-ready
log "Dependency marker file written to /tmp/deps-ready"
