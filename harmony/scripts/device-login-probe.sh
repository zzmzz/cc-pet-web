#!/usr/bin/env bash
# device-login-probe.sh — launch cc-pet and assert it reaches either the
# login gate or a logged-in (chat) state.
#
# Targets the emulator (127.0.0.1:5555) by default; override with
# CCPET_DEVICE_TARGET for a real device. Never assumes a phone is attached,
# and never wipes app data on its own -- if the target is already logged in
# (its own AuthStore, its own server), this probe only *observes* that and
# passes; it does not force a login gate to appear. It only drives a real
# login (against a throwaway local fixture, never the operator's real server)
# when it finds the app is *already* sitting at LoginGate.
#
# What this actually asserts, and why: the brief's original wording asked for
# a hilog line reading "auth verified". That string is never logged anywhere
# in this codebase (grep entry/src/main/ets for it -- nothing). Rather than
# print PASS because a made-up grep silently found nothing to contradict,
# this probe reads the real on-device UI tree via `uitest dumpLayout`:
#   - Logged-in state: the chat screen's 发送 (send) button is present.
#   - Login gate: the 'cc-pet' title + 登录 button are present -- and if so,
#     this probe drives a real login through it, so "auth verified" is
#     checked by proving RestClient.postJson(/api/auth/verify) actually
#     succeeded (the chat screen only renders after AuthStore.save() runs;
#     see entry/src/main/ets/components/LoginGate.ets).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-login-probe"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-login-probe.XXXXXX")"
LAYOUT="$WORKDIR/layout.json"

cleanup() {
  local ec=$?
  stop_fixture_stack
  rm -rf "$WORKDIR"
  exit "$ec"
}
trap cleanup EXIT

require_hdc_and_target
ensure_screen_awake_and_unlocked "$LAYOUT"

launch_app
dump_layout "$LAYOUT"

if ui_contains "$LAYOUT" '发送'; then
  pass "app is already in a logged-in chat screen (发送 button present) -- no login gate to drive"
fi

if ! ui_contains "$LAYOUT" 'cc-pet'; then
  fail "app reached neither the login gate ('cc-pet' title) nor a logged-in chat screen" \
       " (发送 button) after launch -- dumped layout at $LAYOUT"
fi

echo "[$PROBE_NAME] login gate reached; driving a real login against a throwaway local fixture" \
     " (never the operator's real server) to verify auth actually succeeds..."

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19301}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19302}"
start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT"
ensure_rport "$SERVER_PORT"

perform_login "http://127.0.0.1:$SERVER_PORT" "$FIXTURE_TOKEN" "$LAYOUT"

pass "reached login gate, then auth verified against a real (throwaway) server -- chat screen confirmed"
