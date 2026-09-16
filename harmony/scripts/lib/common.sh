#!/usr/bin/env bash
# Shared helpers for the cc-pet HarmonyOS device probes (harmony/scripts/device-*.sh).
#
# This project verifies against the emulator, not a physical phone — every
# probe here targets `127.0.0.1:5555` by default. The target is configurable
# (CCPET_DEVICE_TARGET) so the same scripts work against a real device, but
# nothing here assumes a phone is attached.
#
# Source this file; do not execute it directly.

if [[ -n "${CCPET_COMMON_SH_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
CCPET_COMMON_SH_LOADED=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HARMONY_DIR="$REPO_ROOT/harmony"
BUNDLE_NAME="com.ccpet.client"
ABILITY_NAME="EntryAbility"

: "${CCPET_DEVICE_TARGET:=127.0.0.1:5555}"
: "${DEVECO_SDK_HOME:=/Applications/DevEco-Studio.app/Contents/sdk}"

# ---------------------------------------------------------------------------
# hdc resolution
# ---------------------------------------------------------------------------

resolve_hdc() {
  if [[ -n "${HDC_BIN:-}" ]]; then
    echo "$HDC_BIN"
    return 0
  fi
  if command -v hdc >/dev/null 2>&1; then
    command -v hdc
    return 0
  fi
  local candidate="$DEVECO_SDK_HOME/default/openharmony/toolchains/hdc"
  if [[ -x "$candidate" ]]; then
    echo "$candidate"
    return 0
  fi
  echo ""
  return 1
}

HDC_BIN="$(resolve_hdc || true)"

hdc_() {
  "$HDC_BIN" -t "$CCPET_DEVICE_TARGET" "$@"
}

# ---------------------------------------------------------------------------
# PASS/FAIL — explicit lines, non-zero exit. Never just an exit code.
# ---------------------------------------------------------------------------

PROBE_NAME="${PROBE_NAME:-$(basename "${0:-probe}")}"

pass() {
  echo "PASS: [$PROBE_NAME] $*"
  exit 0
}

fail() {
  echo "FAIL: [$PROBE_NAME] $*"
  exit 1
}

# Bounded wait loop — never hangs. Usage: wait_until <timeout_s> <interval_s> <cmd...>
wait_until() {
  local timeout="$1" interval="$2"
  shift 2
  local waited=0
  while true; do
    if "$@"; then
      return 0
    fi
    waited=$(( waited + interval ))
    if (( waited >= timeout )); then
      return 1
    fi
    sleep "$interval"
  done
}

# ---------------------------------------------------------------------------
# Device/target preflight
# ---------------------------------------------------------------------------

require_hdc_and_target() {
  if [[ -z "$HDC_BIN" ]]; then
    fail "hdc binary not found (set DEVECO_SDK_HOME or HDC_BIN); this probe never falls back to hanging without it"
  fi
  if ! "$HDC_BIN" list targets 2>/dev/null | grep -qx "$CCPET_DEVICE_TARGET"; then
    fail "device target '$CCPET_DEVICE_TARGET' is not connected (hdc list targets did not list it)." \
         " This probe targets the emulator by design — start it (or point CCPET_DEVICE_TARGET at a" \
         " real device) and retry. It will not wait for one to appear."
  fi
}

# hdc's reverse port forward (rport) was observed to silently deregister
# itself mid-session during Task 17's on-device verification (confirmed via
# `hdc fport ls` showing it gone with no error at the time it died). A probe
# that depends on it must verify it's actually registered and re-establish it
# rather than blindly assuming it's still there and hanging on a dead tunnel.
ensure_rport() {
  local port="$1"
  "$HDC_BIN" -t "$CCPET_DEVICE_TARGET" rport "tcp:$port" "tcp:$port" >/dev/null 2>&1 || true
  if ! "$HDC_BIN" fport ls 2>/dev/null | grep -q "tcp:$port tcp:$port"; then
    fail "could not establish hdc rport tcp:$port <-> tcp:$port (this is the exact tunnel-death" \
         " mode flagged in the Task 17 report — check 'hdc fport ls' by hand before assuming the" \
         " app itself is broken)"
  fi
}

# ---------------------------------------------------------------------------
# uitest-backed UI inspection (real, on-device state — not a log grep for
# strings this codebase never actually logs; see harmony/README.md).
# ---------------------------------------------------------------------------

# Pulls a fresh layout dump to the given local path. Fails loudly rather than
# returning an empty/stale file if uitest didn't report a save path.
dump_layout() {
  local local_out="$1"
  local raw
  raw="$(hdc_ shell uitest dumpLayout 2>/dev/null)" || true
  local remote
  remote="$(printf '%s' "$raw" | sed -n 's/^DumpLayout saved to://p' | tr -d '\r\n')"
  if [[ -z "$remote" ]]; then
    fail "uitest dumpLayout did not report a saved path (got: ${raw:-<empty>})"
  fi
  if ! "$HDC_BIN" -t "$CCPET_DEVICE_TARGET" file recv "$remote" "$local_out" >/dev/null 2>&1; then
    fail "failed to pull layout dump ($remote) from device"
  fi
}

# Same as dump_layout, but returns 1 instead of exiting the whole probe --
# for use inside wait_until polling loops, where a single transient uitest
# hiccup should be retried, not treated as an immediate hard failure.
dump_layout_soft() {
  local local_out="$1"
  local raw remote
  raw="$(hdc_ shell uitest dumpLayout 2>/dev/null)" || return 1
  remote="$(printf '%s' "$raw" | sed -n 's/^DumpLayout saved to://p' | tr -d '\r\n')"
  [[ -n "$remote" ]] || return 1
  "$HDC_BIN" -t "$CCPET_DEVICE_TARGET" file recv "$remote" "$local_out" >/dev/null 2>&1
}

# ui_query <json-file> <field: text|hint> <needle>
# Prints "cx cy" (bounds center) of the first matching node, or nothing (and
# a non-zero exit) if no node matches.
ui_query() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, re, sys
path, field, needle = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as f:
    doc = json.load(f)

def walk(n):
    a = n.get('attributes', {})
    yield a
    for c in n.get('children', []):
        yield from walk(c)

for a in walk(doc):
    if needle in (a.get(field) or ''):
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', a.get('bounds', ''))
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            print(f'{(x1 + x2) // 2} {(y1 + y2) // 2}')
            sys.exit(0)
sys.exit(1)
PY
}

# ui_query_exact <json-file> <field> <exact-value>
# Same as ui_query but requires an exact match, not substring containment --
# needed for e.g. '允许' vs '不允许' (the deny button's label contains the
# allow button's label as a substring).
ui_query_exact() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, re, sys
path, field, needle = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as f:
    doc = json.load(f)

def walk(n):
    a = n.get('attributes', {})
    yield a
    for c in n.get('children', []):
        yield from walk(c)

for a in walk(doc):
    if (a.get(field) or '') == needle:
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', a.get('bounds', ''))
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            print(f'{(x1 + x2) // 2} {(y1 + y2) // 2}')
            sys.exit(0)
sys.exit(1)
PY
}

