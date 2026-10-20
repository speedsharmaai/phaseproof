---
name: kickoff
description: Start a project the phaseproof way - one number, rules, phase list, first ADR, and the gate turned on. Use when the user starts a new project or wants to put an existing one under phase gates.
argument-hint: "[one-line idea]"
---

Set up the project in the current directory. Idea from the user: $ARGUMENTS

If the project already has a README and a `phases/` folder, don't rewrite them. Find the first phase that isn't done and start there with `init --phase NN`.

If the project already has code but no phaseproof docs, adopt it instead of templating it:
- send `phaseproof:explorer` first to map the stack, folder layout, test setup, lint and type config, and the conventions the code actually follows
- write the README rules and `docs/decisions/0001-<stack>.md` from what the code does today (Status: Accepted, recorded from the existing code), not from the template's placeholders
- take the check commands from the project's own scripts (package.json, Makefile, pyproject, CI config)
- the first phase is the change the owner wants next, not a rewrite

1. Ask the owner, in one round, only what you cannot infer:
   - who it is for and what it does for them
   - the one number that says it worked, with a deadline
   - rules that must never break
   - stack, and the commands that prove the code works (tests, typecheck, lint, build)
2. If the idea depends on facts outside the repo (competitors, prices, APIs), send `phaseproof:researcher`. If code already exists, send `phaseproof:explorer`. Run them in parallel.
3. Write from the templates in `${CLAUDE_PLUGIN_ROOT}/templates/`, keeping their headings:
   - `README.md` from `README.md`. If a README already exists, write `docs/brief.md` instead and leave the README alone.
   - `WORKLIST.md` from `WORKLIST.md`
   - `phases/README.md` from `phases-README.md`, with an honest kill line
   - `docs/decisions/0001-<stack>.md` from `adr.md`
4. Turn the gate on, passing every check command:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" init --check "<cmd>" --check "<cmd>"` (add `--phase NN` for an existing project)
5. Tell the owner in three lines what was written and that the next step is `/phaseproof:phase 01 <name>`.

Write no application code here. The gate blocks it anyway until phase 01 is approved.
