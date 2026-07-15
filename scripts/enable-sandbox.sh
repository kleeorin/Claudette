#!/usr/bin/env bash
# Enable bubblewrap sandboxing for Claudette on THIS host — one command, once.
#
# Claudette can confine each Claude session to a bubblewrap sandbox so it can
# only touch the directories you mount (see SANDBOX.md). bubblewrap needs
# permission to create a user namespace, and modern distros lock that down by
# default. Enabling it is a one-time, privileged action per machine — the same
# kind of host setup Docker's daemon/group needs. This script does the minimum
# for whatever is blocking it, and is safe to re-run.
#
# It is PORTABLE: run the identical command on your laptop and on every remote.
#   - already works        → does nothing, exits 0
#   - Ubuntu/Debian clamp  → installs a bwrap-only AppArmor profile (surgical:
#                            only bwrap regains userns; every other app stays
#                            restricted)
#   - old sysctl knob off  → enables kernel.unprivileged_userns_clone persistently
#   - hard-disabled        → tells you the universal setuid fallback
#
# Usage:
#   ./scripts/enable-sandbox.sh          # detect + fix (prompts for sudo if needed)
#   ./scripts/enable-sandbox.sh --check  # probe only, change nothing (exit 0 = works)
#
# Nothing here is required for Claudette to run — without it, sessions simply
# launch unsandboxed and the UI labels them "sandbox unavailable".

set -euo pipefail

BWRAP="$(command -v bwrap || true)"
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

# Actually attempt a throwaway sandbox — the ONLY reliable test. "binary exists"
# is not enough: on Ubuntu 24.04 bwrap is present but the namespace is denied.
# Bind the WHOLE root ro so the test binary + its dynamic loader are present —
# we're testing "can bwrap create a namespace", not isolation, so completeness
# beats minimalism here (a partial bind fails execvp with a misleading ENOENT).
probe() {
  [ -n "$BWRAP" ] || return 1
  "$BWRAP" --ro-bind / / --dev /dev --proc /proc --unshare-user --die-with-parent \
           /usr/bin/true 2>/dev/null
}

say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }

if [ -z "$BWRAP" ]; then
  err "bubblewrap is not installed."
  say "  Debian/Ubuntu: sudo apt install -y bubblewrap"
  say "  Fedora:        sudo dnf install -y bubblewrap"
  say "  Arch:          sudo pacman -S bubblewrap"
  exit 1
fi

if probe; then
  ok "Sandbox already works — nothing to do ($BWRAP)."
  exit 0
fi

if $CHECK_ONLY; then
  warn "Sandbox NOT available (bwrap present but cannot create a namespace)."
  say  "  Run without --check to fix it."
  exit 1
fi

say "bwrap is present but cannot create a namespace. Applying the minimal fix…"
say "(you may be prompted for your sudo password)"

changed=false

# 1) Ubuntu/Debian: AppArmor restricts unprivileged userns. Grant it to bwrap
#    ONLY — the surgical fix that keeps the hardening on for everything else.
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  say "→ AppArmor is restricting unprivileged user namespaces; installing a bwrap profile."
  sudo tee /etc/apparmor.d/bwrap >/dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>
profile bwrap $BWRAP flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
  sudo apparmor_parser -r /etc/apparmor.d/bwrap
  changed=true
fi

# 2) Older distros: the classic sysctl toggle, made persistent.
if [ "$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo 1)" = "0" ]; then
  say "→ Enabling kernel.unprivileged_userns_clone (persistently)."
  echo 'kernel.unprivileged_userns_clone=1' | sudo tee /etc/sysctl.d/99-claudette-userns.conf >/dev/null
  sudo sysctl -p /etc/sysctl.d/99-claudette-userns.conf >/dev/null
  changed=true
fi

if probe; then
  ok "Sandbox enabled. Claudette sessions can now be confined."
  exit 0
fi

err "Still cannot create a namespace$([ "$changed" = true ] && echo " even after the fix above")."
say "User namespaces may be hard-disabled by policy on this host."
say "Universal fallback (needs root, larger attack surface): make bwrap setuid —"
say "    sudo chmod u+s $BWRAP"
say "Claudette still runs fine without the sandbox; sessions just won't be confined."
exit 1
