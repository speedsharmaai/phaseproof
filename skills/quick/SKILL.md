---
name: quick
description: Small change, light process - one-screen scope, owner approval, build, one code review, gate. Use for fixes and small edits that touch a few files and no data model, auth, money or migrations. Bigger work goes through /phaseproof:phase.
argument-hint: "<what to change>"
---

Small change requested: $ARGUMENTS

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" status`. Use the current phase number only if that phase has no folder yet. If it already has one (planned, approved or building), never create a second folder with the same number: the fix either waits until that phase passes its gate, or goes into that phase's scope and the owner re-approves.
2. Decide if this is really small: a few files, no new data model, auth, payments, deletes or migrations, nothing a user would need to relearn. If not, say so and use `/phaseproof:phase` instead.
3. Write `phases/phase-NN-<short-name>/scope.md` with exactly these lines and nothing more than the change needs:
   - `**Size:** quick`
   - `**Goal:** ...`
   - `**Done when:** ...` something you can observe
   - `**Check:** ...` the command or action that proves it
4. Show the owner the scope in three lines and ask them to run `/phaseproof:approve NN`. You cannot approve it.
5. After approval: make the change with tests, run the scope's **Check:** yourself and `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" check`, then send `phaseproof:code-reviewer` the scope path, the Check output, and the approval's `base` commit from `.phaseproof/approvals/phase-NN.json`. Save its reply verbatim to `.phaseproof/reviews/phase-NN-code.md`. One fix round at most; if it still fails, run the `block` command and stop.
6. `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" gate NN`, then `next`. Add a line to `docs/learnings.md` only if the review caught something worth remembering.
