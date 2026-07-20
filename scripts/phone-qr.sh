#!/usr/bin/env bash
# Print a scannable QR (in your terminal) for opening Claudette on your phone.
#
# The QR encodes  <url>/?token=<token>  — everything the phone needs to reach +
# authenticate in one scan. It contains your access token, so treat the terminal
# output like a password (don't screen-share it).
#
# It picks the best URL automatically:
#   1. an active `tailscale serve` mapping (recommended — goes THROUGH tailscaled,
#      so it bypasses any host firewall; works from anywhere with Tailscale on),
#   2. else this machine's Tailscale IP,
#   3. else a LAN IP (same-WiFi only), else loopback.
#
# Usage:
#   CLAUDETTE_TOKEN=<secret> ./scripts/phone-qr.sh            # auto-detect URL
#   CLAUDETTE_TOKEN=<secret> ./scripts/phone-qr.sh --png qr.png   # write a PNG too
#   ./scripts/phone-qr.sh <token> [host] [port]              # force host/port (skips serve)
set -euo pipefail

PNG=""
if [ "${1:-}" = "--png" ]; then PNG="${2:-phone-qr.png}"; shift 2 || true; fi

TOKEN="${CLAUDETTE_TOKEN:-${1:-}}"
if [ -z "$TOKEN" ]; then
  echo "error: no token. Set CLAUDETTE_TOKEN=… (the secret the server was started with)," >&2
  echo "       or pass it:  ./scripts/phone-qr.sh <token> [host] [port]" >&2
  exit 1
fi

# 1) If `tailscale serve` is active, use its URL — this is the firewall-proof path.
#    The plain `tailscale serve status` prints the full MagicDNS URL(s); grep the
#    one with the `.ts.net` suffix (that's what resolves on the phone). Retry a few
#    times since a busy tailscaled can momentarily return nothing.
serve_base() {
  command -v tailscale >/dev/null 2>&1 || return 1
  local out="" i
  for i in 1 2 3 4; do
    out="$(tailscale serve status 2>/dev/null || true)"
    [ -n "$out" ] && break
    sleep 0.3
  done
  # Match the serve URL — HTTPS on 443 has no port; HTTP serve has an explicit one.
  printf '%s' "$out" | grep -oE 'https?://[A-Za-z0-9._-]+\.ts\.net(:[0-9]+)?' | head -1
}

# 2/3) Fallback: pick a reachable host directly (arg > Tailscale IP > LAN > loopback).
pick_host() {
  local h="${2:-${HOST:-}}"
  if [ -n "$h" ] && [ "$h" != "0.0.0.0" ]; then echo "$h"; return; fi
  if command -v tailscale >/dev/null 2>&1; then
    local ts; ts="$(tailscale ip -4 2>/dev/null | head -1)"
    [ -n "$ts" ] && { echo "$ts"; return; }
  fi
  local lan; lan="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(192|10|172)\.' | head -1)"
  [ -n "$lan" ] && { echo "$lan"; return; }
  echo "127.0.0.1"
}

FORCED_HOST="${2:-${HOST:-}}"
BASE=""
NOTE=""
if [ -z "$FORCED_HOST" ] && BASE="$(serve_base)" && [ -n "$BASE" ]; then
  NOTE="via tailscale serve (firewall-proof; Tailscale must be ON)"
else
  HOST_RESOLVED="$(pick_host "$@")"
  PORT_RESOLVED="${3:-${PORT:-4400}}"
  BASE="http://${HOST_RESOLVED}:${PORT_RESOLVED}"
  case "$HOST_RESOLVED" in
    100.*) NOTE="direct via Tailscale IP (Tailscale ON; may be blocked by a host firewall — prefer serve)";;
    127.*) NOTE="loopback only (this machine)";;
    *)     NOTE="direct via LAN (same-WiFi only)";;
  esac
fi

URL="${BASE}/?token=${TOKEN}"

echo
echo "  $NOTE"
echo "  Open on your phone:"
echo "    $URL"
echo

npx --yes qrcode "$URL"         # terminal QR — scan it off the screen
if [ -n "$PNG" ]; then          # …and, when asked, also drop a PNG to open/scan later
  npx --yes qrcode -o "$PNG" -w 520 "$URL"
  echo "  PNG written: $PNG"
fi
