---
name: report
description: Show what phaseproof caught in this project - phases closed, review rounds, failed reviews, blockers found and gate warnings, phase by phase. Use when the user asks how the process is going or what the reviews found.
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" report` and show its output as it is.

Then add at most three lines: the phase with the most failed reviews and its most common kind of blocker, if `.phaseproof/reviews/` shows one, and anything in `docs/learnings.md` that keeps coming back.
