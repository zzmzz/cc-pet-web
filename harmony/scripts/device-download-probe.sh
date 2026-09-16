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
# The tap now opens the system save sheet (DocumentViewPicker), so this probe
# drives that too, and its ASSERTION IS THE DESTINATION FILE'S SIZE, not a log
# line. That distinction is the whole reason this file changed: the first
# picker implementation passed `item.start(<the picker's uri>)` and logged
# `download finish ... receivedBytes=380` while the file it had just created in
# Download stayed 0 bytes — every log-only check was green over an empty file.
# `hilog` alone cannot tell "saved" from "reported saved". `ls -l` can.
#
# (The shell's own hilog lines are still checked, because the intermediate
# sandbox path it copies from is owned by the app's uid and `hdc shell ls`
# answers "Permission denied" for it.)
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

# The save sheet's three top-bar controls (cancel / new folder / confirm) are
# bare `SymbolGlyph` icons: no text, no hint, no description. Nothing in the
# dump names the checkmark, so it has to be found by position -- the rightmost
# clickable node in the band above the "将文件保存至" heading. Written as a rule
# rather than a hardcoded coordinate so it survives a different screen size.
ui_picker_confirm() {
  python3 - "$1" <<'PYC'
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as f:
    doc = json.load(f)

def walk(n):
    a = n.get('attributes', {})
    yield a
    for c in n.get('children', []):
        yield from walk(c)

def box(a):
    m = re.match(r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', a.get('bounds', ''))
    return tuple(map(int, m.groups())) if m else None

heading_top = None
for a in walk(doc):
    if '将文件保存至' in (a.get('text') or ''):
        b = box(a)
        if b:
            heading_top = b[1]
            break
if heading_top is None:
    sys.exit(1)

best = None
for a in walk(doc):
    if str(a.get('clickable', '')).lower() != 'true':
        continue
    b = box(a)
    if not b:
        continue
    x1, y1, x2, y2 = b
    # Strictly above the heading, and inside the sheet (not the status bar).
    if y2 > heading_top or y1 < 140:
        continue
    cx = (x1 + x2) // 2
    if best is None or cx > best[0]:
        best = (cx, (y1 + y2) // 2)
if best is None:
    sys.exit(1)
print(f'{best[0]} {best[1]}')
PYC
}

# `uitest uiInput click` focuses a web <input> and raises the IME, but was
# measured NOT to fire click handlers on web <button>s in this ArkWeb build --
# repeated taps on 发送 / 进入 at their dumped centres did nothing, with no
# request reaching the fixture server. A touch with a real hold (down, 80ms,
# up) fires them every time. Native ArkUI controls and the system save sheet
# are fine with either; this is used wherever the target is inside the WebView.
web_tap() {
  local x="${1%% *}" y="${1##* }"
  hdc_ shell uinput -T -d "$x" "$y" -i 80 -u "$x" "$y" >/dev/null 2>&1
}

# Byte count of a file on the device, or empty if it does not exist.
#
# Deliberately NOT `tr -cd '0-9'` over the raw output: when the file is absent
# the shell answers "can't open /storage/media/100/local/files/..." and that
# message's own path digits ("100") survive the squeeze, so an absent file
# reads back as a non-empty size. Only a line that is *nothing but* digits is
# a size.
remote_size() {
  hdc_ shell "wc -c < $1" 2>/dev/null \
    | tr -d '\r' \
    | grep -E '^[[:space:]]*[0-9]+[[:space:]]*$' \
    | tr -cd '0-9'
}

require_hdc_and_target
ensure_screen_awake_and_unlocked "$LAYOUT"

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19421}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19422}"
MESSAGE="SENDFILE-$$-$RANDOM"

# Where the save sheet's "Download" row actually writes, and the exact byte
# count of the bridge fixture's file payload ("hello from the probe bridge\n").
# The size is asserted, not just existence: `DocumentViewPicker.save()` creates
# the destination file itself, so "the file is there" is true even when not one
# byte of the download reached it -- which is precisely the bug this probe was
# rewritten to catch.
DEST_DIR="/storage/media/100/local/files/Docs/Download"
DEST_PATH="$DEST_DIR/$FILE_NAME"
EXPECTED_BYTES=28

start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT" 150
ensure_rport "$SERVER_PORT"

reset_app_state
# Cleared AFTER the wipe and BEFORE the launch: everything this probe asserts
# on has to come from this run, not from a previous one that also downloaded a
# file with the same name.
hdc_ shell hilog -r >/dev/null 2>&1 || true
# ArkWeb logs thousands of DEBUG lines a second under the `chromium` tag; left
# alone they evict the shell's own hilog lines from the buffer within seconds,
# and the grep below then "proves" the download never happened. Demote them.
hdc_ shell hilog -b E -T chromium >/dev/null 2>&1 || true
# `reset_app_state` wipes the app, not the public Download directory -- the
# saved file outlives the app by design. A stale copy from an earlier run would
# satisfy the size assertion without this run downloading anything.
hdc_ shell rm -f "$DEST_PATH" >/dev/null 2>&1 || true
# `ls` is not usable as the existence check: when the file is absent it prints
# "ls: <path>: No such file or directory", which contains the path and so
# matches any naive grep for it. Ask for the byte count instead -- see
# remote_size for why that also needs care.
if [[ -n "$(remote_size "$DEST_PATH")" ]]; then
  fail "could not clear the previous run's '$DEST_PATH'; this probe refuses to" \
       " assert on a file it cannot prove came from this run"
