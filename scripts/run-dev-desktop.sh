#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
bash scripts/kill-local-dev.sh
DATA_DIR="${CC_PET_DATA_DIR:-$ROOT/.data}"
CC_PET_DATA_DIR="$DATA_DIR" pnpm --filter @cc-pet/server dev &
pnpm --filter @cc-pet/web dev &
pnpm --filter @cc-pet/desktop dev
