---
name: phase
description: Write one phase's scope.md and tasks.md, then have an independent doc-reviewer check them until they pass. Use when planning the next phase of a phaseproof project.
argument-hint: "<NN> <short-name>"
---

Plan phase $ARGUMENTS. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" status` first; plan only the current phase. Editing the scope of an approved phase closes code until the docs are reviewed again and the owner re-approves.

1. Read `README.md`, `phases/README.md`, accepted ADRs in `docs/decisions/`, `docs/learnings.md` if it exists, and the previous phase's `progress.md` ("Notes for later phases"). If the change is small, use `/phaseproof:quick` instead. If code exists, send `phaseproof:explorer` for the area this phase touches.
2. Create `phases/phase-NN-<name>/` with `scope.md` and `tasks.md` from `${CLAUDE_PLUGIN_ROOT}/templates/`. Keep their headings. "Done when" must be observable on the running system. Every task section ends with a **Check:** line.
3. If the phase has UI, also write `screens.md` from the template.
4. Add the phase to the README phases table if it is missing.
5. Review. Send `phaseproof:doc-reviewer` the paths to scope.md, tasks.md, the README, relevant ADRs and `docs/learnings.md`, and nothing else: no summary of your intent. Save its reply verbatim to `.phaseproof/reviews/phase-NN-docs.md`. Never edit, trim or summarise a review.
6. On FAIL, fix the blockers and review again with a fresh reviewer. At most two fix rounds. If it still fails, stop and show the owner the open blockers.
7. On PASS, tell the owner:
   - with `screens.md`: next is `/phaseproof:design NN`
   - without: next is their approval, `/phaseproof:approve NN`. You cannot approve for them.