fi
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
# NO `keyEvent Back` here. It used to be, to dismiss the IME -- but `uitest
# uiInput text` leaves the IME already closed on this emulator, so Back reaches
# the shell instead, and §5's back handling (nothing to go back to, hand it to
# the system) EXITS THE APP. The next dump then finds a launcher and reports
# "连接 button not found", which reads like a UI bug and is not one. The 连接
# button is fully visible with or without the IME, so nothing needs dismissing.
dump_layout "$LAYOUT"
xy="$(ui_query_exact "$LAYOUT" text '连接')" || fail "连接 button not found on the server-address screen"
ui_tap "$xy"

web_login_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_query "$LAYOUT" hint '请输入 token' >/dev/null 2>&1
}
# 90s, not 30: on a cold-booted emulator ArkWeb's first paint of this page
# took ~20s and one run tripped the system's own THREAD_BLOCK_6S watchdog on
# the way. 30s was a measurement of a warm emulator, not a property of the app.
if ! wait_until 90 1 web_login_visible; then
  fail "the web app's token screen never appeared inside the WebView within 90s"
fi
dump_layout "$LAYOUT"
xy="$(ui_query "$LAYOUT" hint '请输入 token')"
web_type_at "$xy" "$FIXTURE_TOKEN"
dump_layout "$LAYOUT"
xy="$(ui_query_exact "$LAYOUT" text '进入')" || fail "进入 button not found on the web login screen"
web_tap "$xy"

chat_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_query "$LAYOUT" hint '输入消息' >/dev/null 2>&1
}
if ! wait_until 90 1 chat_visible; then
  fail "the web chat screen never appeared after submitting the fixture token"
fi

dump_layout "$LAYOUT"
xy="$(ui_query "$LAYOUT" hint '输入消息')"
web_type_at "$xy" "$MESSAGE"
dump_layout "$LAYOUT"
xy="$(ui_query_exact "$LAYOUT" text '发送')" || fail "发送 button not found after typing a message"
web_tap "$xy"

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
web_tap "$xy"

# The tap no longer downloads anything by itself: it opens the system save
# sheet and the download stays PENDING until a destination comes back.
save_sheet_visible() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" '将文件保存至'
}
if ! wait_until 25 1 save_sheet_visible; then
  fail "tapping the '$FILE_NAME' link did not open the system save sheet" \
       " (DocumentViewPicker.save). Without it the shell has nowhere reachable to" \
       " put the file, and must not claim 已保存."
fi

dump_layout "$LAYOUT"
xy="$(ui_query_exact "$LAYOUT" text 'Download')" \
  || fail "the save sheet has no 'Download' row to select as the destination"
ui_tap "$xy"
sleep 1
dump_layout "$LAYOUT"
ui_contains "$LAYOUT" '将文件保存至 "Download"' \
  || fail "selecting the save sheet's 'Download' row did not make it the destination;" \
          " the probe will not confirm a save into an unknown directory"

xy="$(ui_picker_confirm "$LAYOUT")" \
  || fail "could not locate the save sheet's confirm control (the rightmost clickable" \
          " icon above the 将文件保存至 heading)"
ui_tap "$xy"

download_logged() {
  hdc_ shell hilog -x -t app 2>/dev/null | grep -q "download saved: name=$FILE_NAME"
}
if ! wait_until 25 1 download_logged; then
  echo "--- shell hilog ---"
  hdc_ shell hilog -x -t app 2>/dev/null | grep "com.ccpet.client/Shell" || true
  # Report the destination's size in the same breath. Measured against a build
  # that toasted 已保存 without copying anything, this is what the reader needs:
  # "0" here means the save sheet ran, the file was created, and not one byte
  # of the download reached it.
  echo "--- '$DEST_PATH' size: $(remote_size "$DEST_PATH" || true) (expected $EXPECTED_BYTES) ---"
  fail "confirmed the save sheet but the shell never logged 'download saved' within 25s"
fi

# The assertion that matters. `DocumentViewPicker.save()` creates the file, so
# existence proves nothing -- only the byte count separates "saved" from
# "reported saved over an empty file".
actual_bytes="$(remote_size "$DEST_PATH")"
if [[ -z "$actual_bytes" ]]; then
  fail "the shell logged 'download saved' but '$DEST_PATH' is not readable/does not exist"
fi
if [[ "$actual_bytes" != "$EXPECTED_BYTES" ]]; then
  fail "'$DEST_PATH' is $actual_bytes bytes, expected $EXPECTED_BYTES." \
       " A 0-byte file here is the exact failure mode of passing the picker's uri" \
       " straight to WebDownloadItem.start(): it reports success and writes nothing" \
       " the user can reach."
fi

hdc_ shell snapshot_display -f /data/local/tmp/ccpet-download-probe.jpeg >/dev/null 2>&1 || true
"$HDC_BIN" -t "$CCPET_DEVICE_TARGET" file recv /data/local/tmp/ccpet-download-probe.jpeg "$SHOT" >/dev/null 2>&1 || true

pass "the bridge fixture's file reached the transcript, tapping it drove ArkWeb's download" \
     " path into the shell's WebDownloadDelegate, the system save sheet chose Download, and" \
     " '$DEST_PATH' holds all $EXPECTED_BYTES bytes (screenshot: $SHOT)"
