#!/usr/bin/env bash
# 一键启动：本地 server + web + Tauri desktop（开发模式）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
exec pnpm dev:desktop
