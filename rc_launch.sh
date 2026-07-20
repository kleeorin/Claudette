#!/usr/bin/env bash
# rc_launch — launch Claudette with OUTWARD access (phone / remote) over Tailscale.
#
# It does the full "reach it from anywhere, securely" setup in one command:
#   1. builds the web and runs the server on loopback, token-guarded,
#   2. serves it at  https://<your-tailnet-name>/  via `tailscale serve` (real cert),
#   3. prints the phone URL + a scannable QR,
#   4. runs the server in the foreground (Ctrl-C stops it).
#
# Security model (see PLAN §1 / auth.ts): nothing is public. Only your tailnet
# devices can reach it (WireGuard), and the app itself requires an access token.
#
# The token is persisted under ~/.config/claudette/ (NOT in the project dir, which is
# mounted into session sandboxes) so it is STABLE across runs — your installed phone
# app (PWA) keeps its login and doesn't need re-scanning. Override for one run with
# CLAUDETTE_TOKEN=… ./rc_launch.sh  (also rewrites the file).
#
#   ./rc_launch.sh                 # build + serve + run (HTTPS on 443)
#   ./rc_launch.sh --new           # mint a FRESH token (rotates; devices must re-scan)
#   PORT=4319 ./rc_launch.sh       # change the local app port (serve follows)
#
# Whenever a new token is minted (--new, or the first-ever run) a scannable QR PNG
# is written next to the token file (~/.config/claudette/qr.png) — NOT in the
# project dir, since the PNG encodes the token and the project dir is mounted into
# session sandboxes.
#
# To STOP exposing it later:  tailscale serve --https=443 off
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Use nvm's Node no matter which terminal launched us (see the helper for why).
# shellcheck source=scripts/use-nvm-node.sh
. "$ROOT/scripts/use-nvm-node.sh"

# --- args -------------------------------------------------------------------
NEW_TOKEN=0
for arg in "$@"; do
  case "$arg" in
    --new)     NEW_TOKEN=1 ;;
    -h|--help) echo "usage: [PORT=…] ./rc_launch.sh [--new]   (--new mints a fresh access token)"; exit 0 ;;
    *)         echo "rc_launch: unknown argument '$arg' (try --new or --help)" >&2; exit 1 ;;
  esac
done

HOST="127.0.0.1"                 # app binds loopback; tailscale serve fronts it
PORT="${PORT:-4319}"
# Persist the token OUTSIDE the project dir. The project is bind-mounted read-write
# into each session's sandbox, so a token file living there is readable by a
# (potentially compromised) sandboxed Claude — which could then authenticate to the
# control API and create an unsandboxed session. ~/.config is never mounted.
TOKEN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claudette"
TOKEN_FILE="$TOKEN_DIR/token"
mkdir -p "$TOKEN_DIR"; chmod 700 "$TOKEN_DIR"
# One-time migration: relocate a legacy in-project token, then remove the exposed copy.
LEGACY_TOKEN_FILE="$ROOT/.claudette-token"
if [ -s "$LEGACY_TOKEN_FILE" ] && [ ! -s "$TOKEN_FILE" ]; then
  cp "$LEGACY_TOKEN_FILE" "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
  echo "==> migrated access token out of the project dir → $TOKEN_FILE"
fi
[ -e "$LEGACY_TOKEN_FILE" ] && rm -f "$LEGACY_TOKEN_FILE"

# --- prerequisites ----------------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "error: node not found. Install Node 20+." >&2; exit 1; }
if ! command -v tailscale >/dev/null 2>&1; then
  echo "error: tailscale not installed. Install it and run 'sudo tailscale up' first." >&2
  echo "       (Or use ./launch.sh for local-only.)" >&2
  exit 1
fi
tailscale status >/dev/null 2>&1 || { echo "error: Tailscale isn't connected. Run 'sudo tailscale up'." >&2; exit 1; }

# --- access token (stable across runs) --------------------------------------
# GENERATED = did THIS run mint a fresh token? (--new, or the first-ever run.) When
# it did, existing devices' saved logins are invalidated, so we also drop a QR PNG.
GENERATED=0
if [ "$NEW_TOKEN" = "1" ]; then
  TOKEN="$(openssl rand -hex 16)"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"; GENERATED=1
  echo "==> --new: rotated the access token → $TOKEN_FILE (existing devices must re-scan)"
elif [ -n "${CLAUDETTE_TOKEN:-}" ]; then
  TOKEN="$CLAUDETTE_TOKEN"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
elif [ -s "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE")"
else
  TOKEN="$(openssl rand -hex 16)"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"; GENERATED=1
  echo "==> generated a new access token → $TOKEN_FILE"
fi

# --- dependencies + production build ----------------------------------------
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ] 2>/dev/null; then
  echo "==> installing dependencies…"
  npm install
fi
echo "==> building web…"
npm run build -w @claudette/web >/dev/null

# --- expose over Tailscale HTTPS (443 → loopback app) -----------------------
echo "==> exposing over Tailscale HTTPS (serve 443 → 127.0.0.1:$PORT)…"
if ! tailscale serve --bg --https=443 "$PORT" 2>/tmp/rc_serve.err; then
  echo "error: 'tailscale serve' failed:" >&2
  sed 's/^/    /' /tmp/rc_serve.err >&2
  echo "  Likely fixes:" >&2
  echo "    • one-time (so serve needs no sudo):  sudo tailscale set --operator=\$USER" >&2
  echo "    • enable HTTPS certs on your tailnet:  https://login.tailscale.com/admin/dns  → Enable HTTPS" >&2
  rm -f /tmp/rc_serve.err
  exit 1
fi
rm -f /tmp/rc_serve.err

# --- show the phone URL + QR ------------------------------------------------
# On a freshly-minted token, also write a PNG so you can open/scan it later. It
# ENCODES THE TOKEN, so it lives beside the token file (~/.config/claudette, never
# mounted into a session sandbox) — writing it into the project dir would let a
# sandboxed session read the token straight out of the image.
QR_PNG="$TOKEN_DIR/qr.png"
echo
if [ -x "$ROOT/scripts/phone-qr.sh" ]; then
  if [ "$GENERATED" = "1" ]; then
    CLAUDETTE_TOKEN="$TOKEN" "$ROOT/scripts/phone-qr.sh" --png "$QR_PNG" || true
    chmod 600 "$QR_PNG" 2>/dev/null || true
  else
    CLAUDETTE_TOKEN="$TOKEN" "$ROOT/scripts/phone-qr.sh" || true
  fi
else
  BASE="$(tailscale serve status 2>/dev/null | grep -oE 'https?://[A-Za-z0-9._-]+\.ts\.net(:[0-9]+)?' | head -1)"
  echo "  Open on your phone (Tailscale ON):  ${BASE}/?token=${TOKEN}"
fi
echo
echo "  (first HTTPS hit provisions the cert — it can take ~10s once, then it's instant)"
echo "  stop outward serving later with:  tailscale serve --https=443 off"
echo

# --- run the server (foreground; Ctrl-C stops it) ---------------------------
echo "==> Claudette server on http://$HOST:$PORT  —  Ctrl-C to stop"
exec env HOST="$HOST" PORT="$PORT" CLAUDETTE_TOKEN="$TOKEN" npm run start -w @claudette/server
