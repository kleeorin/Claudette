#!/usr/bin/env bash
# QA harness: sequence the scratchpad checks and report a pass/fail/skip table.
#
# There is no test runner in this repo — each scratchpad file boots its own real deps and
# signals via exit code — so this just runs them with a timeout and collects results. It
# probes for prerequisites first and reports a missing one as SKIP, never as FAIL: a suite
# that shows red for "chrome isn't installed" trains you to ignore red.
#
#   scratchpad/run-suite.sh                 # everything whose prerequisites are present
#   scratchpad/run-suite.sh <file> ...      # only these (prerequisite probes still apply)
#   ALL=1 scratchpad/run-suite.sh           # run even the ones probed as blocked
#
# Logs land in /tmp/claudette-qa/<name>.log. NEVER touches the user's :4319 server.
#
# COST: a full run is CHEAP — 4m46s measured on 2026-08-24, with the six jupyter tests
# skipping for a missing jupyter_server. An earlier estimate of 50-70 min came from a box
# where those six ran, and it caused baselines to be rationed. Do not ration
# them: take the number after every batch of landings, not at the end of a long queue.
# That is how you catch the moment a count moves for a reason nobody can name.
#
# ---- ONE RUN IS NOT A MEASUREMENT, IN EITHER DIRECTION ----------------------------
# A single FAILING Chrome run may be a flake: three runs have settled more than one dispute
# here, and a correct fix was nearly reverted on the strength of one bad run. THE MIRROR IS
# JUST AS TRUE AND IS THE ONE PEOPLE SKIP: a single PASSING run settles nothing either. A
# doubled-scrollback defect was measured at 4 doubled / 2 clean over six runs — one run
# would have shown green and been reported fixed. Before claiming a fix, run it ~5 times.
# WORKED EXAMPLE, 2026-08-24: two full suite runs over a BYTE-IDENTICAL tree returned
# 63/8/6 and 64/7/6. The whole difference was clear-race-test flaking once. Quoting either
# number as "the" baseline without saying that would have been wrong in both directions.
#
# ---- THREE WAYS A DIAGNOSIS GOES WRONG HERE (all three cost real time) -------------
# 1. A PARTIAL CAUSAL TEST GENERALISED TO THE WHOLE. Reverting one of four changes in a
#    suspect file, seeing the failure persist, and concluding "not this file" — it proves
#    only that the part you reverted was not the cause. Revert the WHOLE suspect, confirm
#    green, then bisect. This exact mistake cleared sessionReducer.ts of a bug that was in
#    sessionReducer.ts, and the wrong conclusion then propagated into two other sessions.
# 2. mtime RECORDS ONLY THE LAST WRITE. "Nothing changed in this window" is not something a
#    timestamp scan can establish: a file edited inside your window and again afterwards
#    shows only the later stamp and is silently excluded. Use it to find candidates, never
#    to rule one out. (sessionReducer.ts was edited at 21:05, inside the window, and a scan
#    the next morning showed only the morning stamp.)
# 3. A POST-MORTEM COMMENT COPIED INTO A NEW FILE BECOMES A LIVE FINDING. terminal-ui-e2e's
#    header narrates, in the past tense, a data-dir bug fixed ten lines below it. Copied into
#    a derivative file and detached from its fix, it read as a present-tense discovery that
#    the suite was running against the operator's real session store. It was not: all 12
#    server-booting harnesses isolate CLAUDETTE_DATA_DIR (enumerated 2026-08-25). If you copy
#    a harness, re-read its comments as claims about TODAY.
#
# And the one that outranks all three: A TEST WRITTEN TO A SPEC IS ONLY AS RIGHT AS THE SPEC.
# The reducer suite sat at a confident 92/92 while one of its checks asserted the buggy
# behaviour, written faithfully to a spec that was wrong. Green unit tests are not evidence
# about behaviour one layer out — when an integration test and a unit suite disagree, the
# unit suite is the one with the narrower view.
#
# ---- HOW TO READ A RED (the interpretability taxonomy) ----------------------------
# Not every result here is evidence. Before calling any browser test's outcome genuine,
# work out which group it is in:
#
#   GROUP A — the browser is served `web/dist`, a BUILT bundle nobody in a sandbox can
#     rebuild. A result is NO SIGNAL IN EITHER DIRECTION while that bundle is older than
#     the source: its passes are as uninterpretable as its failures. The asymmetry to
#     guard against is that an unexplained RED feels like information in a way an
#     unexplained GREEN does not — it is not. THE CHECK IS CHEAP AND DECISIVE: grep
#     web/dist/assets/ for a string unique to the change under test. If it is absent, the
#     test never saw the code, and the red belongs to the bundle, not to the app.
#     Members: the nine srv4321 entries, plus terminal-ui-e2e and notebook-ui-e2e (which
#     boot their own server, but with NODE_ENV=production, which serves the same bundle).
#
#   GROUP B — the test spawns its own `npx vite` dev server OR runs `vite build` first, so
#     the browser gets the WORKING TREE. Fully interpretable. Members: layout-check,
#     clear-race, composer-history-repro, find-diff-check, find-ui-check, super-editor,
#     ask-card-height-probe, refresh-survival-check, scroll-memory-check,
#     doubling-agents-test. (Detect by looking for a vite dev server OR a vite build —
#     grepping only for `vite build` misclassifies layout-check.)
#
#   GROUP C — no browser at all. Fully interpretable.
#
set -u
cd "$(dirname "$0")/.."

LOGDIR=/tmp/claudette-qa
mkdir -p "$LOGDIR"
# Nine scratchpad scripts write PNGs into this directory and NOT ONE of them creates it
# (ratelimit-test.mjs, plus the eight *-shot.mjs). On a machine where /tmp has been cleared
# — every reboot, and every fresh sandbox — the first writer dies with ENOENT *after* its
# assertions have run, so a test with two genuine failures reports as a crash and the real
# result is never printed. Create it once here rather than nine times, badly.
mkdir -p /tmp/claudette-shots