# ui_contains <json-file> <needle> — true (exit 0) if any text/hint node
# contains the substring.
ui_contains() {
  python3 - "$1" "$2" <<'PY'
import json, sys
path, needle = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    doc = json.load(f)

def walk(n):
    a = n.get('attributes', {})
    yield a
    for c in n.get('children', []):
        yield from walk(c)

for a in walk(doc):
    if needle in (a.get('text') or '') or needle in (a.get('hint') or ''):
        sys.exit(0)
sys.exit(1)
PY
}

# screen_size <json-file> — prints "W H" read from the root node's bounds,
# so gestures (like the notification-shade swipe) scale to whatever the
# current device/emulator's resolution actually is instead of a hardcoded
# constant.
screen_size() {
  python3 - "$1" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding='utf-8') as f:
    doc = json.load(f)
m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', doc.get('attributes', {}).get('bounds', ''))
if not m:
    sys.exit(1)
x1, y1, x2, y2 = map(int, m.groups())
print(f'{x2 - x1} {y2 - y1}')
PY
}

ui_tap() {
  local xy="$1"
  hdc_ shell uitest uiInput click $xy >/dev/null
}

# Taps the field, then commits the text through the IME.
#
# Do NOT go back to `uitest uiInput inputText <x> <y> <text>`. That command
# PREPENDS A SPACE to whatever you ask it to type, measured on this emulator:
# asking for '/cl' delivers ' /cl'. It corrupted every string every probe here
# typed, and went unnoticed for the whole project because the two places it
# could have failed loudly both absorbed it -- `LoginGate` calls `.trim()` on
# the URL and token, and the chat probes assert on a substring of the echo.
# It was finally caught when it made the slash palette look permanently dead
# (`isSlashInput` requires a strict leading slash), and roughly a day went
# into "debugging" a component that was working the entire time.
#
# `uitest uiInput text <text>` delivers the string verbatim. Verified on this
# emulator against both the IME path and `keyEvent` hardware-key injection.
ui_type_at() {
  local xy="$1" text="$2"
  hdc_ shell uitest uiInput click $xy >/dev/null
  hdc_ shell uitest uiInput text "$text" >/dev/null
}

