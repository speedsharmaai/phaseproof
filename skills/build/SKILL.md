---
name: build
description: Build the approved phase - builder agent writes code and tests, checks run, an independent code-reviewer on a stronger model checks the diff, then the gate closes the phase. Use after the owner approved a phase.
argument-hint: "[NN]"
---

Build the current phase.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" status`. If it is not approved, stop and say so. Read `base` from `.phaseproof/approvals/phase-NN.json` (older approvals only have `head`); it is the review base.
2. Send `phaseproof:builder` the paths to the phase's `scope.md` and `tasks.md` and the README. Large phases may go task section by task section.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" check`. On failure, send the output back to the builder.
4. Review. Send `phaseproof:code-reviewer` the scope.md and tasks.md paths, `docs/learnings.md` if it exists, and the base commit, and nothing about how the build went. Save its reply verbatim to `.phaseproof/reviews/phase-NN-code.md` with the Write tool: saving it that way records which code it reviewed. Never edit, trim or summarise a review, and do not change code after a passing review.
5. On FAIL, send the blockers to the builder, then review again with a fresh reviewer. Before the fix, note the commit or run `git stash create` to mark the reviewed state; give the new reviewer the previous review's blockers and that marker, so it checks each blocker and reads the diff since the last review first (plus `git status` for files the fix added), and the full diff only where the fix reaches. Its verdict still covers the whole phase. At most two fix rounds. If it still fails, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" block`, stop, and show the owner the open blockers with their two options: fix the scope and get it re-reviewed with `/phaseproof:phase`, or run `/phaseproof:approve NN` to give the builder another round.
6. Close the phase: `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" gate NN`. The script re-runs every check itself; if it refuses on checks, go back to step 3. If it says code changed after the code review was saved, run step 4 again on the current code. If it prints "check before trusting this gate", go through each warning: restore a test you deleted by mistake, stage a move with `git add -A`, remove a skip or focus you added by mistake, then run the gate again. Tell the owner about anything that is intended; never edit scope.md to silence a warning yourself.
7. Write `progress.md` and `gate.md` in the phase folder from `${CLAUDE_PLUGIN_ROOT}/templates/`, with the real command output in "Verification transcript". Update the README and WORKLIST. Append what this phase taught to `docs/learnings.md` (create it from `${CLAUDE_PLUGIN_ROOT}/templates/learnings.md`): every blocker the reviewer found and the check that would have caught it earlier, one line each.
8. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" next`, then tell the owner in a few lines: what shipped, the gate result, what is next.
