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
  # Prose rots quietly too: every number README/DESIGN print is re-derived here — from the data
  # rows, from the same tools re-run, or from the code. Logic-only, so CI and a laptop run the
  # identical command, and a red doc stops a browser run just like a red test does.
  echo "=== doctest ==="
  node tools/doctest.mjs >/tmp/hitori-doctest.log 2>&1 || FAILED=1
  grep -E '^  FAIL|^合计 |^rows: ' /tmp/hitori-doctest.log | tail -20
  # 文档对完表还得证明这道闸真的会咬：把 README 台账里的每一把刀逐把下回原处，要求那道纯逻辑闸
  # 点名变红，并把真读到的退出码盖回 README 那一列。它第一步要求干净树——手里还有未提交的改动时
  # 「绿」不知道是谁撑的，于是它 rc 2 拒跑，这是正确行为而不是坏了，日志里看得见。
  # 日志写在仓外的工作区根，不进仓、不进 /tmp：这一趟会改 README（盖戳），日志不能把树弄脏。
  echo "=== sabotage ledger ==="
  SABLOG="$HERE/../_tmp-hitori-sabotage.log"
  node tools/sabotage.mjs >"$SABLOG" 2>&1
  SAB_RC=$?
  printf 'RC=%s\n' "$SAB_RC" >>"$SABLOG"
  grep -E '^红 ✓|^  未过|^合计 |^rows: |^RC=|^台账停住了' "$SABLOG" | tail -20
  # rc 与刀数都从日志里读回来，不拿管道的退出码当闸的退出码（`cmd | tail` 报的是 tail 的）。
  LOG_RC=$(grep '^RC=' "$SABLOG" | tail -1 | sed 's/^RC=//')
  SAB_ROWS=$(grep '^rows: ' "$SABLOG" | tail -1 | awk '{print $2}')
  SAB_FAIL=$(grep '^rows: ' "$SABLOG" | tail -1 | awk '{print $4}')
  KNIVES=$(grep -cE '^\| K[0-9]+ \| ' README.md)
  echo "ledger rc=${SAB_RC}（读回 ${LOG_RC}）· 台账 $SAB_ROWS 把 / README $KNIVES 行 · fail=$SAB_FAIL"
  if [ "$LOG_RC" != "$SAB_RC" ]; then
    echo "sabotage 的退出码读不回来：shell 说 ${SAB_RC}，日志说 $LOG_RC" >&2; FAILED=1;
  fi
  if [ "$SAB_RC" -ne 0 ] || [ "$SAB_FAIL" != "0" ] || [ "$SAB_ROWS" != "$KNIVES" ] || [ "$SAB_ROWS" -lt 8 ]; then
    echo "=== 破坏试验台账没过（rc=$SAB_RC · 刀数 日志 $SAB_ROWS vs README $KNIVES · fail ${SAB_FAIL}）===" >&2
    FAILED=1;
  fi
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
# Ports are this project's own only if nothing is already sitting on them. A headless Chrome leaked
# by another run answers on :9365 in milliseconds, and the wait loop below would then be satisfied
# by *that* browser: the gate would drive someone else's Chrome, with someone else's profile, and
# print a verdict for it. A port we did not launch is refused here rather than trusted.
# The DevTools check is unconditional: this script always launches its own Chrome, including in
# BASE_URL mode, so a browser already answering on the port is someone else's in every form.
curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && {
  echo ":$CDP_PORT is already answering DevTools — that is not this run's Chrome." >&2
  echo "  find the owner with: lsof -nP -iTCP:$CDP_PORT -sTCP:LISTEN" >&2
  echo "  or run this gate on a free port: CDP_PORT=93xx bash tools/verify.sh" >&2
  exit 2; }
if [ "$LOCAL" = 1 ]; then
  # But BASE_URL mode exists precisely to test a server this script did not start.
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && {
    echo ":$WEB_PORT is already serving $BASE — this run did not start that server." >&2
    echo "  find the owner with: lsof -nP -iTCP:$WEB_PORT -sTCP:LISTEN" >&2
    exit 2; }
