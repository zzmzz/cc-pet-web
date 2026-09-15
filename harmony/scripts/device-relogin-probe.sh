#!/usr/bin/env bash
# device-relogin-probe.sh — assert that logging back in after a 401 logout
# actually reconnects, and that nothing from the previous account survives.
#
# The bug this exists for: `Index.gatewayStarted` latched `true` on the first
# connect and was never reset. `Index` is the `@Entry` struct — loaded once in
# EntryAbility.onWindowStageCreate and NOT remounted when `auth.authorized`
# flips, because LoginGate is only a branch inside its own build(). So after a
# 401 logged the user out (which calls ConnectionGateway.stop(), closing the
# socket), logging back in re-rendered the whole chat screen while
# startGatewayOnce() returned early — a complete, responsive-looking UI over a
# permanently dead socket. Only killing the process recovered. The second half
# of the same fix: stop() now also clears the Outbox and ChatStore, so account
# A's queued messages can't flush onto account B's socket and A's transcript
# can't be sitting there when B logs in.
#
# Reasoning about this is exactly what let it ship, so this probe watches it
# happen instead: real login, real round trip, real 401, real re-login, real
# second round trip.
#
# Targets the emulator (127.0.0.1:5555) by default; override with
# CCPET_DEVICE_TARGET. Never touches the operator's real server or token — it
# clears the target's app data and runs against a throwaway fixture stack it
# starts and tears down itself.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-relogin-probe"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-relogin-probe.XXXXXX")"
LAYOUT="$WORKDIR/layout.json"
REJECTOR_PID=""

# A throwaway stand-in server for the same port the fixture server just
# vacated: it completes the WebSocket handshake and sends one
# `bridge:manifest`, then answers EVERY HTTP request with 401.
#
# That combination drives the app down its primary 401 path exactly as a
# real expired token would: the gateway reconnects (backoff), gets a
# manifest, and `HistoryBackfill` fires `GET /api/history/:chatKey` off the
# back of it -> 401 -> `AuthStore.clear()` + `ConnectionGateway.stop()` ->
# LoginGate. No UI driving is involved, so the probe does not depend on
# uitest being able to operate the slash palette.
#
# Why not just rotate the token on the real server: its auth guard locks an
# IP out for 5 minutes after 5 failures in 60s, and the reconnecting socket
# would burn that budget by itself, turning the re-login half of this probe
# into a flaky lockout.
start_rejector() {
  local port="$1"
  cat > "$WORKDIR/reject-401.cjs" <<'NODE'
const http = require('node:http');
const { WebSocketServer } = require('ws');
const port = Number(process.argv[2]);
const server = http.createServer((req, res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
});
// Flat frames, matching the real hub: JSON.stringify({ type, ...payload }).
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  console.log('[reject-401] ws connected, sending manifest');
  ws.send(JSON.stringify({
    type: 'bridge:manifest',
    bridges: [{ id: 'probe-bridge', name: 'ProbeBridge' }],
  }));
});
server.listen(port, '127.0.0.1', () => console.log('[reject-401] listening on', port));
NODE
  ( exec env NODE_PATH="$REPO_ROOT/packages/server/node_modules" node "$WORKDIR/reject-401.cjs" "$port" ) \
    > "$WORKDIR/reject.log" 2>&1 &
  REJECTOR_PID=$!
  if ! wait_until 15 1 nc -z 127.0.0.1 "$port"; then
    fail "throwaway 401 server never opened tcp:$port within 15s -- see $WORKDIR/reject.log"
  fi
}

stop_rejector() {
  if [[ -n "$REJECTOR_PID" ]]; then
    kill "$REJECTOR_PID" 2>/dev/null || true
    REJECTOR_PID=""
    # The real fixture server needs this port back; don't race it.
    wait_until 10 1 bash -c "! nc -z 127.0.0.1 $1" || true
  fi
}

# Brings the real fixture server back on a SECOND, EMPTY data directory,
# same config and same token but no message database.
#
# This is what makes step 4's assertion mean anything. Restarting on the
# original data dir proves nothing: the first message really is in the
# server's sqlite, so the history backfill correctly pulls it back after the
# re-login and it is on screen for an entirely legitimate reason (observed
# on the first run of this probe). With an empty server-side history, the
# only way the previous session's text can still be on screen is that
# `ConnectionGateway.stop()` left it in `ChatStore`.
restart_fixture_server_on_fresh_data() {
  mkdir -p "$FIXTURE_DIR/data2"
  cp "$FIXTURE_DIR/data/cc-pet.config.json" "$FIXTURE_DIR/data2/cc-pet.config.json"
  (
    cd "$REPO_ROOT/packages/server"
    exec env CC_PET_DATA_DIR="$FIXTURE_DIR/data2" CC_PET_PORT="$FIXTURE_SERVER_PORT" \
      node --import tsx src/index.ts
  ) >> "$FIXTURE_DIR/server.log" 2>&1 &
  echo $! > "$FIXTURE_DIR/server.pid"
  if ! wait_until 30 1 nc -z 127.0.0.1 "$FIXTURE_SERVER_PORT"; then
    fail "fixture server never reopened tcp:$FIXTURE_SERVER_PORT on the fresh data dir -- see $FIXTURE_DIR/server.log"
  fi
}

