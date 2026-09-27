#!/usr/bin/env bash
# One command, one verdict: the node suites first, and only once they are green, one real headless
# Chrome driven over CDP against one real server. Everything this script starts is gone when it
# exits — including the Chrome, which it then proves by looking.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterization saturates every core and, with no CDP client attached, Chrome will not exit on its
# own. This game is a 2D canvas, so plain headless Chrome is enough.
#
#   bash tools/verify.sh                       # node suites + @boot @taps @rules @logic @routes
                                              # @save @reloaded @motion @pointer
#   SCENARIOS="pointer" bash tools/verify.sh   # one browser suite while editing the view
#   SKIP_UNIT=1 SCENARIOS="boot" bash tools/verify.sh   # browser only (what a CI browser job does)
#   BASE_URL=https://…/ bash tools/verify.sh   # the same assertions against the deployed artifact
#
# Ports are this project's own: HTTP 5256 / CDP 9365. Two headless Chromes on one port is how a
# run gets reported green while something else was actually being driven.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
CDP_PORT=${CDP_PORT:-9365}
WEB_PORT=${WEB_PORT:-5256}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
BRIDGE=window.hitori

CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
if ! command -v "$CHROME" >/dev/null 2>&1 && [ ! -x "$CHROME" ]; then
  echo "no Chrome found; set CHROME_BIN" >&2; exit 2;
fi

FAILED=0
LOCAL=0
case "$BASE" in "http://127.0.0.1:$WEB_PORT/"*) LOCAL=1 ;; esac

