#!/usr/bin/env bash
# device-slash-palette-probe.sh — assert the slash-command palette actually
# opens above the input, narrows as you type, and closes when the input is
# cleared. Drives the real MessageInput/SlashCommandMenu on the emulator.
#
# Targets the emulator (127.0.0.1:5555) by default; override with
# CCPET_DEVICE_TARGET. Never touches the operator's real server or token --
# it clears the target's app data and logs in against a throwaway local
# server + bridge fixture it starts and tears down itself, exactly like the
# other device-*.sh probes.
#
# ---------------------------------------------------------------------------
# READ THIS BEFORE YOU "FIX" THE PALETTE
# ---------------------------------------------------------------------------
# This probe deliberately does NOT use common.sh's `ui_type_at`
# (`uitest uiInput inputText <x> <y> <text>`). That command PREPENDS A SPACE
# to whatever you ask it to type. Measured on this emulator, typing into a
# genuinely empty TextArea (its dumped `text` attribute before -> after):
#
#     ''  --inputText "abc"-->  ' abc'
#     ''  --inputText "/cl"-->  ' /cl'
#
# A leading space is exactly what `isSlashInput` refuses (see
# logic/slashCommands.ets), so any probe that types a slash command through
# `ui_type_at` sees an empty palette forever and concludes the feature is
# broken when it is not. That mis-observation is the whole of the "the
# palette never renders on the emulator" bug report this probe was written to
# settle: with the text actually reaching the component as '/cl', the palette
# renders. Nothing in the component was wrong.
#
# Two input paths that do NOT corrupt the text, both used below:
#   * `uitest uiInput text <text>`     -- IME commit into the focused field
#   * `uitest uiInput keyEvent <code>` -- hardware key injection
#
# Second trap, also from that bug report: the 发送 button's y-coordinate is
# NOT a palette-presence signal. MessageInput's Column is bottom-anchored
# (MessageList above it carries `layoutWeight(1)`), so the palette grows
# UPWARD and the input row does not move -- 发送 sits at the same y with the
# palette open and closed. Assert on the palette's own nodes, as below.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-slash-palette-probe"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-slash-probe.XXXXXX")"
LAYOUT="$WORKDIR/layout.json"
# Screenshots land next to the build outputs rather than in $WORKDIR so they
# survive this probe's own cleanup and can be looked at afterwards.
SHOT_DIR="${CCPET_PROBE_SHOT_DIR:-$HARMONY_DIR/entry/build/probe-evidence}"

cleanup() {
  local ec=$?
  stop_fixture_stack
  rm -rf "$WORKDIR"
  exit "$ec"
}
trap cleanup EXIT

# KEYCODE_DEL, from @ohos.multimodalInput.keyCode.d.ts.
KEYCODE_DEL=2055

# Types into whatever is already focused, via the IME, without the leading
# space `uitest uiInput inputText` injects. See the header note.
ui_type_focused() {
  hdc_ shell uitest uiInput text "$1" >/dev/null
}

# Space-separated list of the slash commands SlashCommandMenu is currently
# rendering, in visual order. A row is a Text node whose text starts with '/'
# and which sits strictly ABOVE the TextArea -- the "above" test is
# load-bearing, because while you are typing a command the TextArea's own
# content also starts with '/' and would otherwise count as a row.
palette_rows() {
  python3 - "$1" <<'PY'
import json, re, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))

def walk(node):
    a = node.get('attributes', {})
    yield a
    for c in node.get('children', []):
        yield from walk(c)

def bounds(a):
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', a.get('bounds', ''))
    return tuple(map(int, m.groups())) if m else None

attrs = list(walk(doc))
input_top = None
for a in attrs:
    if a.get('type') == 'TextArea':
        b = bounds(a)
        if b:
            input_top = b[1]
            break
if input_top is None:
    sys.exit(1)

rows = []
for a in attrs:
    if a.get('type') != 'Text':
        continue
    text = a.get('text') or ''
    if not text.startswith('/'):
        continue
    b = bounds(a)
    if b and b[3] <= input_top:
        rows.append((b[1], text))