# ---------------------------------------------------------------------------
# Throwaway fixture stack: the real `packages/server` (unmodified — this
# constraint never runs anything under packages/ except the server's own
# `start` script) plus a minimal external-bridge stand-in that answers
# `message` frames with a `reply_stream` (delta then done), so probes get a
# genuine round trip through the real bridge protocol rather than a
# hand-waved log check. Everything here lives under a mktemp dir, is never
# committed, and is torn down by the probe's own EXIT trap.
# ---------------------------------------------------------------------------

FIXTURE_DIR=""
FIXTURE_TOKEN=""
FIXTURE_SERVER_PORT=""
FIXTURE_BRIDGE_PORT=""

start_fixture_stack() {
  local server_port="$1" bridge_port="$2" reply_delay_ms="${3:-150}"
  # The readiness check at the bottom of this function only waits for the port
  # to OPEN -- it cannot tell our server apart from a stale one left listening
  # by an earlier run. A squatter passes that check and then rejects every
  # token, which presents as "the login screen just sits there" and cost three
  # probe runs to diagnose. Refusing to start is the only honest answer: the
  # alternative is a probe that reports on someone else's process.
  local squatter
  for squatter in "$server_port" "$bridge_port"; do
    if lsof -nP -iTCP:"$squatter" -sTCP:LISTEN >/dev/null 2>&1; then
      fail "tcp:$squatter is already in use before the fixture stack starts --" \
           " something (probably a fixture server from an earlier run that was not torn down)" \
           " owns it. Run 'lsof -nP -iTCP:$squatter -sTCP:LISTEN' and kill it; do NOT assume the" \
           " app is broken."
    fi
  done
  FIXTURE_SERVER_PORT="$server_port"
  FIXTURE_BRIDGE_PORT="$bridge_port"
  FIXTURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-probe.XXXXXX")"
  FIXTURE_TOKEN="probe-$(date +%s)-$RANDOM"
  mkdir -p "$FIXTURE_DIR/data"

  cat > "$FIXTURE_DIR/data/cc-pet.config.json" <<JSON
{
  "bridges": [{ "id": "probe-bridge", "name": "ProbeBridge", "host": "127.0.0.1", "port": $bridge_port, "token": "probe-bridge-secret", "enabled": true }],
  "tokens": [{ "token": "$FIXTURE_TOKEN", "name": "probe", "bridgeIds": ["probe-bridge"] }],
  "pet": { "opacity": 1, "size": 120 },
  "server": { "port": $server_port, "dataDir": "./data" }
}
JSON

  # CommonJS, not ESM: Node's ESM resolver doesn't honor NODE_PATH, and this
  # file intentionally lives outside any package.json (mktemp dir) so it must
  # borrow packages/server's own `ws` dependency via NODE_PATH instead.
  cat > "$FIXTURE_DIR/bridge-fixture.cjs" <<'NODE'
const { WebSocketServer } = require('ws');
const http = require('node:http');
const port = Number(process.argv[2]);
const delayMs = Number(process.argv[3] || 150);
const server = http.createServer();
const wss = new WebSocketServer({ server, path: '/bridge/ws' });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'register') {
      ws.send(JSON.stringify({ type: 'register_ack', ok: true }));
      return;
    }
    if (msg.type === 'message') {
      const text = String(msg.content ?? '');
      // A `message` containing SENDFILE also gets a bridge `file` frame, so a
      // probe can drive the one path nothing else in this stack reaches: the
      // server persists it under /api/files/* and packages/web renders a
      // download link for it. Gated on the magic word so every other probe's
      // traffic is unaffected.
      if (text.includes('SENDFILE')) {
        ws.send(JSON.stringify({
          type: 'file', session_key: msg.session_key,
          name: 'probe-download.txt',
          data: Buffer.from('hello from the probe bridge\n').toString('base64'),
        }));
      }
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'reply_stream', session_key: msg.session_key, reply_ctx: msg.reply_ctx, chunk: `probe-echo: ${text}` }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'reply_stream', session_key: msg.session_key, reply_ctx: msg.reply_ctx, done: true, full_text: `probe-echo: ${text}` }));
        }, delayMs);
      }, delayMs);
    }
  });
});
server.listen(port, '127.0.0.1', () => console.log('[fixture-bridge] listening on', port));
NODE

  (
    exec env NODE_PATH="$REPO_ROOT/packages/server/node_modules" \
      node "$FIXTURE_DIR/bridge-fixture.cjs" "$bridge_port" "$reply_delay_ms"
  ) > "$FIXTURE_DIR/bridge.log" 2>&1 &
  echo $! > "$FIXTURE_DIR/bridge.pid"

  start_fixture_server_process "$server_port"

  if ! wait_until 30 1 nc -z 127.0.0.1 "$server_port"; then
    fail "throwaway fixture server never opened tcp:$server_port within 30s -- see $FIXTURE_DIR/server.log"
  fi
}

