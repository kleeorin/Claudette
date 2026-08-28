#!/usr/bin/env bash
# SAFE MUTATION TESTING — mutate a source file, run something, put it back, and REFUSE to
# put it back if someone else touched it meanwhile.
#
#   scratchpad/safe-mutate.sh <target-file> <python-patch-expr> <command...>
#
#   scratchpad/safe-mutate.sh web/src/components/FileManager.tsx \
#     "src = src.replace('joinPath(pending.dir', 'joinPath(dir')" \
#     npx tsx scratchpad/file-multiselect-guard.mts
#
# ── WHY THIS EXISTS. IT COST TEN FIXES. ──────────────────────────────────────────────
# On 2026-08-27 a mutation cycle on FileManager.tsx reverted TEN review fixes another
# session had applied while the cycle was running. Nothing errored. The restore "succeeded".
#
# The trap is that restore does not reinstate the file you snapshotted — IT OVERWRITES
# WHATEVER IS THERE NOW. If a concurrent author saved between your snapshot and your
# restore, their work is gone, and the md5 check afterwards makes it look FINE: the file
# matches your snapshot, which is precisely the state that means someone else's edit was
# destroyed. A green checksum on the wrong baseline is worse than no checksum.
# What was actually left behind was a chimera — the other session's NEW comments sitting
# above the OLD code — which is only noticeable if you happen to read the diff.
#
# ★ PREFER A COPY. The safest cycle does not touch the original at all: copy the file to a
#   repo-root dotfile, rewrite its relative imports, mutate THAT, and point the harness at
#   it. Prove the copy reproduces the real file's result before mutating it. This script is
#   for when a copy is impractical — it cannot make in-place mutation safe, only make its
#   failure LOUD instead of silent.
set -u
[ $# -ge 3 ] || { echo "usage: $0 <target-file> <python-patch-expr> <command...>" >&2; exit 64; }
target="$1"; patch="$2"; shift 2
[ -f "$target" ] || { echo "safe-mutate: no such file: $target" >&2; exit 64; }

md5of() { md5sum "$1" | cut -d' ' -f1; }
snap="$(mktemp)"; cp "$target" "$snap"
snap_md5="$(md5of "$target")"

# Apply the patch. A patch that changes NOTHING is rejected before anything runs: a mutation
# whose pattern silently failed to match tests the unmutated file, and then reports "this
# assertion cannot be made to fail" — a conclusion about the test that is simply false.
if ! python3 - "$target" "$patch" <<'PY'
import sys
target, expr = sys.argv[1], sys.argv[2]
src = open(target).read()
before = src
exec(expr)
if src == before:
    sys.stderr.write('safe-mutate: the patch changed nothing — pattern did not match.\n'
                     '  A no-op mutation runs against the ORIGINAL file and then reads as\n'
                     '  "this assertion cannot fail", which is a false finding about the test.\n')
    sys.exit(3)
open(target, 'w').write(src)
PY
then rm -f "$snap"; exit 3; fi

mut_md5="$(md5of "$target")"
"$@"; rc=$?

# ---- THE CHECK THAT MATTERS ---------------------------------------------------------
now_md5="$(md5of "$target")"
if [ "$now_md5" != "$mut_md5" ]; then
  conflict="$target.safe-mutate-conflict"
  cp "$target" "$conflict"
  cat >&2 <<MSG

!!! safe-mutate: REFUSING TO RESTORE — $target changed while the command ran.
!!!   Someone else is writing this file. Restoring would overwrite their work with a
!!!   snapshot taken before it existed, and would look like it succeeded.
!!!     snapshot (yours, pre-mutation) : $snap_md5   -> kept at $snap
!!!     after your mutation            : $mut_md5
!!!     on disk now                    : $now_md5   -> copied to $conflict
!!!   The file on disk is LEFT AS IT IS. Reconcile by hand: the other author's version is
!!!   what is there now; your mutation is the diff between $snap and $conflict.
MSG
  exit 2
fi
cp "$snap" "$target"
[ "$(md5of "$target")" = "$snap_md5" ] || { echo "safe-mutate: restore did not verify" >&2; rm -f "$snap"; exit 2; }
rm -f "$snap"
exit $rc
