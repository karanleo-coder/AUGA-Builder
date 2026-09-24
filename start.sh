#!/usr/bin/env bash
# Launches AUGA-Builder: FastAPI backend on :8000, Vite dev server on :5173.
# Stop with Ctrl+C (kills both).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Setting up Python virtual environment (.venv) ..."
  uv venv .venv
  uv pip install --python .venv/bin/python -r backend/requirements.txt -r scripts_requirements.txt
fi

if [ ! -d frontend/node_modules ]; then
  echo "Installing frontend dependencies ..."
  (cd frontend && npm install)
fi

cleanup() {
  echo "Stopping..."
  kill "${BACKEND_PID:-0}" "${FRONTEND_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(cd backend && "../.venv/bin/python" -m uvicorn main:app --port 8000 --log-level warning) &
BACKEND_PID=$!

(cd frontend && npm run dev) &
FRONTEND_PID=$!

echo ""
echo "Backend:  http://127.0.0.1:8000"
echo "Frontend: http://localhost:5173"
echo ""

wait
