#!/usr/bin/env bash
# Stop the sitrep server started by start.sh
cd "$(dirname "$0")"

if [ -f data/server.pid ] && kill -0 "$(cat data/server.pid)" 2>/dev/null; then
  kill "$(cat data/server.pid)"
  rm -f data/server.pid
  echo "Sitrep stopped."
else
  rm -f data/server.pid
  echo "Sitrep is not running."
fi