fi
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
#
# The server is a background child, so the first curl can easily lose the race with `listen()` —
# and losing it used to print "nothing served" while the log still held the *previous* run's
# banner, which sent everyone hunting for a phantom port conflict. Wait on our own child instead
# of guessing, then read the bytes once for real.
if [ "$LOCAL" = 1 ]; then
  for i in $(seq 1 40); do
    curl -fsS -m 2 "$BASE" >/dev/null 2>&1 && break
    kill -0 $SPID 2>/dev/null || break
    sleep 0.25
  done
fi
SERVED=$(curl -fsS -m 5 "$BASE" 2>/dev/null || true)
case "$SERVED" in
  *js/main.js*) ;;
  *)
    echo "nothing served at $BASE" >&2
    if [ "$LOCAL" = 1 ]; then
      echo "--- what this run's server wrote (its own file, not a previous run's):" >&2
      sed 's/^/  /' /tmp/hitori-server.log >&2
      echo "--- listeners on :$WEB_PORT:" >&2
      lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | tail -3 >&2
    fi
    exit 4 ;;
esac
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
SEEN=""
# README 的场景表是契约：一个场景悄悄少了一条断言，它仍然可以「通过」。所以每个场景实测的
# `rows:` 都要与这张表逐格对上；`SCENARIOS=` 收窄时只比跑过的那几格，但至少比一格，九格全跑时
# 必须比满九格。数字写在这里一份、写在文档一份，是由 doctest 的 D5e 逐格对出来的。
EXPECTS='boot=24 taps=20 rules=25 logic=16 routes=23 save=23 reloaded=17 motion=11 pointer=37'
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
  SEEN="$SEEN $s=${N:-none}"
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

# --------------------------------------------------------------------------- measured vs documented
# 每个场景实测的 `rows:` 与 README 那张表逐格对上。掉了条数而场景仍然「通过」，是这个仓最容易
# 漏的一种红——所以这里比的是**格子数**（本轮请求了几个场景就必须比几格）而不只是比总值。
DESIRED_N=$(printf '%s\n' ${SCENARIOS:-boot taps rules logic routes save reloaded motion pointer} | wc -w | tr -d ' ')
WANT_TOTAL=0
for kv in $EXPECTS; do WANT_TOTAL=$((WANT_TOTAL + ${kv#*=})); done
CELLS=0
DRIFT=""
for kv in $EXPECTS; do
  k=${kv%%=*}
  want=${kv#*=}
  got=""
  for s in $SEEN; do case "$s" in "$k="*) got=${s#*=} ;; esac; done
  [ -z "$got" ] && continue          # SCENARIOS= 收窄时，没跑的那几格不比
  CELLS=$((CELLS + 1))
  if [ "$got" = "none" ]; then
    DRIFT="$DRIFT $k:没报条数"
  elif [ "$got" != "$want" ]; then
    DRIFT="$DRIFT $k:实测${got}≠表${want}"
  fi
done
COMPARED=$CELLS
if [ "$CELLS" -lt 1 ]; then echo "  COUNT TABLE NOT EXERCISED：一格都没比上" >&2; FAILED=1; fi
if [ "$CELLS" -ne "$DESIRED_N" ]; then echo "  只比了 $CELLS 格，本轮请求了 $DESIRED_N 个场景" >&2; FAILED=1; fi
if [ -n "$DRIFT" ]; then echo "  COUNT DRIFT:$DRIFT" >&2; FAILED=1; fi
if [ "$CELLS" -eq "$DESIRED_N" ] && [ "$TOTAL" -ne "$WANT_TOTAL" ]; then
  echo "  合计 $TOTAL 条，与表里的 $WANT_TOTAL 条不符" >&2; FAILED=1
fi
echo "=== count table: $COMPARED/$DESIRED_N 格逐格对上（实测合计 $TOTAL / 表中合计 ${WANT_TOTAL}）==="

[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
