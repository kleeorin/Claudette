#!/usr/bin/env bash
# Launch Claudette (single-user, localhost). Starts the Node app server and the
# Vite web dev server together; Ctrl-C stops both. Run from anywhere.
#
#   ./launch.sh              # dev (hot-reload): server :4319, web :5173
#   ./launch.sh --build      # production: build web, serve it from the server
#   PORT=5000 ./launch.sh    # override the server port (web proxy follows)
set -euo pipefail

# Resolve the repo root from this script's location, so cwd doesn't matter.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Use nvm's Node no matter which terminal launched us (see the helper for why).
# shellcheck source=scripts/use-nvm-node.sh
. "$ROOT/scripts/use-nvm-node.sh"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4319}"
WEB_PORT="${WEB_PORT:-5273}"
export HOST PORT WEB_PORT

# --- prerequisites ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found. Install Node.js 20 LTS or later." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "error: Node $NODE_MAJOR detected; Claudette needs Node 20+." >&2
  exit 1
fi

# Soft checks — warn but don't block (features land across phases).
command -v claude  >/dev/null 2>&1 || echo "warn: 'claude' not on PATH — chat sessions won't start (npm i -g @anthropic-ai/claude-code)." >&2
python3 -c 'import jupyter_server' >/dev/null 2>&1 || echo "warn: jupyter_server not importable for python3 — notebooks won't run (pip install jupyter-server ipykernel)." >&2

# --- dependencies -----------------------------------------------------------
# Install if node_modules is missing or the lockfile changed since last install.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ] 2>/dev/null; then
  echo "==> installing dependencies…"
  npm install
fi

# --- run --------------------------------------------------------------------
if [ "${1:-}" = "--build" ]; then
  echo "==> building web…"
  npm run build -w @claudette/web
  echo "==> serving app + API from one origin on http://$HOST:$PORT"
  if [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "localhost" ] && [ -z "${CLAUDETTE_TOKEN:-}" ]; then
    echo "    note: HOST is non-loopback — set CLAUDETTE_TOKEN=\$(openssl rand -hex 24) to expose securely (the server will refuse to start otherwise)." >&2
  fi
  # For phone access: front this single origin with HTTPS, e.g.
  #   tailscale serve --bg $PORT      (private tailnet, real cert)
  # then open  https://<your-tailnet-name>/?token=<CLAUDETTE_TOKEN>  once.
  exec npm run start -w @claudette/server
fi

echo "==> Claudette dev"
echo "    server : http://$HOST:$PORT"
echo "    web    : http://$HOST:$WEB_PORT   <-- open this"
echo
exec npm run dev
