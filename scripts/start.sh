#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
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

PORT=5001
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-$PORT}"


start_service() {
    cd "${COZE_WORKSPACE_PATH}"
    echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for deploy..."
    PORT=${DEPLOY_RUN_PORT} node dist/server.js
}

echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for deploy..."
start_service
