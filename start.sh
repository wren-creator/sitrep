#!/usr/bin/env bash
# Start sitrep in the background. Log: data/server.log, PID: data/server.pid
set -euo pipefail
cd "$(dirname "$0")"
PORT="${SITREP_PORT:-8765}"

if [ -f data/server.pid ] && kill -0 "$(cat data/server.pid)" 2>/dev/null; then
  echo "Already running (pid $(cat data/server.pid)) at http://localhost:$PORT"
  exit 0
fi

if [ ! -x .venv/bin/uvicorn ]; then
  echo "Setting up venv..."
  python3 -m venv .venv
  .venv/bin/pip install -q -r backend/requirements.txt
fi

mkdir -p data
cd backend
nohup ../.venv/bin/uvicorn main:app --port "$PORT" > ../data/server.log 2>&1 &
echo $! > ../data/server.pid
cd ..

for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:$PORT/"; then
    echo "Sitrep running at http://localhost:$PORT (pid $(cat data/server.pid))"
    exit 0
  fi
  sleep 0.5
done
echo "Started but not answering yet, check data/server.log"