# ---- prerequisite probes ----------------------------------------------------
# Headless-CDP tests spawn a real Chrome; the path is baked into each script.
# The repo BUNDLES a Chrome for Testing under .chrome-headless/ — prefer it, and export
# CHROME_BIN so the harnesses that honour it (find-ui-check.mjs) pick it up. A confined
# session cannot reach /opt, where a system Chrome's real binary lives, so the bundled one
# is often the only reachable browser even though /usr/bin/google-chrome appears to exist.
have_chrome=no
if [ -z "${CHROME_BIN:-}" ]; then
  for c in .chrome-headless/chrome/*/chrome-linux64/chrome /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium; do
    real="$(readlink -f "$c" 2>/dev/null)"
    [ -n "$real" ] && [ -x "$real" ] && { CHROME_BIN="$real"; export CHROME_BIN; break; }
  done
fi
[ -n "${CHROME_BIN:-}" ] && [ -x "${CHROME_BIN}" ] && have_chrome=yes
# The notebook stack needs a python that can actually import jupyter_server. Claudette
# launches bare `python3` unless a nearer .venv wins, so probe exactly that interpreter.
have_jupyter=no
python3 -c 'import jupyter_server' >/dev/null 2>&1 && have_jupyter=yes
# Two tests drive a real `claude` session (slow, needs credentials).
have_claude=no
command -v claude >/dev/null 2>&1 && have_claude=yes

echo "prereqs: chrome=$have_chrome jupyter=$have_jupyter claude=$have_claude"

# ---- IS BUCKET 1 WORTH ANYTHING THIS RUN? ------------------------------------------
# The ~11 harnesses that serve web/dist are interpretable only while that bundle is newer
# than EVERYTHING IT WAS BUILT FROM. That is a comparison of timestamps, not a judgement
# call, so make the machine do it — it would have printed on every run for days, and instead
# the staleness had to be rediscovered by hand each time.
#
# ★ THE INPUT SET IS NOT web/src, AND ASSUMING IT WAS LEFT A SILENT HOLE (fixed 2026-08-26).
# This compared web/dist against web/src alone. But web imports @claudette/shared, and
# shared/package.json `exports` points straight at ./src/index.ts — there is NO build step,
# so vite compiles shared/src INTO the bundle. An edit to shared/src therefore invalidated
# web/dist while this banner went on printing `interpretable`, and eleven harnesses would
# run against a stale build with nothing anywhere saying so. Every other staleness race this
# suite has hit was at least VISIBLE; this one was not, which makes it the worse kind.
# The set is now everything vite reads out of the repo: all of web/ EXCEPT the bundle it
# writes and its node_modules, plus shared/src. That also picks up index.html,
# vite.config.ts, tailwind/postcss config, package.json and public/ — sw.js among them,
# a real runtime input — none of which a web/src scan ever saw either.
# server/src is deliberately NOT in the set. @claudette/server is symlinked into
# node_modules, but nothing under web/ imports it (checked with grep, not assumed); a server
# edit changes what the harnesses talk TO, which is a different question, and one the tree
# fingerprint below already answers.
BUCKET1_STALE=no
if [ -f web/dist/index.html ]; then
  # index.html specifically, as the bundle's build time: vite rewrites it on every build, so
  # it is the one file guaranteed to be stamped. NOT the oldest file in web/dist, which would
  # be the strictly conservative choice — a single uncleaned asset from an older build would
  # then pin this to NO SIGNAL permanently, and an alarm that can never be cleared gets
  # ignored, which is the failure mode this whole banner exists to avoid.
  dist_t=$(stat -c %Y web/dist/index.html 2>/dev/null || echo 0)
  n1=$(grep -cE '"(srv4321[^:]*|chrome):(terminal-ui-e2e|notebook-ui-e2e)\.mjs"|"srv4321[^:]*:' "$0")
  # Newest file PER INPUT ROOT, so a stale verdict names every tree that moved rather than
  # just the single newest file. Naming one witness is enough to justify the verdict, but not
  # enough to act on: told only "buffers.ts is newer" you rebuild for that and never learn
  # shared/src moved too, which is the exact blindness this check was widened to remove.
  b1_stale_lines=""; b1_newest=""; b1_newest_t=0
  for root in web shared/src; do
    [ -d "$root" ] || continue
    n=$(find "$root" -type d \( -path web/dist -o -path web/node_modules \) -prune -o \
          -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1)
    [ -n "$n" ] || continue
    t="${n%% *}"; t="${t%%.*}"; f="${n#* }"
    if [ "$t" -gt "$b1_newest_t" ]; then b1_newest_t="$t"; b1_newest="$f"; fi
    if [ "$dist_t" -lt "$t" ]; then
      b1_stale_lines="$b1_stale_lines  · $root — newest is $f, written $(date -d @"$t" '+%F %T')
"
    fi
  done
  # SELF-TEST, because this check has exactly one catastrophic failure mode. If the prune ever
  # breaks, the "newest input" is a file web/dist itself just wrote, the bundle is compared
  # against itself, and this banner reports a confident and PERMANENT green — the one
  # direction that must never fail quietly. An empty scan does the same thing by a different
  # route (nothing to compare, so nothing looks stale). Refuse to give a verdict instead.
  case "${b1_newest:-EMPTY}" in
    EMPTY|web/dist/*)
      BUCKET1_STALE=yes
      echo "bucket 1: CANNOT TELL — the bundle-input scan returned ${b1_newest:-nothing}, so it is"
      echo "  either empty or picking up web/dist itself. Fix the scan; until then no bucket-1"
      echo "  result means anything, in either direction."
      ;;
    *)
      if [ -n "$b1_stale_lines" ]; then
        BUCKET1_STALE=yes
        echo "bucket 1 ($n1 harnesses): NO SIGNAL — web/dist was built $(date -d @"$dist_t" '+%F %T') and these inputs are newer:"
        printf '%s' "$b1_stale_lines"
        echo "  their passes and failures are equally uninterpretable until web/dist is rebuilt."
      else
        echo "bucket 1 ($n1 harnesses): interpretable — web/dist ($(date -d @"$dist_t" '+%F %T')) is newer than every bundle input (newest: $b1_newest)"
      fi
      ;;
  esac
fi

# ---- DID THE TREE MOVE UNDER THE RUN? ----------------------------------------------
# Sequencing people by hand failed three times in one day: a full run was contaminated by a
# teammate's edit landing mid-run, twice without anyone noticing until the numbers were
# already quoted. So the run validates itself. Rollup hash per tree before and after; on a
# mismatch, name the tree AND the files whose mtime falls inside the run window, and stamp
# the FINAL SUMMARY — because the only line most people read is the last one.
# `web`, not `web/src`, for the same reason the banner above widened: a mid-run edit to
# index.html, vite.config.ts or public/sw.js moves the bundle just as surely as a source
# edit, and web/src never saw them. web/dist is INSIDE that tree and is deliberately kept —
# a rebuild landing mid-run changes what every bucket-1 harness is served and contaminates
# a run exactly as much as a source edit does, so it should be caught, not excluded.
# node_modules is pruned everywhere: it is huge, it churns for reasons unrelated to the run,
# and hashing it would make this alarm too noisy to keep. (Verified nothing in the suite
# writes into web/dist — clear-race and super-editor both `vite build --outDir` into their
# own mkdtemp, and in the hardened sandbox web/dist is --ro-bind anyway.)
FP_TREES="web server/src shared/src scratchpad"
tree_fp() { find "$1" -type d -name node_modules -prune -o -type f -print 2>/dev/null | sort | xargs md5sum 2>/dev/null | md5sum | cut -d' ' -f1; }
RUN_T0=$(date +%s)
FP_BEFORE=""
for t in $FP_TREES; do [ -d "$t" ] && FP_BEFORE="$FP_BEFORE$t $(tree_fp "$t")\n"; done

# ---- the shared :4321 throwaway server -------------------------------------------
# Eight of the browser tests do NOT boot a server. They point at a hardcoded
# http://127.0.0.1:4321 and document, in their own headers, that you start one by hand:
#   env -u CLAUDETTE_TOKEN CLAUDETTE_NO_AUTH=1 CLAUDETTE_DATA_DIR=$(mktemp -d) \
#     PORT=4321 HOST=127.0.0.1 npx tsx src/index.ts
# So they were never automatable as written — in a suite run they navigated to a dead port
# and timed out on a selector, which reads exactly like a stale selector and is not.
# Rather than rewrite eight tests to each boot their own, the runner provides the server
# they were designed against: ONE instance, isolated data dir, CLAUDETTE_NO_AUTH=1 (the
# documented test escape), torn down at the end. Never the operator's :4319.
SRV_PID=""; SRV_DATA=""; FOREIGN_4321=no
# HARD-FAIL ON A FOREIGN :4321 — this used to say "something already listens, using it" and
# carry on. That fallback was the worst kind of convenience: it converted a port collision
# into SILENT CONTAMINATION and produced confident numbers that were wrong in BOTH directions
# (a run against a stranger's server showed real-turn-browser-test PASSING while it was a
# baseline failure). A red gets investigated; a wrong green does not.
# It also violated this file's own header rule — a suite must never report a prerequisite
# problem as a test result — and, worst of all, it was the LAST REMAINING ROUTE by which this
# suite could touch the operator's live session store: the eight shared-server harnesses are
# isolated only because start_shared_server gives them `CLAUDETTE_DATA_DIR="$(mktemp -d)"`.
# Adopt a stranger's server and they inherit ITS data dir, which may be ~/.config/claudette.
start_shared_server() {
  if ss -ltn 2>/dev/null | grep -q '127.0.0.1:4321'; then
    if [ "${ALLOW_FOREIGN_4321:-0}" = "1" ]; then
      echo "note: :4321 is held by another process and ALLOW_FOREIGN_4321=1 — using it. Results from the eight shared-server tests are NOT trustworthy."
      FOREIGN_4321=adopted
      return 0
    fi
    FOREIGN_4321=yes
    cat <<'MSG'
:4321 is already held by another process — refusing to run the eight shared-server tests
against it. Their results would be silently wrong in BOTH directions, and its data dir may
be the operator's real ~/.config/claudette rather than a throwaway. `ss -ltn` will show the
port held but not by whom (you can see a port is held, not who holds it). Stop any other
suite run or Claudette server on :4321, then re-run.
Override with ALLOW_FOREIGN_4321=1 only if you know whose server it is.
MSG
    return 1
  fi
  SRV_DATA="$(mktemp -d)"
  env -u CLAUDETTE_TOKEN CLAUDETTE_NO_AUTH=1 CLAUDETTE_DATA_DIR="$SRV_DATA" \
      PORT=4321 HOST=127.0.0.1 npx tsx server/src/index.ts >"$LOGDIR/_shared-4321.log" 2>&1 &
  SRV_PID=$!
  disown "$SRV_PID" 2>/dev/null || true   # keep bash job control from printing "Killed" on teardown
  for _ in $(seq 1 60); do
    curl -sf http://127.0.0.1:4321/api/health >/dev/null 2>&1 && { echo "shared :4321 server up (pid $SRV_PID)"; return 0; }
    sleep 0.5
  done
  echo "WARNING: shared :4321 server did not come up — see $LOGDIR/_shared-4321.log"
  return 1
}
stop_shared_server() {
  [ -n "$SRV_PID" ] || return 0
  # Kill by the LISTENING pid too: npx → tsx → node means the parent alone leaves the
  # grandchild holding the port (HANDOVER: never pkill -f "tsx src/index.ts").
  local lp; lp="$(ss -ltnp 2>/dev/null | grep '127.0.0.1:4321' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
  kill -9 "$SRV_PID" 2>/dev/null
  [ -n "$lp" ] && kill -9 "$lp" 2>/dev/null
  [ -n "$SRV_DATA" ] && rm -rf "$SRV_DATA"
  SRV_PID=""
}
trap stop_shared_server EXIT
echo

# ---- the set ----------------------------------------------------------------
# needs:none — pure/argv/in-process. needs:jupyter/chrome/claude — gated above.
# Excluded entirely: rt-proxy-crash / rt2-proxy-crash take a <case> argv (one per
# process), print-sandbox-prompt is a printer, *-shot.mjs screenshot producers are
# screenshot producers with no assertions.
# ---- THE EXPECTED REDS -------------------------------------------------------------
# Three registered files are SUPPOSED to fail. Their reasons were documented one comment
# block each, which meant reading three separate places to answer "is this run healthy?" —
# and a summary line of "8 failed" told you nothing about whether five or eight of them
# mattered. Name them here so the category is legible at a glance.
#
# TWO KINDS, and conflating them is how a real finding gets waved through as "expected":
#   unbuilt — the test documents work that has not been written. A characterization test.
#   closed  — the test documents a REAL fault and fails CLOSED. It is protecting you. It is
#             emphatically NOT an escape, and must never be reported as one.
# Format: "<file>|<kind>|<one-line reason>"
EXPECTED_RED=(
  "viewof-precondition-guard.mts|unbuilt|documents the unbuilt viewOf precondition work"
  # agent-pending-test.mts was listed here as `unbuilt` while F4 was only proposed. F4 IS
  # BUILT — agentKey/appliedAgentKey/agentPending are in agents.ts + sessionManager.ts +
  # shared/types.ts, and the test runs 14/14 green. Leaving it registered as an expected red
  # would be the exact confusion the block above warns about: once a green file is on this
  # list, a genuine future failure gets waved through as "expected". Removed rather than
  # re-kinded, because it is no longer red of either kind.
  "authorizer-box-divergence-guard.mts|closed|an ordering fault, caught by failing CLOSED — this is the guard WORKING, not a sandbox escape"
)
expected_red_kind() { local f="$1" e; for e in "${EXPECTED_RED[@]}"; do [ "${e%%|*}" = "$f" ] && { e="${e#*|}"; echo "${e%%|*}"; return 0; }; done; return 1; }
expected_red_why()  { local f="$1" e; for e in "${EXPECTED_RED[@]}"; do [ "${e%%|*}" = "$f" ] && { echo "${e##*|}"; return 0; }; done; return 1; }

SUITE=(
  "none:find-engine-check.mts"
  "none:proposals-test.mts"
  "none:session-confinement-test.mts"
  "none:sandbox-escape-fixes-test.mts"
  "none:sandbox-fs-escape-fixes-test.mts"
  "none:sandbox-gpu-passthrough-test.mts"
  "none:sandbox-toctou-check.mts"
  "none:sandbox-symlink-authorizer-probe.mts"
  "none:sandbox-live-confinement-check.mts"
  "none:sandbox-unowned-kernel-test.mts"
  "none:sandbox-paths-test.mts"
  "none:data-dir-test.mts"
  "none:host-config-mirror-test.mts"
  "none:creds-live-resync-test.mts"
  "none:connectors-test.mts"
  "none:session-reducer-test.mts"
  # F4: does a RUNNING session notice its role definition changed underneath it? launch()
  # copies the role's scope into the spawn once, so narrowing a role leaves live sessions on
  # the old, wider one. Browser-free, result-dependent exit at :118.
  "none:agent-pending-test.mts"
  # A failed turn must not render as a successful one. Pins the classifier against the real
  # auth-failure `result` frame, which carries `is_error: true` AND `subtype: 'success'` —
  # the old `is_error === true || /error/i.test(subtype)` was false for it, so the turn
  # showed as a silent success and the user just logged in again. Pure unit test, no deps.
  "none:result-error-classification-test.mts"
  "none:output-keys-test.mts"
  # GROUP C. The unsaved-editor-buffer store: does a held buffer ever shadow a file that
  # changed on disk? The operator met this as "files open stale and don't record changes" —
  # nothing was failing to record; the new text was on disk and simply never displayed.
  # Markdown fired it with NO typing (Milkdown re-normalizes on load, dirty is text !== disk,
  # so merely opening a .md file out of normal form stored a buffer and poisoned that path).
  # Registered because the failure is SILENT — a shadowed file throws nothing and renders
  # happily, so no other red in this suite could ever stand in for it — and because
  # buffers.ts exports clearBuffers() "for tests" and had none. Pure logic, no browser, ~0s.
  "none:buffers-guard.mts"
  "none:auth-route-coverage-test.mts"
  "none:sandbox-symlink-argv-characterization.mts"
  "none:connectors-gpu-adversarial-test.mts"
  "none:rt2-connectors.mts"
  "none:rt2-connectors-b.mts"
  # ~130s, and the slowest browser-free member by an order of magnitude — almost all of it
  # case A3 waiting out the proxy's real 120s UPSTREAM_TIMEOUT_MS. That wait is the assertion:
  # "the request is bounded" cannot be established without watching it complete, and the
  # constant is not exported so there is no shortcut. It was 3s while A3 was a FALSE RED
  # claiming an unbounded hang; the cost is what it takes to stop lying. See its header.
  "none:rt2-connectors-c.mts"
  "none:review-fixes-test.mts"
  "none:iframe-output-adversarial-test.mts"
  "none:output-sanitizer-test.mts"
  # Hygiene lint, not a feature test: every file that BINDS a port must reap on every exit
  # path, and no two files may bind the same port. Both rules are why a SECURITY test
  # (auth-loopback) once reported 8 false failures against an unauthenticated server its
  # own previous run had stranded.
  # Unlike the characterization reds above, this is a LINT: green is its correct steady
  # state, so every red is a genuine violation to fix rather than a number to remember.
  # The 4321 pair it used to flag is FIXED (clear-race-test.mjs moved to 4327/4329), and so
  # is the round after it: refresh-survival-check.mjs had collided with
  # composer-history-repro.mjs on 4494 AND 5294, and xterm-replay-probe.mjs spawned detached
  # children with no signal reapers — the exact orphan-minting pattern that squatted
  # :4331/:4332 for days. Both were caught here and fixed. Currently green; keep it that way.
  # STANDING GUARD, not a characterization test: pins the caller-chain precondition that
  # keeps the venv-probe guard working. openPath must store a LOGICAL doc.path; adding a
  # realpathSync there — which reads like hardening — reopens the escape. Green is its
  # correct steady state; a red here is a real regression.
  "none:venv-probe-chain-guard.mts"
  # STANDING GUARD. Pins what makes the nested-mount SHADOWING fault unreachable: the
  # symlink refusal, which is load-bearing for more than the escape it was written for.
  # Section 4 is a deliberate CHARACTERIZATION of today's over-approximation in the
  # (unwired) path layer — when A2 lands box-space resolution that assertion must FLIP,
  # in the same commit. Do not "fix" it by flipping the expectation alone.
  "none:mount-shadowing-guard.mts"
  # ⚠ EXPECTED RED — UNBUILT WORK, NOT A LIVE ESCAPE, AND IT FAILS *CLOSED*. The companion to
  # mount-shadowing-guard above: same root cause, opposite direction. That one records a
  # fail-OPEN over-approximation (a shadowed host path judged reachable); this one records a
  # fail-CLOSED under-approximation — the authorizer DENIES a write the box performs happily.
  # Consequence is an inexplicable permission error on a legitimate write, NOT a breach; do not
  # let a red here be reported as a sandbox escape.
  # CAUSE: sandboxPathAccess sorts by the depth of the LOGICAL mount path, matches on the
  # CANONICAL one, and takes the LAST match. Two UNRELATED mounts can expose the same real bytes
  # without shadowing each other — both live in the box at once — so the right rule is "ANY
  # mount that reaches it grants", not "the last one decides". Both defects die to the same fix:
  # resolve in BOX space. It flips to green when that lands, in the same commit.
  # ★ WHY THIS ONE IS WORTH MORE THAN ITS SIBLINGS: every other guard on this strand reasons
  # about mount arithmetic. This RUNS THE REAL BWRAP BOX, performs an actual write inside it,
  # and compares the result to what the authorizer predicted. The defect was first derived by
  # hand and flagged by its author as "reasoning, not probed"; this settled it by execution on
  # the first run. It skips cleanly when bwrap is absent — a missing prerequisite must never
  # read as a failure — and it asserts its own PREMISE (that the box really can write), so if
  # the fixture ever stops exercising the defect it says so instead of passing for the wrong
  # reason.
  "none:authorizer-box-divergence-guard.mts"
  # STANDING GUARD, green today and green is correct: no file under server/src or shared/src
  # may reference viewOf / boxCanReach / refuseIfBoxCouldHavePlaced / overlayPathFor. The rule
  # that the path layer stays unwired until its preconditions are met used to be a sentence in
  # a comment; this is that sentence as a check.
  # ★ IT IS MEANT TO GO RED ONE DAY. When the first caller is deliberately wired, RETIRE this
  # guard in the same commit — do not add an exemption and do not delete it quietly, because
  # either turns "we decided this is ready" into "someone made the alarm stop". A red you did
  # NOT cause by wiring something means the layer was imported by accident, which is the whole
  # point. It self-checks first: if the definer moves or a watched symbol is renamed it fails
  # LOUDLY rather than going permanently green watching a name that no longer exists.
  "none:layer-not-wired-guard.mts"
  # ⚠ EXPECTED RED — AND IT DOCUMENTS UNBUILT WORK, NOT A LIVE ESCAPE. Distinct from
  # data-dir-containment-guard above: nothing here is broken or exploitable today. It states a
  # PRECONDITION for wiring the path layer — that refused mounts come back as EXCLUSIONS WITH A
  # REASON rather than being silently dropped — and reds because that API does not exist yet.
  # sessionDataMounts (sandbox.ts:588) ends in a bare .filter(), so a refusal leaves nothing
  # behind to count, which makes OVER-refusal unmeasurable at exactly the moment it starts to
  # matter. The reason is already computed and printed to the console; it is simply discarded.
  # Runtime half only — the compile-time half needs a tsc-shelling trick (scratchpad/ is under
  # no tsconfig) and should land WITH the type changes, not before.
  # 0/4 is the CORRECT current reading. It goes green when the work lands, not when it breaks.
  "none:viewof-precondition-guard.mts"
  # ⚠ EXPECTED RED — AND IT DOCUMENTS A LIVE ESCAPE, not unbuilt work. A session whose
  # mounts include $HOME (or any ancestor of ~/.config/claudette) can write its own entry
  # in sessions.json, which restore() replays as TRUSTED (sessionManager.ts:941) — so it
  # can grant itself teamEmploy:true or sandbox:{enabled:false} and come back unconfined.
  # dataDir.ts:9-26 assumes ~/.config is never bind-mounted; that holds for the OBLIGATORY
  # mounts only. Fix: a dataDirProtections() beside appSourceProtections, reusing
  # overlayDestFor(). Needs a writable server/. GREEN is the goal; red here is the escape.
  "none:data-dir-containment-guard.mts"
  # Escape 6 (loopback auth token readable from inside a box) had a guard that was NEVER
  # REGISTERED, so the suite reported no failures for it and two handover documents
  # asserted "both guards green" on the strength of a test that never ran. A guard absent
  # from this list is indistinguishable from a guard that passes.
  "none:auth-token-containment-guard.mts"
  # Covers ESCAPE 1 (percent-encoding auth bypass) — the one the handover calls the worst
  # of the four, because it defeated the premise the other three rest on. It was written,
  # it passes, and it had NEVER run in the harness. Same shape as the auth-token guard.
  "none:auth-path-bypass-test.mts"
  # The teammate-blocked signal: asserts the coordinator is told, exactly once per turn,
  # and that the false "when its current turn ends" promise is gone.
  "none:teammate-blocked-signal-test.mts"
  "none:port-and-reap-lint.mts"
  # Every executable file in scratchpad/ must be registered here or declared a non-test.
  # Five real tests were found written-but-never-run in a single day; this makes that
  # state impossible rather than merely detectable.
  "none:registration-lint.mts"
  # Regression probes for escapes 1-3 and the venv/mount guards. They assert real
  # properties and pass, so they belong in the suite rather than in the non-test list.
  "none:sandbox-three-escapes-probe.mts"
  "none:venv-probe-coincidence-probe.mts"
  # EXPECTED RED until reviewer-role-scope.patch + connector-readonly-deny.patch land.
  # Asserts the FIXED behaviour, so today it demonstrates that the `reviewer` role still
  # auto-approves bare Bash and that a read-only role still trusts a connector's own
  # readOnlyHint. It turning green is the signal those two patches are in.
  "none:reviewer-scope-test.mts"
  # Was EXPECTED RED until the sandbox.ts fixes landed; they are now IN the tree (which(),
  # the symlink guard, and the app-source overlay), so this should be GREEN. A red here now
  # means a regression, not a pending fix — do not re-read it as "expected".
  "none:sandbox-regression-fixes-test.mts"
  "none:editor-context-test.mts"
  "none:stop-task-test.mts"
  "none:team-test.mts"
  "none:upload-test.mts"
  "none:lock-gate-test.mts"
  "none:opfocus-test.mts"
  "none:undo-redo-test.mts"
  "none:notebook-doc-test.mts"
  "none:active-pane-test.mts"
  "none:auth-loopback-test.mjs"
  "jupyter:notebook-runstate-test.mts"
  "jupyter:mcp-e2e-test.mts"
  "jupyter:kernel-e2e-test.mts"
  "jupyter:kernel-cwd-test.mts"
  "jupyter:jupyter-proxy-test.mts"
  # EXPECTED RED until the phone layout + the permission-card move land — it asserts the
  # TARGET behaviour. Its [today] checks must stay green regardless.
  # EXPECTED RED until the phone-layout work lands — it is a CHARACTERIZATION test for
  # unbuilt UI, not a regression. Its own output says so ("[phone]/[fix] failures are
  # EXPECTED…"), but that only appears in the log, so from the summary line it reads as a
  # genuine failure sitting beside real ones. The `[fix]` assertion — the pending
  # permission card scrolling 668px off-screen — goes green when the card moves out of the
  # transcript scroll container, which is slice 1 of the phone work.
  "chrome:layout-check.mjs"
  # INTERMITTENT — observed failing once in four runs on 2026-08-24 (three passes: two
  # standalone at 11s, one in-suite at 11s) with the signature `timeout: !!(… 'Chat')` at
  # 17s, i.e. the whole 12s waitFor budget consumed with the app never rendering. Tree was
  # byte-identical across all four. Not diagnosed: its log was overwritten before the
  # post-mortem. If you see that exact signature, it is this — re-run before believing it,
  # and if it becomes frequent the thing to look at is the 12s budget in waitFor (:137)
  # under suite load, not a regression in the app.
  "chrome:clear-race-test.mjs"
  "chrome:composer-history-repro.mjs"
  "chrome:find-diff-check.mjs"
  "chrome:find-ui-check.mjs"
  # chrome AND jupyter: it drives a notebook through the browser, so ten of its twelve
  # assertions are pure UI — but the last two ("cell ran through the UI and output 42
  # appeared", "kernel status surfaced in header") need a REAL kernel, and a kernel needs
  # jupyter_server. Registered as plain `chrome:` it therefore sat at a permanent 10/2 on
  # any box without it, indistinguishable in the summary from a genuine UI regression.
  # Five sibling notebook tests already SKIP for exactly this reason; this one now agrees.
  "chrome+jupyter:notebook-ui-e2e.mjs"
  # `chrome:`, not `none:` — it spawns CHROME_BIN. As `none:` it FAILED rather than SKIPped
  # on a box without a browser, which is the "red for a missing prerequisite" this file's
  # header says a suite must never produce. It also binds :4321 itself (a static proxy over
  # its OWN fresh build, in front of its API on :4328); that is safe because the loop below
  # stops the shared :4321 server before any non-srv4321 test runs.
  "chrome:super-editor-test.mjs"
  # GROUP A. Boots its own server with NODE_ENV=production, so the browser is served web/dist,
  # NOT the working tree. STATUS 2026-08-25: GREEN, all six checks, after the bundle was rebuilt
  # and the underlying bug fixed. Its long-standing red was TWO things, and only one of them was
  # the stale bundle:
  #   1. the bundle predated `canTerm`, so the test never saw the code (no signal, not a failure);
  #   2. once rebuilt it STAYED red, because `canTerm={activeId !== null}` is the wrong predicate
  #      while the selection can dangle — sessionReducer's `list` case never checked that the
  #      active id was still IN the incoming list, and an out-of-band destroy arrives as a plain
  #      `session:list`, not as `destroyed`. Two changes, one guarantee.
  # It has a clean fails-first pair on record: RED against the pre-fix bundle, GREEN against the
  # post-fix one, freshness verified in both runs — so its green is worth something.
  # ★ THE STANDING HAZARD: this is a Group A test, so it re-stales the instant anyone edits
  # web/src. A dist-serving result is uninterpretable unless the run states when the bundle was
  # built. Rebuild in the same run, or do not quote the result.
  "chrome:terminal-ui-e2e.mjs"
  # Devil's slice-1 probe: AskUserQuestionCard's height bound at phone width. It was written
  # as a fails-first proof and is NO LONGER an expected red — the bound landed
  # (`max-h-[calc(var(--vvh,100vh)*0.55)]`, a visualViewport-driven variable rather than the
  # original 60vh) and the probe's own assertion now passes: card 279px, Submit reachable at
  # 390x844 with the keyboard up. Green is its correct steady state; a red here is a real
  # regression in that bound.
  "chrome:ask-card-height-probe.mjs"
  # Phone slice 2A net for App.tsx's reload path. Spawns its own server+vite+Chrome, so
  # unlike the srv4321 group it does NOT serve the stale web/dist — its result is real.
  # It originally bound 4494/5294 — composer-history-repro.mjs's ports — and that collision
  # cost a real false red (composer-history-repro died on EADDRINUSE 4494 mid-suite and read
  # as a composer regression). port-and-reap-lint caught it; the ports have since been
  # renumbered and the lint is green. Kept as the worked example of why that lint exists.
  "chrome:refresh-survival-check.mjs"
  # Does the terminal pane track the VISIBLE viewport? Group B (own vite over the working
  # tree), so it never reads the stale web/dist. Green is its steady state: the dock's height
  # is bounded by --vvh, so a dock sized on a desktop (restored from localStorage) no longer
  # overflows an overflow-hidden shell and clips the prompt when a phone keyboard is up.
  # It also carries ONE ⚠️  [open] finding it deliberately does not fix — the stacked Claude
  # column is `stackH + dock + 1` with stackH unbounded, which clips the terminal AT REST on
  # a full 844px viewport, i.e. with no keyboard involved. [open] prints with its numbers and
  # does NOT fail the run, so this stays green in the suite rather than becoming a second
  # permanently-red harness nobody reads. If that ⚠️  turns into a ✅, stackH got bounded and
  # the check should be deleted.
  "chrome:xterm-vvh-probe.mjs"
  # Settles the keyboard-PAN question that web/src/index.css calls "device-only, unresolved".
  # It is not device-only: Emulation.setPageScaleFactor gives headless Chrome a visual
  # viewport shorter than the layout viewport, and a wheel event pans it (offsetTop > 0 while
  # scrollY stays 0). Standalone page, no server, no vite — ~6s. Its verdict is that
  # `position: fixed; inset: 0`, the remedy index.css names, does NOT stop the pan; a red here
  # means that verdict changed and index.css needs re-reading before anything is applied.
  "chrome:visual-viewport-pan-probe.mjs"
  # Companion to the pan probe, in the REAL app with a pending permission card on screen:
  # what `position: fixed; inset: 0` on the shell wrapper would COST if applied anyway.
  # Verdict: the suspected cost (breaking the shrink-0 permission-card/composer bands) is NOT
  # real — neither form moves the card into the scroll container at either width. The real
  # cost is that the literal form discards --vvh and pushes the composer 250px further below
  # the visible viewport on a phone. Carries ONE ⚠️  [open]: with a pending card and the
  # keyboard up, the composer's bottom is ALREADY 33px below an overflow-hidden shell, before
  # any rule is applied. Phone-only; desktop is clean. Not fixed — which band gives up the
  # 33px is a layout-policy call.
  "chrome:shell-fixed-cost-probe.mjs"
  # GROUP B — own server (4499), own vite (5299), own Chrome. It compiles the WORKING TREE,
  # so unlike the Group A tests its result is real evidence, which is the whole point: the
  # scroll-memory key fix it tests is in web/src and is NOT in web/dist, so a bundle-serving
  # probe could not have tested it at all.
  # `chrome:` and not `chrome+jupyter:` deliberately: the EDITOR half needs no kernel, and
  # gating on jupyter would skip that half too. The NOTEBOOK half self-skips with a printed
  # warning when long.ipynb will not open, and does NOT fail — so if that warning appears,
  # A GREEN HERE COVERS THE EDITOR ONLY. Read its log, not just its exit code. (Measured
  # 2026-08-24 on this jupyter-less box: the warning did NOT fire — rendering and scrolling
  # a notebook needs no kernel — and all 15 checks ran, 6 of them the notebook half.)
  "chrome:scroll-memory-check.mjs"
  # GROUP B — own server (4485), own vite (5285), own Chrome. MOVED OUT OF THE srv4321 GROUP
  # on 2026-08-25 and rewritten: it used to drive a REAL Claude turn and ask the model to call
  # its Agent tool, so three of its seven checks depended on a model CHOOSING to delegate and
  # sat at a permanent red. It now drives a stand-in `claude` on PATH, which makes it
  # deterministic AND moves it out of bucket 1 (it no longer serves the stale web/dist).
  # ★ READ ITS HEADER BEFORE QUOTING A GREEN: a stub means nothing here exercises the real
  # CLI's delegation path. It covers the RENDERING of subagent/assistant frames and nothing
  # upstream of them. `chrome:` and not `chrome+claude:` — it needs no CLI on PATH.
  "chrome:doubling-agents-test.mjs"
  # GROUP B — own server (4486), own vite (5286), own Chrome. The `session:sendFailed`
  # branch: a turn that never reached a live engine must SAY so instead of sitting in the
  # transcript looking delivered. Registered because the rest of the suite is blind to this
  # in BOTH directions — seven harnesses send a real turn and none inspects a bubble's
  # delivery state, so the branch can neither fire nor mis-fire without every one of them
  # staying green. Its [2] LIVE control is the half that catches an inverted check.
  # `chrome:` and not `chrome+claude:` — the dead engine is a stand-in CLI that exits.
  "chrome:send-failed-guard.mjs"
  # PURE, no server, no browser (~3ms) — same shape as session-reducer-test.mts. Pins hazard
  # H6 from web/src/store/sessionReducer.ts: App.tsx's notebook-restore effect marked an id
  # seen BEFORE testing whether it could act on it, which permanently defeated the retry its
  # own [openIds, activeId] dep array existed to provide. Test 2 is the regression; it fails
  # against the old ordering and passes against the new one. Registered here rather than as a
  # vitest file because vitest is neither installed nor declared in web/package.json, so
  # web/src/store/sessions.test.tsx cannot currently be executed at all.
  "none:notebook-attach-test.mts"
  # --- these eight need the shared :4321 server (see start_shared_server) ---
  "srv4321:attention-test.mjs"
  "srv4321:history-resume-test.mjs"
  "srv4321:notebook-session-test.mjs"
  "srv4321:notifications-test.mjs"
  "srv4321:optimistic-busy-test.mjs"
  "srv4321:ratelimit-test.mjs"
  "srv4321:ready-clobber-test.mjs"
  "srv4321:sound-notif-test.mjs"
  # Tenth member of the group, and it was NOT here. Registered `chrome:` it sat ABOVE this
  # block, but it boots no server and hardcodes http://127.0.0.1:4321 — and the shared
  # server does not start until the first srv4321 entry. So every full run navigated it to
  # a dead port and it timed out waiting for the Chat button: a guaranteed red that said
  # nothing whatsoever about the UI. `+claude` because it drives a REAL turn; without the
  # CLI it must SKIP, not FAIL.
  # Proven both ways: reverting the membership test below to `= srv4321` brings the dead
  # port back (20s, `timeout: Chat`); with it, the server starts and the run reaches
  # session creation in 5s. It STILL fails there — but that red is GROUP A and therefore
  # not a verdict on anything: the Aug-22 bundle's SPA talks to an Aug-24 server, and the
  # composer textarea never appears because the session never finishes being created.
  # Do not diagnose it further until web/dist is rebuilt.
  "srv4321+claude:real-turn-browser-test.mjs"
  "claude:interrupt-test.mts"
  "claude:loose-ends-test.mts"
)

# An explicit file list keeps each file's recorded prerequisite.
if [ $# -gt 0 ]; then
  picked=()
  for want in "$@"; do
    want="$(basename "$want")"
    for e in "${SUITE[@]}"; do [ "${e#*:}" = "$want" ] && picked+=("$e"); done
  done
  SUITE=("${picked[@]}")
fi

# How many BUCKET 1 harnesses are actually in THIS invocation. The stale-bundle stamp at the
# bottom is gated on it: run a single Group B file and the bundle's freshness is irrelevant to
# the result, so stamping it anyway trains you to scroll past the one banner that matters on a
# full run. Same membership test the n1 count uses — the srv4321 group plus the two that boot
# their own server with NODE_ENV=production and are therefore served the same bundle.
b1_in_run=0
for entry in "${SUITE[@]}"; do
  case "${entry%%:*}" in srv4321*) b1_in_run=$((b1_in_run+1)); continue ;; esac
  case "${entry#*:}" in terminal-ui-e2e.mjs|notebook-ui-e2e.mjs) b1_in_run=$((b1_in_run+1)) ;; esac
done

# ---- GATE: AN ORPHANED HEADLESS CHROME ON A CDP PORT ------------------------------
# The SAME contamination shape as a foreign :4321, one layer down, and it cost this run
# real time on 2026-08-26: two orphaned Chromes were squatting :9333 and :9348 — the CDP
# ports of notebook-ui-e2e and find-ui-check — left behind by earlier runs whose servers
# were long dead. It is silent by construction. A harness spawns its own Chrome with
# `--remote-debugging-port=N`; the bind fails because N is taken, but the harness's very
# next move is `fetch(http://127.0.0.1:N/json)`, which the SQUATTER answers. So it attaches
# to a stranger's browser parked on a dead page and every selector misses — a guaranteed
# red carrying no information about the app, indistinguishable from a stale selector.
# It can also lie the other way: a squatter parked on a LIVE page of the right app would
# answer assertions that this run's code never rendered.
# Refuse, and say who is holding it — unlike a plain port, CDP will tell you: its page URLs
# are printed below, which is usually enough to see at a glance whether it is an orphan of
# ours or a browser someone is still driving. Deliberately NOT auto-closed: quietly killing
# a browser another session is using is a worse failure than stopping.
# To clear an orphan (no pid needed — `pgrep` cannot see other sessions' processes anyway),
# ask it to close over its own debugger:
#   node -e 'const{WebSocket}=require("ws");fetch("http://127.0.0.1:9333/json/version")
#     .then(r=>r.json()).then(v=>{const w=new WebSocket(v.webSocketDebuggerUrl);
#     w.on("open",()=>w.send(JSON.stringify({id:1,method:"Browser.close"})))})'
cdp_busy=()
for entry in "${SUITE[@]}"; do
  f="${entry#*:}"; path="scratchpad/$f"
  [ -f "$path" ] || continue
  for p in $(grep -aoE 'remote-debugging-port=[0-9]+' "$path" | cut -d= -f2 | sort -u); do
    curl -s --max-time 1 "http://127.0.0.1:$p/json/version" >/dev/null 2>&1 || continue
    urls=$(curl -s --max-time 1 "http://127.0.0.1:$p/json" 2>/dev/null \
           | grep -oE '"url": "[^"]*"' | cut -d'"' -f4 | head -3 | tr '\n' ' ')
    cdp_busy+=("  :$p  wanted by $f  — parked on: ${urls:-<no pages>}")
  done
done
if [ ${#cdp_busy[@]} -gt 0 ]; then
  if [ "${ALLOW_FOREIGN_CDP:-0}" = "1" ]; then
    echo "note: CDP ports are held by another browser and ALLOW_FOREIGN_CDP=1 — those harnesses will attach to IT, not to their own Chrome. Their results are NOT trustworthy:"
    printf '%s\n' "${cdp_busy[@]}"
    echo
  else
    cat <<'MSG'
A headless Chrome is already listening on a CDP port this suite needs. Refusing to run:
the harness would silently attach to THAT browser instead of its own and report a red (or,
worse, a green) that says nothing about this tree. See the note above this check for how to
close an orphan over its own debugger.
MSG
    printf '%s\n' "${cdp_busy[@]}"
    echo
    echo "Override with ALLOW_FOREIGN_CDP=1 only if you know whose browser it is."
    exit 1
  fi
fi

pass=0; fail=0; skip=0; failed=()

# ---- GATE: a suite member must be ABLE to report failure -------------------------
# `connectors-gpu-adversarial-test.mts` printed its findings and then called an
# unconditional `process.exit(0)`. It is the 41-attack red-team suite CONNECTORS.md cites
# as its evidence, it was registered here, and it reported PASS no matter what it found.
# A test that cannot fail is worse than a missing one: it manufactures confidence.
#
# THE RULE: a suite member must contain at least one `process.exit(<expr>)` whose argument
# is not a bare numeric literal — i.e. an exit code actually derived from results.
# `exit(fail ? 1 : 0)`, `exit(passed === n ? 0 : 1)`, `exit(unexpected.length ? 1 : 0)` all
# qualify; `exit(0)` and `exit(1)` alone do not, and neither does having no exit at all.
#
# WHY THIS IS SCOPED TO SUITE MEMBERS, not to scratchpad/*: a crude repo-wide grep flags
# every legitimately-unconditional utility (print-sandbox-prompt, the *-shot.mjs capture
# scripts) and is then ignored for noise. Only files in SUITE claim to be tests, so only
# they are held to it — which makes the check precise enough to be a HARD FAILURE rather
# than a warning nobody reads. A warning here would scroll past exactly like the findings
# this exists to stop scrolling past.
#
# Embedded child-process source (the stand-in `claude` shims in the browser harnesses
# contain their own `process.exit(0)`) is harmless either way: it cannot satisfy the rule
# on its own, and it cannot break a file that also has a real exit.
gate_fail=0
for entry in "${SUITE[@]}"; do
  f="${entry#*:}"; path="scratchpad/$f"
  [ -f "$path" ] || continue
  # Idiom 1: `process.exitCode = …`, which Node honours when the script ends normally.
  # sandbox-symlink-authorizer-probe.mts uses this and reports failure perfectly well —
  # an earlier version of this gate flagged it, which is exactly the kind of false
  # positive that gets a check switched off. Accept it.
  grep -qaE 'process\.exitCode[[:space:]]*=' "$path" 2>/dev/null && continue
  # Idiom 2: every exit argument in the file; keep the ones that are NOT bare integers.
  if grep -aoE 'process\.exit\([^)]*\)' "$path" 2>/dev/null \
     | sed -E 's/^process\.exit\(//; s/\)$//' \
     | grep -qvE '^[[:space:]]*[0-9]+[[:space:]]*$'; then
    continue
  fi
  printf 'GATE  %-42s      cannot report failure — no result-dependent process.exit()\n' "$f"
  gate_fail=$((gate_fail+1)); fail=$((fail+1)); failed+=("$f(gate)")
done
[ $gate_fail -gt 0 ] && echo
foreign_skipped=0; passed_files=()
for entry in "${SUITE[@]}"; do
  need="${entry%%:*}"; f="${entry#*:}"
  name="${f%.*}"; path="scratchpad/$f"

  if [ "${ALL:-0}" != "1" ]; then
    # A test may need MORE THAN ONE prerequisite — join them with '+' (chrome+jupyter).
    # Before this, the field held a single token, so a test needing two could only record
    # one of them: notebook-ui-e2e drives a notebook THROUGH the browser, and registering
    # it as plain `chrome:` meant that on a machine with Chrome but no jupyter_server it
    # ran and reported FAIL for a missing prerequisite — the exact thing the header of
    # this file says a suite must never do, since it trains you to ignore red.
    blocked=""
    for req in ${need//+/ }; do
      case "$req" in
        chrome|srv4321) [ $have_chrome  = no ] && blocked="no chrome binary" ;;
        jupyter)        [ $have_jupyter = no ] && blocked="python3 cannot import jupyter_server" ;;
        claude)         [ $have_claude  = no ] && blocked="no claude on PATH" ;;
      esac
    done
    if [ -n "$blocked" ]; then
      printf 'SKIP  %-42s      %s\n' "$f" "$blocked"; skip=$((skip+1)); continue
    fi
  fi
  [ -f "$path" ] || { printf 'SKIP  %-42s      file missing\n' "$f"; skip=$((skip+1)); continue; }
  # Lazily start the shared server the first time an srv4321 test is about to run, and
  # STOP it before anything else runs: super-editor-test and clear-race-test bind :4321
  # themselves (a static proxy in front of their own API port), so leaving it up gives
  # them EADDRINUSE. The srv4321 entries are kept contiguous in SUITE so this is one
  # start/stop cycle, not thrash.
  # MEMBERSHIP test, not equality. The field may be a '+'-joined list (srv4321+claude), and
  # `= srv4321` silently missed those: the server would not start, the test would navigate
  # to a dead port, and the red would look like a UI failure — the exact outcome this block
  # exists to prevent. Proven by reverting to `=`, which reproduces that red.
  case "+$need+" in *+srv4321+*) needs_shared=yes ;; *) needs_shared=no ;; esac
  if [ "$needs_shared" = yes ]; then
    [ -z "$SRV_PID" ] && [ "$FOREIGN_4321" = no ] && { start_shared_server || true; }
    # A foreign :4321 is a PREREQUISITE failure, not a test failure — same treatment as a
    # missing Chrome. Skipping is the whole point: running them is what produces the wrong
    # numbers this guard exists to prevent.
    if [ "$FOREIGN_4321" = yes ]; then
      printf 'SKIP  %-42s      :4321 held by another process (set ALLOW_FOREIGN_4321=1 to override)\n' "$f"
      skip=$((skip+1)); foreign_skipped=$((foreign_skipped+1)); continue
    fi
  else
    [ -n "$SRV_PID" ] && { stop_shared_server; echo "shared :4321 server stopped (port released)"; }
  fi

  case "$f" in *.mts) cmd=(npx tsx "$path") ;; *) cmd=(node "$path") ;; esac
  start=$SECONDS
  timeout 300 "${cmd[@]}" >"$LOGDIR/$name.log" 2>&1
  rc=$?
  dur=$((SECONDS-start))
  if [ $rc -eq 0 ]; then
    printf 'PASS  %-42s %3ds\n' "$f" "$dur"; pass=$((pass+1)); passed_files+=("$f")
  else
    [ $rc -eq 124 ] && why="TIMEOUT(300s)" || why="rc=$rc"
    printf 'FAIL  %-42s %3ds  %s\n' "$f" "$dur" "$why"; fail=$((fail+1)); failed+=("$f")
  fi
done

echo
MOVED=""
for t in $FP_TREES; do
  [ -d "$t" ] || continue
  was=$(printf "$FP_BEFORE" | awk -v t="$t" '$1==t{print $2}')
  now=$(tree_fp "$t")
  [ "$was" = "$now" ] || MOVED="$MOVED $t"
done

echo "=== $pass passed, $fail failed, $skip skipped (logs: $LOGDIR) ==="
exp_hit=(); unexp=()
for f in "${failed[@]}"; do
  if expected_red_kind "${f%(gate)}" >/dev/null 2>&1; then exp_hit+=("$f"); else unexp+=("$f"); fi
done
if [ ${#exp_hit[@]} -gt 0 ]; then
  if [ ${#exp_hit[@]} -eq 1 ]; then echo "  1 of those is an EXPECTED RED — documented, not a regression:"
  else echo "  ${#exp_hit[@]} of those are EXPECTED REDS — documented, not regressions:"; fi
  for f in "${exp_hit[@]}"; do
    printf '    [%s] %-38s %s\n' "$(expected_red_kind "$f")" "$f" "$(expected_red_why "$f")"
  done
fi
if [ ${#unexp[@]} -gt 0 ]; then
  echo "  UNEXPECTED failures (${#unexp[@]}): ${unexp[*]}"
else
  [ $fail -gt 0 ] && echo "  no unexpected failures — every red in this run is a documented one."
fi
# An expected red that PASSES is not good news to be filed away: it means the work landed and
# the banner above is now a stale post-mortem describing a defect that no longer exists —
# the exact hazard that had a fixed data-dir bug reading as a live one for months. Say so.
for e in "${EXPECTED_RED[@]}"; do
  ef="${e%%|*}"
  for pf in "${passed_files[@]}"; do
    [ "$pf" = "$ef" ] && echo "!!! $ef is listed as an EXPECTED RED but PASSED — the work it documents has landed. Remove its EXPECTED_RED entry before that banner starts hiding a real regression."
  done
done
# SAY IT IN THE SUMMARY, not only where it happened. "55 passed, 0 failed, 15 skipped" read
# without the scrollback looks like a healthy run; it is a run that silently did not test
# nine things.
if [ -n "$MOVED" ]; then
  echo "!!! THIS TOTAL IS NOT A BASELINE —$MOVED changed during the run."
  # mtime finds the culprits; it cannot prove innocence (a file written during the run AND
  # again afterwards shows only the later stamp), so this is a floor on what moved, not a
  # complete list. Say so rather than let the list read as exhaustive.
  for t in $MOVED; do
    # Same node_modules prune as tree_fp: `web` is now a fingerprinted tree, and without this
    # a single real culprit would be listed among thousands of dependency files — a report
    # nobody reads is the same as no report.
    find "$t" -type d -name node_modules -prune -o -type f -newermt "@$RUN_T0" \
      -printf '!!!   %p written %TH:%TM:%.2TS (mid-run)\n' 2>/dev/null
  done
  echo "!!! (files listed by mtime — a floor, not a complete list: mtime records only the LAST write.)"
fi
# BUCKET1_STALE was set at the top of the run and then READ BY NOTHING — the banner scrolled
# past and the summary went on to report a clean-looking total for a run in which eleven
# harnesses tested a bundle nobody had rebuilt. Same argument as the fingerprint stamp four
# lines up: the last line is the only line most people read, so a caveat that lives only in
# the scrollback is a caveat that does not exist.
if [ "$BUCKET1_STALE" = yes ] && [ "${b1_in_run:-0}" -gt 0 ]; then
  echo "!!! BUCKET 1 WAS NOT INTERPRETABLE THIS RUN — the $b1_in_run harnesses served by web/dist"
  echo "!!!   neither passed nor failed meaningfully. Their greens are worth exactly as much as"
  echo "!!!   their reds. See the banner at the top of this run for which inputs moved."
fi
if [ "${foreign_skipped:-0}" -gt 0 ]; then
  echo "!!! $foreign_skipped shared-server tests DID NOT RUN — :4321 was held by another process."
  echo "!!! This total is not a baseline. Free the port and re-run (or ALLOW_FOREIGN_4321=1)."
fi
[ $fail -gt 0 ] && printf 'failed: %s\n' "${failed[*]}"
exit $(( fail > 0 ? 1 : 0 ))