rows.sort()
print(' '.join(t for _y, t in rows))
PY
}

input_text_value() {
  python3 - "$1" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))

def walk(node):
    a = node.get('attributes', {})
    yield a
    for c in node.get('children', []):
        yield from walk(c)

for a in walk(doc):
    if a.get('type') == 'TextArea':
        print(a.get('text') or '')
        sys.exit(0)
sys.exit(1)
PY
}

grab_screenshot() {
  local name="$1" remote="/data/local/tmp/ccpet-slash-$1.jpeg"
  mkdir -p "$SHOT_DIR"
  hdc_ shell snapshot_display -f "$remote" >/dev/null 2>&1 || return 0
  "$HDC_BIN" -t "$CCPET_DEVICE_TARGET" file recv "$remote" "$SHOT_DIR/$name.jpeg" >/dev/null 2>&1 || return 0
  echo "  screenshot: $SHOT_DIR/$name.jpeg"
}

require_hdc_and_target
ensure_screen_awake_and_unlocked "$LAYOUT"

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19331}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19332}"

start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT" 150
ensure_rport "$SERVER_PORT"

reset_app_state
launch_app
perform_login "http://127.0.0.1:$SERVER_PORT" "$FIXTURE_TOKEN" "$LAYOUT"
grant_notification_permission_if_present "$LAYOUT"

dump_layout "$LAYOUT"
input_xy="$(ui_query "$LAYOUT" hint '输入消息')" || fail "MessageInput text field not found on the chat screen"
ui_tap "$input_xy"
sleep 1

# --- 1. a bare '/' opens the palette with the full command list -------------
ui_type_focused '/'
sleep 1
dump_layout "$LAYOUT"
typed="$(input_text_value "$LAYOUT")"
[[ "$typed" == '/' ]] || fail "expected the input to hold exactly '/', got '$typed'." \
  " A leading space here means something typed through 'uiInput inputText' -- see this file's header."

opened="$(palette_rows "$LAYOUT")" || fail "could not locate the TextArea in the layout dump"
row_count="$(printf '%s\n' $opened | grep -c . || true)"
if (( row_count < 2 )); then
  fail "typing '/' rendered $row_count palette row(s) above the input; expected the full command list." \
       " Rows seen: ${opened:-<none>}"
fi
echo "  '/' -> $row_count rows above the input: $opened"
ui_contains "$LAYOUT" '本地命令' \
  || fail "palette opened but the '本地命令' category header is missing -- SlashCommandMenu's grouping regressed"
grab_screenshot 'slash-only'

# --- 2. '/cl' narrows the palette to exactly /clear ------------------------
ui_type_focused 'cl'
sleep 1
dump_layout "$LAYOUT"
typed="$(input_text_value "$LAYOUT")"
[[ "$typed" == '/cl' ]] || fail "expected the input to hold exactly '/cl', got '$typed'"

narrowed="$(palette_rows "$LAYOUT")" || fail "could not locate the TextArea in the layout dump"
[[ "$narrowed" == '/clear' ]] \
  || fail "with '/cl' typed, expected exactly one palette row '/clear' above the input, got: ${narrowed:-<none>}"
echo "  '/cl' -> palette row(s) above the input: $narrowed"
grab_screenshot 'cl-typed'

# --- 3. clearing the input closes the palette ------------------------------
for _ in 1 2 3; do
  hdc_ shell uitest uiInput keyEvent "$KEYCODE_DEL" >/dev/null
done
sleep 1
dump_layout "$LAYOUT"
typed="$(input_text_value "$LAYOUT")"
[[ -z "$typed" ]] || fail "expected the input to be empty after three deletes, got '$typed'"

leftover="$(palette_rows "$LAYOUT")" || fail "could not locate the TextArea in the layout dump"
[[ -z "$leftover" ]] || fail "input is empty but the palette is still showing: $leftover"
echo "  cleared -> no palette rows"
grab_screenshot 'cleared'

pass "palette opens above the input on '/', narrows to exactly /clear on '/cl', and closes when the input is cleared"
