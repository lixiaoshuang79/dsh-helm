#!/bin/bash
# live-safety-check.sh — READ-ONLY assertion that the live ChatGPT↔DSH chain
# is untouched by any test/validation work.
#
# Checks (no recovery actions, ever):
#   1. ports 3080 (dsh web) / 3457 (helm daemon) / 3458 (tunnel) are still
#      bound by the SAME PIDs as the baseline snapshot (.tmp/live-baseline.txt)
#   2. 3080 and 3457 still answer HTTP 200
#   3. launchd watchdog/keepalive jobs are still loaded with the same PIDs
#
# Exit 0 = live chain intact. Exit 1 = something changed (report only).

set -u
cd "$(dirname "$0")/.."
BASELINE=".tmp/live-baseline.txt"
FAIL=0

check_port() {
  local port="$1" expect_pid="$2" name="$3"
  local now
  now=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u | head -1)
  if [ -z "$now" ]; then
    echo "[live-safety] FAIL: port $port ($name) not listening"
    FAIL=1
  elif [ "$now" != "$expect_pid" ]; then
    echo "[live-safety] FAIL: port $port ($name) pid changed: $expect_pid -> $now"
    FAIL=1
  else
    echo "[live-safety] ok: port $port ($name) pid $now unchanged"
  fi
}

check_port_pid_launchd() {
  local expect="$1" name="$2"
  local label
  if [ "$name" = "watchdog" ]; then label="com.dsh-connector.dsh-web-watchdog"; else label="com.dsh-connector.tunnel-client-keepalive"; fi
  local pid
  pid=$(launchctl list "$label" 2>/dev/null | awk -F'"' '/"PID"/{print $3}' | grep -oE '[0-9]+' | head -1)
  if [ "$pid" = "$expect" ]; then
    echo "[live-safety] ok: launchd $name pid $pid unchanged"
  else
    echo "[live-safety] FAIL: launchd $name pid changed: $expect -> ${pid:-gone}"
    FAIL=1
  fi
}

check_http() {
  local port="$1" path="$2" name="$3"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${port}${path}")
  if [ "$code" = "200" ]; then
    echo "[live-safety] ok: $name http 200"
  else
    echo "[live-safety] WARN: $name http code $code (not 200)"
    # 3458 tunnel may 404 at root; treat non-connection as OK if port alive
    if [ "$port" = "3458" ]; then
      echo "[live-safety]   (3458 is a forwarder; 404 at root normal, connection alive matters)"
    else
      FAIL=1
    fi
  fi
}

if [ ! -f "$BASELINE" ]; then
  echo "[live-safety] no baseline file at $BASELINE — run snapshot first"
  exit 2
fi

# read baseline
while read -r pname pid; do
  case "$pname" in
    3080) check_port 3080 "$pid" "dsh web" ;;
    3457) check_port 3457 "$pid" "helm daemon" ;;
    3458) check_port 3458 "$pid" "tunnel" ;;
    watchdog) check_port_pid_launchd "$pid" "watchdog" ;;
    keepalive) check_port_pid_launchd "$pid" "keepalive" ;;
    *) echo "[live-safety] skip unknown baseline entry: $pname $pid" ;;
  esac
done < "$BASELINE"

check_http 3080 / "dsh web"
check_http 3457 /healthz "helm daemon"
check_http 3458 / "tunnel"

if [ "$FAIL" = "0" ]; then
  echo "[live-safety] PASS: live chain intact"
else
  echo "[live-safety] CHECK FAILED (report only — no recovery performed)"
fi
exit "$FAIL"