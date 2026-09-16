#!/usr/bin/env bash
# device-paint-repro.sh — measures ArkWeb's dropped-background-fill defect.
#
# WHAT THIS MEASURES
# ------------------
# On the emulator, some boxes inside a tall scrolling layer render their text
# (and their outline, if they have one) while their `background-color` fill is
# simply not painted. On packages/web's chat that reads as a user bubble losing
# its indigo and leaving white-on-near-white text.
#
# It is NOT a packages/web bug, and this script is the evidence:
#   * the page it loads (arkweb-paint-repro/index.html) is ~60 lines of plain
#     HTML with no framework, no Tailwind and none of the product's CSS;
#   * `getComputedStyle().backgroundColor` reads back correctly on the bubbles
#     that do not paint, so style resolution is fine and rasterization is not;
#   * the same declaration paints on one row and not on the row above it, so no
#     property choice (colour, colour notation, border-radius, overflow,
#     alignment, width) explains which bubbles are hit;
#   * the failures are anchored to CONTENT coordinates — scroll and the same
#     bubbles stay wrong at every screen position — so this is neither a
#     screen-tile artifact nor an `hdc snapshot_display` capture artifact;
#   * it is deterministic: force-stop and relaunch reproduces the same set.
#
# It needs a tall scroller AND heterogeneous paint properties. 140 identical
# bubbles lose nothing (0 of 74 measured), 140 identical bubbles at randomised
# widths lose nothing (0 of 107), and a short non-scrolling page loses nothing.
# The interleaved-variant page here loses roughly 7% (10 of 143 measured).
#
# WHY IT IS PROBABLY EMULATOR-ONLY, AND HOW TO SETTLE THAT
# --------------------------------------------------------
# The header this page prints reports `webgl=null` on the emulator: ArkWeb has
# no GPU context there at all, so both raster and compositing run on a software
# backend on 4 cores. Real HarmonyOS hardware gives ArkWeb a GPU path.
#
# To settle it, run this exact script against a physical device. It prints
# `RESULT: <missing> of <total>`. Zero on hardware means the defect is an
# emulator rendering artifact and nothing in packages/web needs to change.
# Non-zero on hardware means it is a real ArkWeb defect, and the first thing to
# try is shrinking the scrolling layer (virtualising the transcript) — not a
# per-property CSS tweak, because no property predicts which bubbles are hit.
#
# Exits 0 either way: this is a measurement, not a pass/fail gate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="device-paint-repro"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

PORT="${CCPET_REPRO_PORT:-19451}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ccpet-paint-repro.XXXXXX")"
LAYOUT="$WORKDIR/layout.json"
OUTDIR="${CCPET_REPRO_OUTDIR:-$WORKDIR}"
SERVER_PID=""

cleanup() {
  local ec=$?
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORKDIR"
  exit "$ec"
}
trap cleanup EXIT

command -v python3 >/dev/null 2>&1 || fail "python3 is required (it serves the page and counts the pixels)"
python3 -c 'import PIL, numpy' 2>/dev/null || fail "python3 needs Pillow and numpy to count the missing fills"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "tcp:$PORT is already in use; set CCPET_REPRO_PORT or free it"
fi

require_hdc_and_target
ensure_screen_awake_and_unlocked "$LAYOUT"

( cd "$SCRIPT_DIR/arkweb-paint-repro" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 ) \
  > "$WORKDIR/http.log" 2>&1 &
SERVER_PID=$!
if ! wait_until 15 1 curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then
  fail "the local repro server never came up on tcp:$PORT"
fi

hdc_ rport "tcp:$PORT" "tcp:$PORT" >/dev/null 2>&1 || true
if ! "$HDC_BIN" fport ls 2>/dev/null | grep -q "tcp:$PORT tcp:$PORT"; then
  fail "could not establish hdc rport tcp:$PORT <-> tcp:$PORT"
fi

reset_app_state
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
ui_type_at "$xy" "http://127.0.0.1:$PORT"
hdc_ shell uitest uiInput keyEvent Back >/dev/null
dump_layout "$LAYOUT"
xy="$(ui_query_exact "$LAYOUT" text '连接')" || fail "连接 button not found on the server-address screen"
ui_tap "$xy"

page_rendered() {
  dump_layout_soft "$LAYOUT" || return 1
  ui_contains "$LAYOUT" 'P0'
}
if ! wait_until 30 1 page_rendered; then
  fail "the repro page never rendered inside the WebView"
fi

snap() {
  hdc_ shell snapshot_display -f /data/local/tmp/ccpet-paint-repro.jpeg >/dev/null 2>&1
  "$HDC_BIN" -t "$CCPET_DEVICE_TARGET" file recv /data/local/tmp/ccpet-paint-repro.jpeg "$OUTDIR/$1" >/dev/null 2>&1
}
snap paint-repro-0.jpeg
for i in 1 2 3 4 5 6 7; do
  hdc_ shell uitest uiInput swipe 628 2450 628 750 700 >/dev/null
  sleep 2
  snap "paint-repro-$i.jpeg"
done

python3 - "$OUTDIR" <<'PYCOUNT'
import sys
from PIL import Image
import numpy as np

# Each bubble is one horizontal run of scanlines. A run that carries content
# (anything darker/lighter than the page background) but no indigo fill is a
# bubble that lost its background.
outdir = sys.argv[1]
BG = np.array([248, 250, 252])
FILL = np.array([99, 102, 241])

def run_count(mask):
    n, prev = 0, False
    for v in mask:
        if v and not prev:
            n += 1
        prev = v
    return n

total = missing = 0
for i in range(8):
    im = np.asarray(Image.open(f'{outdir}/paint-repro-{i}.jpeg').convert('RGB')).astype(int)
    region = im[520:2640]                      # between the status bar and the gesture bar
    filled = (np.abs(region - FILL).sum(axis=2) < 90).sum(axis=1)
    content = (np.abs(region - BG).sum(axis=2) > 28).sum(axis=1)
    f, c = run_count(filled > 150), run_count(content > 40)
    total += c
    missing += max(0, c - f)
    print(f'  screen {i}: {c} bubbles, {max(0, c - f)} with no background fill')

print(f'RESULT: {missing} of {total} bubble backgrounds missing')
print('RESULT: 0 would mean this device does not have the defect.')
PYCOUNT

echo "PASS: [$PROBE_NAME] measurement complete (screenshots: $OUTDIR)"
