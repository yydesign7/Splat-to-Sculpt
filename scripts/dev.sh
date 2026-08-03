#!/bin/bash
set -Eeuo pipefail


PORT=5001
COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
DEPLOY_RUN_PORT=5001
PYTHON_ENV_NAME="${PYTHON_ENV_NAME:-studio3dgs}"
PYTHON_ENV_BIN=""

if command -v conda >/dev/null 2>&1; then
  CONDA_BASE="$(conda info --base 2>/dev/null || true)"
  if [ -n "${CONDA_BASE}" ] && [ -d "${CONDA_BASE}/envs/${PYTHON_ENV_NAME}/bin" ]; then
    PYTHON_ENV_BIN="${CONDA_BASE}/envs/${PYTHON_ENV_NAME}/bin"
    export PATH="${PYTHON_ENV_BIN}:${PATH}"
    echo "Using Python environment: ${PYTHON_ENV_NAME}"
  fi
fi

if [ -z "${PYTHON_BIN:-}" ]; then
  if [ -n "${PYTHON_ENV_BIN}" ] && [ -x "${PYTHON_ENV_BIN}/python3" ]; then
    PYTHON_BIN="${PYTHON_ENV_BIN}/python3"
  else
    PYTHON_BIN="$(command -v python3 || printf 'python3')"
  fi
fi

PYTHON_BIN_DIR="$(dirname "${PYTHON_BIN}")"
NS_TRAIN_BIN="${NS_TRAIN_BIN:-$(command -v ns-train || printf '%s/ns-train' "${PYTHON_BIN_DIR}")}"
NS_EXPORT_BIN="${NS_EXPORT_BIN:-$(command -v ns-export || printf '%s/ns-export' "${PYTHON_BIN_DIR}")}"
MPLCONFIGDIR="${MPLCONFIGDIR:-${TMPDIR:-/tmp}/studio3dgs-matplotlib}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-${TMPDIR:-/tmp}/studio3dgs-cache}"

export PYTHON_BIN
export NS_TRAIN_BIN
export NS_EXPORT_BIN
export MPLCONFIGDIR
export XDG_CACHE_HOME

cd "${COZE_WORKSPACE_PATH}"

# --- Kick off background dependency installation (ffmpeg, colmap, open3d) ---
# This runs async so the dev server starts immediately.
# Logs: /app/work/logs/bypass/deps-install.log
if [ -f "./scripts/install-deps-async.sh" ]; then
  if [ "${FORCE_INSTALL_DEPS:-0}" = "1" ] || [ ! -f "/tmp/deps-ready" ]; then
    bash ./scripts/install-deps-async.sh &
    echo "Background dependency installer started (PID: $!)"
  else
    echo "Background dependency installer skipped (/tmp/deps-ready exists). Set FORCE_INSTALL_DEPS=1 to recheck."
  fi
fi

kill_port_if_listening() {
    local pids
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -z "${pids}" ]]; then
      echo "Port ${DEPLOY_RUN_PORT} is free."
      return
    fi
    echo "Port ${DEPLOY_RUN_PORT} in use by PIDs: ${pids} (SIGKILL)"
    echo "${pids}" | xargs -I {} kill -9 {}
    sleep 1
    pids=$(ss -H -lntp 2>/dev/null | awk -v port="${DEPLOY_RUN_PORT}" '$4 ~ ":"port"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | paste -sd' ' - || true)
    if [[ -n "${pids}" ]]; then
      echo "Warning: port ${DEPLOY_RUN_PORT} still busy after SIGKILL, PIDs: ${pids}"
    else
      echo "Port ${DEPLOY_RUN_PORT} cleared."
    fi
}

echo "Clearing port ${PORT} before start."
kill_port_if_listening
echo "Starting HTTP service on port ${PORT} for dev..."

PORT=$PORT ./node_modules/.bin/tsx watch src/server.ts
