#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
PYTHON_ENV_NAME="${PYTHON_ENV_NAME:-studio3dgs}"
PYTHON_BIN="${PYTHON_BIN:-/Users/yuyi/miniconda3/envs/studio3dgs/bin/python3}"
NS_TRAIN_BIN="${NS_TRAIN_BIN:-/Users/yuyi/miniconda3/envs/studio3dgs/bin/ns-train}"
NS_EXPORT_BIN="${NS_EXPORT_BIN:-/Users/yuyi/miniconda3/envs/studio3dgs/bin/ns-export}"
MPLCONFIGDIR="${MPLCONFIGDIR:-/private/tmp/studio3dgs-matplotlib}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-/private/tmp/studio3dgs-cache}"

export PYTHON_BIN
export NS_TRAIN_BIN
export NS_EXPORT_BIN
export MPLCONFIGDIR
export XDG_CACHE_HOME

PORT=5001
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-$PORT}"


start_service() {
    cd "${COZE_WORKSPACE_PATH}"
    if command -v conda >/dev/null 2>&1; then
        CONDA_BASE="$(conda info --base 2>/dev/null || true)"
        if [ -n "${CONDA_BASE}" ] && [ -d "${CONDA_BASE}/envs/${PYTHON_ENV_NAME}/bin" ]; then
            export PATH="${CONDA_BASE}/envs/${PYTHON_ENV_NAME}/bin:${PATH}"
            echo "Using Python environment: ${PYTHON_ENV_NAME}"
        fi
    fi
    echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for deploy..."
    PORT=${DEPLOY_RUN_PORT} node dist/server.js
}

echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for deploy..."
start_service