# Invoked directly with `node`, deliberately not through `pnpm --filter ...
# start`: pnpm doesn't forward signals to the child process it spawns, so a
# `kill "$(pnpm's own pid)"` (as kill_fixture_server below needs to do, to
# simulate "the server goes away") would leave the real listening process
# alive and orphaned -- discovered the hard way while building the reconnect
# probe (the badge never left 已连接 because the server hadn't actually died).
start_fixture_server_process() {
  local server_port="$1"
  # `exec` inside the subshell is load-bearing: without it, backgrounding a
  # `cd ... && env FOO=bar node ...` list makes `$!` the PID of the subshell
  # running that list, not of `node` itself (bash only exec-replaces the
  # final command of a list in some cases, not reliably here) -- so a later
  # `kill "$!"` kills the subshell and orphans the real server process,
  # leaving it listening. `exec` forces the replacement explicitly.
  (
    cd "$REPO_ROOT/packages/server"
    exec env CC_PET_DATA_DIR="$FIXTURE_DIR/data" CC_PET_PORT="$server_port" \
      node --import tsx src/index.ts
  ) >> "$FIXTURE_DIR/server.log" 2>&1 &
  echo $! > "$FIXTURE_DIR/server.pid"
}

stop_fixture_stack() {
  # Every step below is deliberately guarded with `|| true`: this runs from
  # an EXIT trap under `set -euo pipefail`, and a bare `cmd1 && cmd2` whose
  # last command fails would abort the script right here -- silently
  # replacing whatever real PASS/FAIL exit code this trap was invoked to
  # preserve (see the `local ec=$?` / `exit "$ec"` pattern in each probe).
  if [[ -n "$FIXTURE_DIR" && -f "$FIXTURE_DIR/server.pid" ]]; then
    kill "$(cat "$FIXTURE_DIR/server.pid")" 2>/dev/null || true
  fi
  if [[ -n "$FIXTURE_DIR" && -f "$FIXTURE_DIR/bridge.pid" ]]; then
    kill "$(cat "$FIXTURE_DIR/bridge.pid")" 2>/dev/null || true
  fi
  if [[ -n "$FIXTURE_DIR" ]]; then
    rm -rf "$FIXTURE_DIR" 2>/dev/null || true
  fi
  return 0
}

# Kills only the main server half of the stack (used by the reconnect probe
# to simulate "the server goes away" without tearing down the bridge fixture
# too).
kill_fixture_server() {
  if [[ -n "$FIXTURE_DIR" && -f "$FIXTURE_DIR/server.pid" ]]; then
    kill "$(cat "$FIXTURE_DIR/server.pid")" 2>/dev/null || true
  fi
  return 0
}

