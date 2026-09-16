#!/usr/bin/env bash
# device-download-probe.sh — drives the shell's WebDownloadDelegate end to end.
#
# This probe exists because the delegate shipped unexercised: nothing in the
# fixture stack ever produced a downloadable file, so `onBeforeDownload` had
# never run on a device and the only evidence it worked was that it compiled.
#
# The path it drives is the real one. The bridge fixture answers a message
# containing SENDFILE with a bridge `file` frame; `packages/server` persists it
# and hands back `/api/files/<id>`; `packages/web`'s FileAttachmentView fetches
# the bytes with the bearer token and renders
# `<a href="blob:..." download="..." target="_blank">`. That anchor — a blob
# URL, a download attribute and _blank together — is what the shell has to
# catch, and it is not obviously the easy case.
#
# The assertion is hilog, not a screenshot: the delegate writes into
# `context.filesDir/downloads`, which is owned by the app's uid and is NOT
# listable from `hdc shell` (it answers "Permission denied"). The shell's
# `download start` / `download finish` lines are the only way to see the result
# from outside the app.
#
# Targets the emulator (127.0.0.1:5555) by default; override with
# CCPET_DEVICE_TARGET. Never touches the operator's real server or token.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-download-probe"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-download-probe.XXXXXX")"
LAYOUT="$WORKDIR/layout.json"
SHOT="${CCPET_PROBE_SHOT:-$WORKDIR/download-toast.jpeg}"
FILE_NAME="probe-download.txt"

cleanup() {
  local ec=$?
  stop_fixture_stack
  rm -rf "$WORKDIR"
  exit "$ec"
}
trap cleanup EXIT

# See device-shell-probe.sh: ArkWeb attaches the IME to a focused DOM node
# asynchronously, so click-then-type drops the leading characters.
web_type_at() {
  local xy="$1" text="$2"
  hdc_ shell uitest uiInput click $xy >/dev/null
  sleep 1
  hdc_ shell uitest uiInput text "$text" >/dev/null
}

# The filename appears TWICE in the accessibility tree for one file message:
# once as the bubble's caption (packages/server sets the message content to the
# file name) and once as the download anchor itself. `ui_query` returns the
# first, which is the caption — a non-interactive paragraph — and tapping it
# looks exactly like a broken download. Pick the smallest-area node instead:
# the anchor is always nested inside whatever else carries the same string.
ui_query_smallest() {
  python3 - "$1" "$2" <<'PYQ'
import json, re, sys
path, needle = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    doc = json.load(f)

def walk(n):
    a = n.get('attributes', {})
    yield a
    for c in n.get('children', []):
        yield from walk(c)

best = None
for a in walk(doc):
    if needle not in (a.get('text') or ''):
        continue
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', a.get('bounds', ''))
    if not m:
        continue
    x1, y1, x2, y2 = map(int, m.groups())
    area = (x2 - x1) * (y2 - y1)
    if area > 0 and (best is None or area < best[0]):
        best = (area, (x1 + x2) // 2, (y1 + y2) // 2)
if best is None:
    sys.exit(1)
print(f'{best[1]} {best[2]}')
PYQ
}

require_hdc_and_target
ensure_screen_awake_and_unlocked "$LAYOUT"

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19421}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19422}"
MESSAGE="SENDFILE-$$-$RANDOM"

start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT" 150
ensure_rport "$SERVER_PORT"

reset_app_state
# Cleared AFTER the wipe and BEFORE the launch: everything this probe asserts
# on has to come from this run, not from a previous one that also downloaded a
# file with the same name.
hdc_ shell hilog -r >/dev/null 2>&1 || true
launch_app

setup_screen_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_query "$LAYOUT" hint 'https://your-server' >/dev/null 2>&1
}
if ! wait_until 20 1 setup_screen_visible; then
  fail "the shell never showed its server-address screen after a data wipe"
fi
dump_layout "$LAYOUT"
xy="$(ui_query "$LAYOUT" hint 'https://your-server')"
ui_type_at "$xy" "http://127.0.0.1:$SERVER_PORT"
hdc_ shell uitest uiInput keyEvent Back >/dev/null
dump_layout "$LAYOUT"
xy="$(ui_query_exact "$LAYOUT" text '连接')" || fail "连接 button not found on the server-address screen"
ui_tap "$xy"

web_login_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_query "$LAYOUT" hint '请输入 token' >/dev/null 2>&1
}
if ! wait_until 30 1 web_login_visible; then
  fail "the web app's token screen never appeared inside the WebView within 30s"
fi
dump_layout "$LAYOUT"
xy="$(ui_query "$LAYOUT" hint '请输入 token')"
web_type_at "$xy" "$FIXTURE_TOKEN"
dump_layout "$LAYOUT"
xy="$(ui_query_exact "$LAYOUT" text '进入')" || fail "进入 button not found on the web login screen"
ui_tap "$xy"

chat_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_query "$LAYOUT" hint '输入消息' >/dev/null 2>&1
}
if ! wait_until 30 1 chat_visible; then
  fail "the web chat screen never appeared after submitting the fixture token"
fi

dump_layout "$LAYOUT"
xy="$(ui_query "$LAYOUT" hint '输入消息')"
web_type_at "$xy" "$MESSAGE"
dump_layout "$LAYOUT"
xy="$(ui_query_exact "$LAYOUT" text '发送')" || fail "发送 button not found after typing a message"
ui_tap "$xy"

attachment_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" "$FILE_NAME"
}
if ! wait_until 25 1 attachment_visible; then
  fail "the bridge fixture's file frame never reached the transcript as '$FILE_NAME'" \
       " -- the download could not even be attempted"
fi

dump_layout "$LAYOUT"
xy="$(ui_query_smallest "$LAYOUT" "$FILE_NAME")" || fail "no node carries '$FILE_NAME'"
ui_tap "$xy"

download_logged() {
  hdc_ shell hilog -x 2>/dev/null | grep -q "download finish: name=$FILE_NAME"
}
if ! wait_until 20 1 download_logged; then
  echo "--- shell hilog ---"
  hdc_ shell hilog -x 2>/dev/null | grep "com.ccpet.client/Shell" || true
  fail "tapped the '$FILE_NAME' link but the shell's download delegate never logged" \
       " 'download finish' within 20s"
fi

hdc_ shell snapshot_display -f /data/local/tmp/ccpet-download-probe.jpeg >/dev/null 2>&1 || true
"$HDC_BIN" -t "$CCPET_DEVICE_TARGET" file recv /data/local/tmp/ccpet-download-probe.jpeg "$SHOT" >/dev/null 2>&1 || true

pass "the bridge fixture's file reached the transcript, tapping it drove ArkWeb's download" \
     " path into the shell's WebDownloadDelegate, and '$FILE_NAME' was written to the app" \
     " sandbox (screenshot: $SHOT)"
