---
name: build
description: Build the approved phase - builder agent writes code and tests, checks run, an independent code-reviewer on a stronger model checks the diff, then the gate closes the phase. Use after the owner approved a phase.
argument-hint: "[NN]"
---

Build the current phase.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" status`. If it is not approved, stop and say so. Read the approval's `head` from `.phaseproof/approvals/phase-NN.json`; it is the review base.
2. Send `phaseproof:builder` the paths to the phase's `scope.md` and `tasks.md` and the README. Large phases may go task section by task section.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" check`. On failure, send the output back to the builder.
4. Review. Send `phaseproof:code-reviewer` the scope.md and tasks.md paths and the base commit, and nothing about how the build went. Save its reply verbatim to `.phaseproof/reviews/phase-NN-code.md`. Never edit, trim or summarise a review.
5. On FAIL, send the blockers to the builder, then review again with a fresh reviewer. At most two fix rounds. If it still fails, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" block`, stop, and show the owner the open blockers with their two options: fix the scope and get it re-reviewed with `/phaseproof:phase`, or run `/phaseproof:approve NN` to give the builder another round.
6. Close the phase: `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" gate NN`. The script re-runs every check itself; if it refuses, go back to step 3.
7. Write `progress.md` and `gate.md` in the phase folder from `${CLAUDE_PLUGIN_ROOT}/templates/`, with the real command output in "Verification transcript". Update the README and WORKLIST.
8. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" next`, then tell the owner in a few lines: what shipped, the gate result, what is next.
