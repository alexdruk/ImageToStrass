#!/bin/bash
# From Rhinestone-Studio @38cd831 services/strass-layout/scripts/start_layout.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -x .venv/bin/python ]; then
  echo "No virtual environment found. Run scripts/setup_mac.sh first." >&2
  exit 1
fi

echo "Tip: to keep the Mac awake during long layouts, start this script as: caffeinate -i scripts/start.sh" >&2

# IS: the background removal model is the one setting read from the app's .env (only that line).
if [ -z "${REMBG_MODEL:-}" ] && [ -f ../../.env ]; then
  REMBG_MODEL="$(sed -n 's/^REMBG_MODEL=\([^[:space:]#]*\).*/\1/p' ../../.env | tail -n 1)"
fi
export REMBG_MODEL

. .venv/bin/activate
exec uvicorn app:app --host 127.0.0.1 --port "${STRASS_PORT:-8000}" --workers 1
