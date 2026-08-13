#!/usr/bin/env bash
# diagnose-rewind — why does /rewind's CODE restore do nothing on this machine?
#
# Code-rewind is git-backed (server/src/git/shadowSnapshots.ts): before every turn the
# server snapshots the working tree into a commit and pins it at
# refs/claudette/rewind/<turn-uuid>. Every step of that swallows its error, so a machine
# where one step fails silently shows "No snapshot for this turn" forever.
#
# This replays the exact git calls the server makes, but LOUDLY. Run it on the machine
# where code rewind doesn't work, from the session's cwd:
#
#   bash scratchpad/diagnose-rewind.sh [repo-dir]
set -uo pipefail

DIR="${1:-$PWD}"
echo "== repo under test: $DIR"

echo
echo "-- 1. is it a git repo the server can see? (repoRoot)"
if ! ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>&1)"; then
  echo "FAIL: $ROOT"
  echo "  -> snapshots are disabled entirely. Either the session cwd isn't inside a git repo,"
  echo "     or git refuses this repo (e.g. 'dubious ownership' -> git config --global --add safe.directory $DIR)."
  exit 1
fi
echo "ok: $ROOT   (git $(git --version | awk '{print $3}'))"

echo
echo "-- 2. snapshots already pinned here (refs/claudette/rewind/*)"
N="$(git -C "$ROOT" for-each-ref --format='%(refname)' refs/claudette/rewind | wc -l | tr -d ' ')"
echo "count: $N"
[ "$N" = "0" ] && echo "  -> nothing was ever snapshotted: step 3/4 below is failing, or the keying step is (see the tail of this script's output)."

echo
echo "-- 3. can the server take a snapshot? (add -A -> write-tree -> commit-tree, in a temp index)"
IDX="$(mktemp -u "${TMPDIR:-/tmp}/claudette-diag-idx-XXXXXX")"
if ! OUT="$(GIT_INDEX_FILE="$IDX" git -C "$ROOT" add -A 2>&1)"; then
  echo "FAIL at 'git add -A': $OUT"
  echo "  -> typically an unreadable file in the tree (permissions, a dead symlink, a mount the"
  echo "     server can't see) or a failing hook. snapshot() returns null and code rewind is off."
  rm -f "$IDX"; exit 1
fi
[ -n "$OUT" ] && echo "note (add): $OUT"
if ! TREE="$(GIT_INDEX_FILE="$IDX" git -C "$ROOT" write-tree 2>&1)"; then
  echo "FAIL at 'git write-tree': $TREE"; rm -f "$IDX"; exit 1
fi
echo "tree: $TREE"
PARENT=()
if HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"; then PARENT=(-p "$HEAD_SHA"); fi
if ! COMMIT="$(GIT_INDEX_FILE="$IDX" git -C "$ROOT" commit-tree "$TREE" -m 'claudette rewind diagnostic' "${PARENT[@]}" 2>&1)"; then
  echo "FAIL at 'git commit-tree': $COMMIT"
  echo "  -> most often NO COMMITTER IDENTITY on this machine:"
  echo "       git config --global user.name  'You'"
  echo "       git config --global user.email 'you@example.com'"
  rm -f "$IDX"; exit 1
fi
echo "ok: snapshot commit $COMMIT (unpinned; it will be gc'd)"
rm -f "$IDX"

echo
echo "-- 4. can it pin the ref? (update-ref)"
if ! OUT="$(git -C "$ROOT" update-ref refs/claudette/diagnostic "$COMMIT" 2>&1)"; then
  echo "FAIL at 'git update-ref': $OUT"
  echo "  -> the ref store is read-only for this user: snapshots are taken but never survive."
  exit 1
fi
git -C "$ROOT" update-ref -d refs/claudette/diagnostic
echo "ok"

echo
echo "== the git side is healthy."

# Step 5 only matters when git works but nothing was ever pinned: then the failure is in
# the KEYING step (sessionManager.attachPendingSnapshot), which matches the snapshot to its
# turn by comparing the prompt text sent against the user line the CLI wrote to
# ~/.claude/projects/<cwd-slug>/<session>.jsonl. A user line stored as anything other than a
# plain string, or carrying extra wrapper text, never matches -> the snapshot is dropped at
# the start of the next turn.
echo
echo "-- 5. does the CLI write user lines in the shape the keying step expects?"
echo "claude CLI: $(command -v claude >/dev/null 2>&1 && claude --version 2>&1 | head -1 || echo 'not on PATH')"
echo "checkout:   $(git -C "$ROOT" log --oneline -1)"
git -C "$ROOT" merge-base --is-ancestor be57a8c HEAD 2>/dev/null \
  && echo "            (includes rewind Phase 2)" \
  || echo "            WARNING: this checkout does NOT include rewind Phase 2 (be57a8c) -- code rewind isn't built yet here."

SLUG="$(printf '%s' "$DIR" | sed 's/[^a-zA-Z0-9]/-/g')"
PROJ="$HOME/.claude/projects/$SLUG"
if [ ! -d "$PROJ" ]; then
  echo "no transcript dir at $PROJ"
  echo "  -> the CLI stores this session's transcript elsewhere; run this script from the SESSION's cwd."
else
  NEWEST="$(ls -t "$PROJ"/*.jsonl 2>/dev/null | head -1)"
  echo "newest transcript: ${NEWEST:-none}"
  [ -n "$NEWEST" ] && node -e '
    const fs = require("fs")
    const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.trim())
    const users = []
    for (const l of lines) {
      let o; try { o = JSON.parse(l) } catch { continue }
      if (o.type !== "user" || o.isMeta || o.isSidechain) continue
      users.push(o?.message?.content)
    }
    const strings = users.filter((c) => typeof c === "string")
    console.log(`user lines: ${users.length} total, ${strings.length} with STRING content` +
      (strings.length < users.length ? "  <-- non-string content is invisible to listRewindPoints" : ""))
    for (const c of strings.slice(-3)) {
      const s = c.replace(/\n/g, "\\n")
      console.log(`  * ${JSON.stringify(s.slice(0, 100))}${s.length > 100 ? " ..." : ""}`)
    }
    console.log("  -> each of these must equal EXACTLY the prompt you typed (after the editor-context")
    console.log("     block is stripped). Any wrapper/prefix the CLI adds breaks snapshot keying.")
  ' "$NEWEST"
fi