restart_fixture_server() {
  start_fixture_server_process "$FIXTURE_SERVER_PORT"
  if ! wait_until 30 1 nc -z 127.0.0.1 "$FIXTURE_SERVER_PORT"; then
    fail "restarted fixture server never reopened tcp:$FIXTURE_SERVER_PORT within 30s -- see $FIXTURE_DIR/server.log"
  fi
}

# ---------------------------------------------------------------------------
# App driving
# ---------------------------------------------------------------------------

# Force-stops and clears app data so every probe run starts from a known,
# deterministic state (LoginGate) rather than trusting whatever was left over
# from a previous manual session.
reset_app_state() {
  hdc_ shell bm clean -n "$BUNDLE_NAME" -d >/dev/null 2>&1 || true
  hdc_ shell aa force-stop "$BUNDLE_NAME" >/dev/null 2>&1 || true
}

launch_app() {
  hdc_ shell aa start -a "$ABILITY_NAME" -b "$BUNDLE_NAME" >/dev/null
}

# Emulator sessions observed going idle into a locked/screen-off state
# between manual test runs while building these probes -- `aa start` alone
# does not bring the app in front of a lock screen (it starts the ability,
# but the keyguard stays on top), which then makes every later assertion
# fail with a confusing "neither login gate nor chat screen" message that
# has nothing to do with the app itself. This is a no-op if the app's own UI
# is already visible; it only presses Power / swipes when it isn't.
ensure_screen_awake_and_unlocked() {
  local layout="$1"
  dump_layout_soft "$layout" || true
  if ui_contains "$layout" 'cc-pet' || ui_contains "$layout" '发送'; then
    return 0
  fi
  if [[ ! -s "$layout" ]]; then
    hdc_ shell uitest uiInput keyEvent Power >/dev/null 2>&1 || true
    sleep 1
    dump_layout_soft "$layout" || true
  fi
  local sw sh
  read -r sw sh < <(screen_size "$layout" 2>/dev/null) || { sw=1256; sh=2760; }
  local midx=$(( sw / 2 ))
  hdc_ shell uitest uiInput swipe "$midx" "$(( sh * 9 / 10 ))" "$midx" "$(( sh * 2 / 10 ))" 300 >/dev/null 2>&1 || true
  sleep 1
  launch_app
  sleep 1
}

# Drives the real LoginGate UI end-to-end against the given server URL/token,
# then waits for the chat screen's connection badge. Requires the app to
# currently be showing LoginGate (call reset_app_state + launch_app first).
perform_login() {
  local server_url="$1" token="$2" layout="$3"

  dump_layout "$layout"
  local xy
  xy="$(ui_query "$layout" hint 'https://your-server')" || fail "LoginGate server-url field not found -- app did not reach the login gate"
  ui_tap "$xy"; ui_type_at "$xy" "$server_url"

  dump_layout "$layout"
  xy="$(ui_query "$layout" hint 'Token')" || fail "LoginGate token field not found"
  ui_tap "$xy"; ui_type_at "$xy" "$token"

  hdc_ shell uitest uiInput keyEvent Back >/dev/null   # dismiss IME so the button is reachable
  dump_layout "$layout"
  xy="$(ui_query "$layout" text '登录')" || fail "LoginGate 登录 button not found after filling credentials"
  ui_tap "$xy"

  if ! wait_until 15 1 login_reached_chat_screen "$layout"; then
    fail "auth did not verify -- chat screen (发送 button) never appeared within 15s of tapping 登录"
  fi
}

# Helper used only via wait_until above (must be a standalone command, run
# directly in this shell -- no subshell, so it shares dump_layout/ui_query).
login_reached_chat_screen() {
  local layout="$1"
  dump_layout_soft "$layout" || return 1
  ui_query "$layout" text '发送' >/dev/null 2>&1
}

# If the first-run "允许 X 向你发送通知？" system dialog is currently showing,
# taps 允许 (Allow). No-ops if it isn't there -- this must never be the thing
# that makes a probe hang.
grant_notification_permission_if_present() {
  local layout="$1"
  dump_layout "$layout"
  local xy
  if xy="$(ui_query_exact "$layout" text '允许')"; then
    ui_tap "$xy"
    sleep 1
  fi
}
