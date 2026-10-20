---
name: design
description: Design the screens a phase lists in screens.md, export them, and have an independent design-reviewer check the exports until they pass. Use for phases with UI, before approval.
argument-hint: "<NN>"
---

Design phase $ARGUMENTS.

1. Read `phases/phase-NN-*/screens.md`, `docs/design/README.md` and `docs/design/tokens.md` if they exist. Create `docs/design/README.md` from `${CLAUDE_PLUGIN_ROOT}/templates/design-README.md` if it is missing.
2. Design as a principal product designer would, from the user's point of view: who opens this screen, what job they came to do, and what they must understand in the first five seconds. Design every screen and state listed, with whatever design tool is connected (Pencil, Figma). With none, build static HTML mocks and screenshot them.
3. Export each screen to `docs/design/exports/<ID>-<name>.png`. Open each export with Read before going on; a blank or cropped export is not done.
4. Update the screens table in `docs/design/README.md`.
5. Review. Send `phaseproof:design-reviewer` the screens.md path, the design README and tokens, and the export paths. Save its reply verbatim to `.phaseproof/reviews/phase-NN-design.md`.
6. On FAIL, fix and review again with a fresh reviewer, at most two fix rounds, then stop and show the owner what is open.
7. On PASS, tell the owner the next step is their approval: `/phaseproof:approve NN`.
