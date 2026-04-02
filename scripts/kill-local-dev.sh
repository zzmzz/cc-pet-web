#!/usr/bin/env bash
# 释放本地调试占用的端口（与 packages/server、packages/web 默认配置一致）
set -euo pipefail

SERVER_PORT="${CC_PET_PORT:-3000}"
WEB_PORT=1420

kill_port() {
  local port=$1
  if lsof -ti ":${port}" >/dev/null 2>&1; then
    echo "[cc-pet] freeing port ${port}"
    lsof -ti ":${port}" | xargs kill -9 2>/dev/null || true
  fi
}

case "${1:-}" in
  --server-only) kill_port "${SERVER_PORT}" ;;
  --web-only) kill_port "${WEB_PORT}" ;;
  *)
    kill_port "${SERVER_PORT}"
    kill_port "${WEB_PORT}"
    ;;
esac