cleanup() {
  local ec=$?
  if [[ -n "$REJECTOR_PID" ]]; then
    kill "$REJECTOR_PID" 2>/dev/null || true
  fi
  stop_fixture_stack
  rm -rf "$WORKDIR"
  exit "$ec"
}
trap cleanup EXIT

require_hdc_and_target
ensure_screen_awake_and_unlocked "$LAYOUT"

SERVER_PORT="${CCPET_PROBE_SERVER_PORT:-19331}"
BRIDGE_PORT="${CCPET_PROBE_BRIDGE_PORT:-19332}"
FIRST_MESSAGE="relogin-first-$$-$RANDOM"
SECOND_MESSAGE="relogin-second-$$-$RANDOM"
FIRST_REPLY="probe-echo: $FIRST_MESSAGE"
SECOND_REPLY="probe-echo: $SECOND_MESSAGE"

start_fixture_stack "$SERVER_PORT" "$BRIDGE_PORT" 150
ensure_rport "$SERVER_PORT"

reset_app_state
launch_app
perform_login "http://127.0.0.1:$SERVER_PORT" "$FIXTURE_TOKEN" "$LAYOUT"
grant_notification_permission_if_present "$LAYOUT"

send_and_expect() {
  local text="$1" expected="$2" label="$3"
  dump_layout "$LAYOUT"
  local xy
  xy="$(ui_query "$LAYOUT" hint '输入消息')" || fail "[$label] MessageInput text field not found"
  ui_tap "$xy"
  ui_type_at "$xy" "$text"

  dump_layout "$LAYOUT"
  local send_xy
  send_xy="$(ui_query "$LAYOUT" text '发送')" || fail "[$label] 发送 button not found after typing"
  ui_tap "$send_xy"
  hdc_ shell uitest uiInput keyEvent Back >/dev/null || true

  round_trip_visible() {
    dump_layout_soft "$LAYOUT" || return 1
    ui_contains "$LAYOUT" "$expected"
  }
  if ! wait_until 20 1 round_trip_visible; then
    fail "[$label] sent '$text' but the reply '$expected' never appeared within 20s -- layout at $LAYOUT"
  fi
}

# --- 1. The connection works before any of this ---------------------------
send_and_expect "$FIRST_MESSAGE" "$FIRST_REPLY" "before-401"
echo "OK: first round trip completed ('$FIRST_REPLY' is in the transcript)"

# --- 2. Force a real 401 through a real REST call --------------------------
kill_fixture_server
start_rejector "$SERVER_PORT"

# Nothing to drive: killing the server above already forced the gateway into
# backoff, and the stand-in now answers its reconnect with a manifest the
# app must react to by fetching history -- which 401s. Worst-case wait is
# the backoff ceiling plus the round trip.

at_login_gate() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_query "$LAYOUT" hint 'Token' >/dev/null 2>&1
}
if ! wait_until 60 2 at_login_gate; then
  fail "a 401 did not land the app back on the login gate within 60s -- layout at $LAYOUT," \
       " stand-in server log at $WORKDIR/reject.log"
fi
echo "OK: the 401 logged the app out (login gate is showing)"

# --- 3. Log back in against the real server --------------------------------
stop_rejector "$SERVER_PORT"
restart_fixture_server_on_fresh_data
ensure_rport "$SERVER_PORT"

perform_login "http://127.0.0.1:$SERVER_PORT" "$FIXTURE_TOKEN" "$LAYOUT"
grant_notification_permission_if_present "$LAYOUT"

# --- 4. The previous session's transcript must be gone ---------------------
# The server behind this login has an empty history (fresh data dir), so a
# correct client shows an empty transcript here.
dump_layout "$LAYOUT"
if ui_contains "$LAYOUT" "$FIRST_REPLY"; then
  fail "after logging back in, the PREVIOUS session's message '$FIRST_REPLY' is still on screen" \
       " -- ConnectionGateway.stop() is not clearing ChatStore"
fi
echo "OK: the previous session's transcript did not survive the logout"

# --- 5. And the socket actually restarted ----------------------------------
# This is the whole point: it can only pass if start() ran a second time,
# i.e. if gatewayStarted was un-latched when authorized went false.
send_and_expect "$SECOND_MESSAGE" "$SECOND_REPLY" "after-relogin"

# Screenshot of the second, working session -- handy when debugging a
# failure by hand. Defaults into the probe's own temp dir (removed by the
# EXIT trap) rather than the repo: set CCPET_PROBE_SCREENSHOT to keep it.
# `snapshot_display`, not `snapshot` -- see harmony/README.md.
hdc_ shell snapshot_display -f /data/local/tmp/relogin-probe.jpeg >/dev/null 2>&1 || true
"$HDC_BIN" -t "$CCPET_DEVICE_TARGET" file recv /data/local/tmp/relogin-probe.jpeg \
  "${CCPET_PROBE_SCREENSHOT:-$WORKDIR/relogin-probe.jpeg}" >/dev/null 2>&1 || true

pass "401 -> login gate -> re-login -> a second message round-tripped ('$SECOND_REPLY'), and the" \
     " first session's transcript was gone; the WebSocket really restarted"
