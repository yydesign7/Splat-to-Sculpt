#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHECK_ONLY=0
INSTALL_PYTHON=0
BASE_ERRORS=0
OPTIONAL_WARNINGS=0

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-macos.sh [options]

Options:
  --check-only       Check the environment without installing pnpm packages.
  --install-python   Install/update packages from scripts/requirements-python.txt.
  -h, --help         Show this help message.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --install-python) INSTALL_PYTHON=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

ok() { printf '[ OK ] %s\n' "$1"; }
warn() { printf '[WARN] %s\n' "$1"; OPTIONAL_WARNINGS=$((OPTIONAL_WARNINGS + 1)); }
fail() { printf '[FAIL] %s\n' "$1"; BASE_ERRORS=$((BASE_ERRORS + 1)); }

resolve_python() {
  if [ -n "${PYTHON_BIN:-}" ] && command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
    command -v "${PYTHON_BIN}"
    return
  fi

  if command -v conda >/dev/null 2>&1; then
    local conda_base
    conda_base="$(conda info --base 2>/dev/null || true)"
    if [ -x "${conda_base}/envs/studio3dgs/bin/python3" ]; then
      printf '%s\n' "${conda_base}/envs/studio3dgs/bin/python3"
      return
    fi
  fi

  if [ -x "${HOME}/miniconda3/envs/studio3dgs/bin/python3" ]; then
    printf '%s\n' "${HOME}/miniconda3/envs/studio3dgs/bin/python3"
    return
  fi

  command -v python3 2>/dev/null || true
}

check_optional_command() {
  local command_name="$1"
  local purpose="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    ok "${purpose}: $(command -v "$command_name")"
  else
    warn "${purpose} not found (${command_name})."
  fi
}

check_nerfstudio_command() {
  local command_name="$1"
  local purpose="$2"
  local command_path=""
  command_path="$(command -v "$command_name" 2>/dev/null || true)"
  if [ -z "$command_path" ] && [ -n "${PYTHON_COMMAND:-}" ]; then
    local env_candidate
    env_candidate="$(dirname "$PYTHON_COMMAND")/${command_name}"
    if [ -x "$env_candidate" ]; then
      command_path="$env_candidate"
    fi
  fi
  if [ -n "$command_path" ]; then
    ok "${purpose}: ${command_path}"
  else
    warn "${purpose} not found (${command_name})."
  fi
}

printf '\nSplat to Sculpt macOS setup check\n'
printf 'Project: %s\n\n' "$PROJECT_ROOT"

if [ "$(uname -s)" != "Darwin" ]; then
  fail "This script is intended for macOS."
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0')"
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "Node.js $(node --version)"
  else
    fail "Node.js 20 or newer is required; found $(node --version 2>/dev/null || printf 'unknown')."
  fi
else
  fail "Node.js is not installed. Install Node.js 20 or newer."
fi

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm --version)"
else
  fail "pnpm is not installed. Install it with: corepack enable && corepack prepare pnpm@9 --activate"
fi

PYTHON_COMMAND="$(resolve_python)"
if [ -n "$PYTHON_COMMAND" ]; then
  PYTHON_VERSION="$("$PYTHON_COMMAND" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"
  ok "Python ${PYTHON_VERSION}: ${PYTHON_COMMAND}"
  if ! "$PYTHON_COMMAND" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 12) else 1)' >/dev/null 2>&1; then
    warn "Python 3.10-3.12 is recommended for Open3D and rembg compatibility."
  fi

  if [ "$INSTALL_PYTHON" -eq 1 ]; then
    printf '\nInstalling Python processing dependencies...\n'
    "$PYTHON_COMMAND" -m pip install -Ur "$PROJECT_ROOT/scripts/requirements-python.txt"
  fi

  PYTHON_MISSING="$("$PYTHON_COMMAND" - <<'PY'
modules = ["cv2", "numpy", "onnxruntime", "open3d", "pyrender", "rembg", "trimesh"]
missing = []
for module in modules:
    try:
        __import__(module)
    except Exception:
        missing.append(module)
print(", ".join(missing))
PY
)"
  if [ -z "$PYTHON_MISSING" ]; then
    ok "Core Python processing packages"
  else
    warn "Unavailable Python imports: ${PYTHON_MISSING}. Re-run with --install-python or repair that environment."
  fi
else
  warn "Python 3 was not found. The basic web UI can run, but reconstruction scripts cannot."
fi

check_optional_command ffmpeg "FFmpeg frame extraction"
check_optional_command colmap "COLMAP reconstruction"

if command -v blender >/dev/null 2>&1; then
  ok "Blender: $(command -v blender)"
elif [ -x "/Applications/Blender.app/Contents/MacOS/Blender" ]; then
  ok "Blender: /Applications/Blender.app/Contents/MacOS/Blender"
else
  warn "Blender was not found. Model Cleanup and Surface Processing will be unavailable."
fi

check_nerfstudio_command ns-train "Nerfstudio True training"
check_nerfstudio_command ns-export "Nerfstudio export"

COMFYUI_BASE_URL="${COMFYUI_BASE_URL:-http://127.0.0.1:8000}"
if command -v curl >/dev/null 2>&1 && curl --max-time 2 --silent --fail "${COMFYUI_BASE_URL}/system_stats" >/dev/null 2>&1; then
  ok "ComfyUI connected: ${COMFYUI_BASE_URL}"
else
  warn "ComfyUI is not reachable at ${COMFYUI_BASE_URL}; this is optional until video generation is used."
fi

if [ "$CHECK_ONLY" -eq 0 ]; then
  if command -v pnpm >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
    printf '\nInstalling locked pnpm dependencies...\n'
    (cd "$PROJECT_ROOT" && pnpm install --frozen-lockfile)
    ok "Project JavaScript dependencies"
  fi
elif [ -d "$PROJECT_ROOT/node_modules" ]; then
  ok "node_modules is present"
else
  warn "node_modules is missing. Run this script without --check-only to install it."
fi

printf '\nSetup summary\n'
if [ "$BASE_ERRORS" -eq 0 ]; then
  ok "Basic web prerequisites are ready. Run: pnpm dev"
else
  printf '[FAIL] %s required prerequisite(s) need attention.\n' "$BASE_ERRORS"
fi
printf '[INFO] %s optional full-workflow item(s) need attention.\n' "$OPTIONAL_WARNINGS"
printf '[INFO] Use PYTHON_BIN, NS_TRAIN_BIN, NS_EXPORT_BIN, and COMFYUI_BASE_URL to override detected tools.\n'

if [ "$BASE_ERRORS" -ne 0 ]; then
  exit 1
fi
