#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
PYTHON_ENV_NAME="${PYTHON_ENV_NAME:-studio3dgs}"

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
