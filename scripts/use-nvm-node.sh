#!/usr/bin/env bash
# Sourced (not executed) by launch.sh / rc_launch.sh: make `node` and `npm` resolve
# to nvm's Node regardless of which terminal started us. Non-interactive shells (GUI
# terminals, desktop launchers, cron, IDE run buttons) usually skip the nvm init in
# ~/.bashrc, so a stray /usr/bin/node — or none at all — would otherwise win the PATH
# lookup. Here we load nvm and select a version so the rest of the script sees the
# same Node you'd get in your normal shell.
#
# Selection order: repo .nvmrc (cwd) → nvm 'default' alias → newest installed version.
# No-op when nvm isn't installed; the caller still does its own node/version check.

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  # nvm.sh is written for interactive shells and trips over `set -eu`; relax the
  # strict flags that are on, source + select, then restore exactly what we changed.
  __nvm_restore=""
  case "$-" in *e*) __nvm_restore="${__nvm_restore}e" ;; esac
  case "$-" in *u*) __nvm_restore="${__nvm_restore}u" ;; esac
  set +eu

  # shellcheck disable=SC1090,SC1091
  . "$NVM_DIR/nvm.sh" --no-use
  # `nvm use` (no arg) honours a .nvmrc in the cwd; if there's none it returns
  # non-zero and we fall back to the default alias, then to the newest install.
  nvm use >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true

  [ -n "$__nvm_restore" ] && set -"$__nvm_restore"
  unset __nvm_restore
elif [ -d "$NVM_DIR/versions/node" ]; then
  # nvm.sh is absent but versions are installed — prepend the newest version's bin.
  __nvm_newest="$(ls -1 "$NVM_DIR/versions/node" 2>/dev/null | sort -V | tail -1)"
  [ -n "$__nvm_newest" ] && export PATH="$NVM_DIR/versions/node/$__nvm_newest/bin:$PATH"
  unset __nvm_newest
fi
