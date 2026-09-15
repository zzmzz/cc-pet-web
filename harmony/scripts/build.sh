#!/usr/bin/env bash
# Builds the signed HAP via the same hvigor invocation documented in
# harmony/README.md (originally recorded during Task 1). Requires a real
# build-profile.json5 with a working signingConfigs entry -- see the
# "Signing" section of the README; the empty-signingConfigs profile used for
# unit tests is not enough for assembleHap.
set -euo pipefail

HARMONY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${DEVECO_SDK_HOME:=/Applications/DevEco-Studio.app/Contents/sdk}"
DEVECO_TOOLS="/Applications/DevEco-Studio.app/Contents/tools"
export DEVECO_SDK_HOME
export PATH="$DEVECO_TOOLS/node/bin:$DEVECO_TOOLS/ohpm/bin:$PATH"

HVIGORW_JS="$DEVECO_TOOLS/hvigor/bin/hvigorw.js"
if [[ ! -f "$HVIGORW_JS" ]]; then
  echo "FAIL: [build.sh] hvigorw.js not found at $HVIGORW_JS -- is DevEco Studio installed there?"
  exit 1
fi

if [[ ! -f "$HARMONY_DIR/build-profile.json5" ]]; then
  echo "FAIL: [build.sh] $HARMONY_DIR/build-profile.json5 is missing." \
       " See harmony/README.md's Signing section (build-profile.example.json5 is a template," \
       " not something to copy verbatim -- it has placeholder cert paths)."
  exit 1
fi

cd "$HARMONY_DIR"

# NEVER pass --no-daemon here: assembleHap needs the persistent hvigor daemon
# (see harmony/README.md / Task 1 report for why the unit-test command uses
# --no-daemon but this one must not).
node "$HVIGORW_JS" assembleHap -p module=entry@default -p product=default

HAP_PATH="$HARMONY_DIR/entry/build/default/outputs/default/entry-default-signed.hap"
if [[ ! -f "$HAP_PATH" ]]; then
  echo "FAIL: [build.sh] assembleHap reported success but the expected artifact is missing: $HAP_PATH"
  exit 1
fi

echo "PASS: [build.sh] built $HAP_PATH ($(du -h "$HAP_PATH" | cut -f1))"
