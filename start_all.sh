#!/usr/bin/env bash
#
# Start all SE Copilot agents and the orchestrator.
# Usage:  ./start_all.sh          — start everything
#         ./start_all.sh stop     — kill all running agents
#
# Each service runs in the background. Logs go to logs/<name>.log.
# A PID file is written to logs/<name>.pid for clean shutdown.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS_DIR="$ROOT/logs"
mkdir -p "$LOGS_DIR"

# Service definitions: name | directory | venv path | command args (after python)
# se_copilot: main FastAPI app — includes Support Admin Copilot routes at /api/sac/*
#   (same process; no separate SAC server). Default port from se-copilot/config (5070).
SERVICES=(
  "librarian|agents/rag|agents/rag/.venv|web.py --agent librarian"
  "value|agents/rag|agents/rag/.venv|web.py --agent value"
  "case_studies|agents/rag|agents/rag/.venv|web.py --agent case_studies"
  "sec_edgar|agents/rag|agents/rag/.venv|web.py --agent sec_edgar"
  "buyer_persona|agents/rag|agents/rag/.venv|web.py --agent buyer_persona"
  "slides|agents/slides|agents/slides/.venv|main.py"
  "company_research|agents/company_research|agents/company_research/.venv|main.py"
  "se_copilot|se-copilot|se-copilot/.venv|main.py"
)

stop_all() {
  echo "Stopping all agents..."
  for entry in "${SERVICES[@]}"; do
    IFS='|' read -r name _ _ _ <<< "$entry"
    pidfile="$LOGS_DIR/$name.pid"
    if [[ -f "$pidfile" ]]; then
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        echo "  Stopping $name (PID $pid)"
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$pidfile"
    fi
  done
  echo "Done."
}

start_all() {
  echo "Starting all SE Copilot agents..."
  echo ""

  for entry in "${SERVICES[@]}"; do
    IFS='|' read -r name dir venv cmd_args <<< "$entry"
    pidfile="$LOGS_DIR/$name.pid"
    logfile="$LOGS_DIR/$name.log"

    # Skip if already running
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo "  $name — already running (PID $(cat "$pidfile"))"
      continue
    fi

    abs_dir="$ROOT/$dir"
    abs_python="$ROOT/$venv/bin/python"

    # Check venv exists
    if [[ ! -x "$abs_python" ]]; then
      echo "  $name — SKIPPED (no python at $ROOT/$venv)"
      continue
    fi

    # Start the service in its own directory
    (cd "$abs_dir" && exec "$abs_python" $cmd_args >> "$logfile" 2>&1) &
    pid=$!
    echo "$pid" > "$pidfile"
    echo "  $name — started (PID $pid, log: logs/$name.log)"
  done

  echo ""
  echo "All agents launched. Use './start_all.sh stop' to shut them down."
  echo "Tail all logs:  tail -f $LOGS_DIR/*.log"
  echo ""
  echo "Support Admin Copilot (Chrome extension backend): same process as se_copilot —"
  echo "  http://localhost:<PORT>/api/sac/*  (PORT defaults to 5070; see se-copilot/.env or config)"
}

case "${1:-start}" in
  stop)  stop_all ;;
  start) stop_all 2>/dev/null; start_all ;;
  *)     echo "Usage: $0 [start|stop]"; exit 1 ;;
esac