# --------------------------------------------------------------------------- node suites first
# A browser run on top of a broken engine proves nothing, and headless Chrome costs cores, so the
# engine has to be green before anything is launched.
if [ -z "${SKIP_UNIT:-}" ] && [ "$LOCAL" = 1 ]; then
  echo "=== node suites ==="
  for f in test/*.test.mjs; do
    echo "--- $f"
    node "$f" >/tmp/hitori-unit.log 2>&1 || { cat /tmp/hitori-unit.log | tail -20; FAILED=1; }
  done
  # The pool is content, and content rots quietly: every claim the README makes about
  # js/data/lots.js is re-derived from the rows here, before a browser is asked to agree with them.
  echo "--- js/data/lots.js"
  node tools/audit-lots.mjs >/tmp/hitori-audit.log 2>&1 || { tail -20 /tmp/hitori-audit.log; FAILED=1; }
  tail -2 /tmp/hitori-audit.log
  if [ $FAILED -ne 0 ]; then
    echo "=== node suites failed; browser not started ===" >&2
    exit $FAILED
  fi
fi

# --------------------------------------------------------------- scenario bodies parse as JS
# A scenario body is a string, and the only thing that parses it is the browser. One stray
# backtick in one of its comments therefore used to arrive as `rows: 1, fail: ["@boot threw"]`
# after a Chrome launch — so parse all seven here, with node, before anything is paid for.
# Unconditional on purpose: it costs milliseconds, and SKIP_UNIT runs are exactly while editing.
echo "=== scenario bodies ==="
node tools/playtest.mjs selftest >/tmp/hitori-selftest.log 2>&1 || {
  tail -5 /tmp/hitori-selftest.log
  echo "=== a scenario body does not parse; browser not started ===" >&2
  exit 1
}
tail -1 /tmp/hitori-selftest.log

# --------------------------------------------------------------------------- one server, one browser
SPID=0
CPID=0
UDD=""
if [ "$LOCAL" = 1 ]; then
  node "$HERE/server.cjs" "$WEB_PORT" >/tmp/hitori-server.log 2>&1 &
  SPID=$!
fi
UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=900,860 --no-first-run --no-default-browser-check about:blank >/tmp/hitori-chrome.log 2>&1 &
CPID=$!
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  kill -9 $CPID 2>/dev/null
  [ -n "$UDD" ] && rm -rf "$UDD"
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and inside a
# pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile, so wait on the
# endpoints rather than guessing a sleep duration.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT (see /tmp/hitori-chrome.log)" >&2; exit 3; }

# Pre-flight: prove the bytes about to be tested are this app's, not some sibling's index.html
# served on the same port.
SERVED=$(curl -fsS -m 5 "$BASE" 2>/dev/null || true)
case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see /tmp/hitori-server.log)" >&2; exit 4; ;; esac
printf '%s' "$SERVED" | grep -qi hitori || {
  echo "$BASE is serving a different app, not 抽刀断水/hitori" >&2; exit 4; }

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# js/data/lots.js is a baked pool and the shell resolves a route before it reports a state, so
# wait on the bridge rather than on a timer.
BOOT=""
for i in $(seq 1 60); do
  # `head -1` because the driver prints the evaluated value first and its machine-readable RESULT
  # line last: reading the whole stream would glue the two together into a string that equals
  # neither 'ready' nor 'nope'.
  BOOT=$(node tools/playtest.mjs eval "$BRIDGE&&$BRIDGE.version===1&&$BRIDGE.engine?'ready':'nope'" nonav 2>/dev/null | head -1 | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
[ "$BOOT" = "ready" ] || { echo "$BRIDGE never appeared at $BASE" >&2; exit 5; }
echo "boot: hitori ready at $BASE"

TOTAL=0
# @reloaded has to run after @save (it reads what @save left on disk), and it runs *without*
# `nonav`: each scenario is its own driver process, and re-navigating is what makes "a fresh page
# reads its progress off disk" an actual fresh page instead of the same document.
for s in ${SCENARIOS:-boot taps rules logic routes save reloaded motion pointer}; do
  echo "=== @$s ==="
  if [ "$s" = "reloaded" ]; then
    OUT=$(node tools/playtest.mjs eval "@$s" 2>&1)
  else
    OUT=$(node tools/playtest.mjs eval "@$s" nonav 2>&1)
  fi
  # The contract is on the driver's last stdout line: `RESULT <json>`. Anything that failed to
  # produce it did not run, and "did not run" must never read as green.
  SUM=$(printf '%s\n' "$OUT" | python3 -c '
import sys, json
raw = sys.stdin.read()
line = [l for l in raw.splitlines() if l.startswith("RESULT ")]
if not line:
    print("NO RESULT — the scenario never reported (last 300 chars):", raw[-300:]); sys.exit(1)
d = json.loads(line[-1][7:])
rows = d.get("detail") or []
n = d.get("rows", len(rows))
print("rows:", n, "fail:", json.dumps(d.get("fail", []), ensure_ascii=False))
for r in rows:
    if not r.get("pass"): print("  FAIL", r.get("test"), json.dumps(r.get("detail"), ensure_ascii=False)[:240])
sys.exit(0 if (d.get("pass") and n > 0) else 1)
')
  printf '%s\n' "$SUM"
  case "$SUM" in
    *"fail: []"*) ;;
    *) FAILED=1 ;;
  esac
  N=$(printf '%s' "$SUM" | awk '{ for (i = 1; i < NF; i++) if ($i == "rows:") print $(i + 1) }' | tr -d '\n')
  TOTAL=$((TOTAL + ${N:-0}))
  # A clean console is part of the contract: a thrown page error, a refused resource or a rendering
  # warning all count, even when every assertion above happened to pass.
  if printf '%s' "$OUT" | grep -qE '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]'; then
    echo "  CONSOLE NOT CLEAN for @$s"
    printf '%s\n' "$OUT" | grep -E '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]' | head -5
    FAILED=1
  fi
  node tools/playtest.mjs shot "/tmp/hitori-$s.png" >/dev/null 2>&1
done
echo "=== browser assertions: $TOTAL ==="

echo "=== console ==="
node tools/playtest.mjs logs

# This script owns exactly one Chrome, so it says so out loud when it cannot prove it left.
kill $WD 2>/dev/null
wait $WD 2>/dev/null
[ "$SPID" != 0 ] && kill $SPID 2>/dev/null
kill $CPID 2>/dev/null
for i in $(seq 1 20); do
  pgrep -f "user-data-dir=$UDD" >/dev/null || break
  sleep 0.25
done
if pgrep -f "user-data-dir=$UDD" >/dev/null 2>&1; then
  echo "chrome did not exit" >&2; FAILED=1
else
  echo "=== chrome exited, temp profile gone ==="
fi
rm -rf "$UDD"
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
