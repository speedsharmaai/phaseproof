# Changelog

## 0.2.2 - 2026-10-20

- Every agent gets a senior role and user-first checks: first five seconds, one primary action, plain copy, useful empty and error states, contrast and tap targets, failure behaviour the user sees, slow paths
- The design skill designs from the user's point of view

## 0.2.1 - 2026-10-20

- `init --phase NN` starts an existing project at the phase it is on
- kickoff adopts a project that already has a README and phases/ instead of rewriting them

## 0.2.0 - 2026-10-20

- A second failed code review blocks the phase: code closes and the gate refuses until the owner approves again
- Approval records a hash of scope.md, tasks.md and screens.md; editing them closes code, and re-approving needs a fresh docs review
- `status` shows a blocked phase and a stale approval

## 0.1.1 - 2026-10-20

- Plugin icon for the directory listing
- approve skill allows only its own command; status runs through the normal permission flow
- Hook reads only CLAUDE_PROJECT_DIR from the environment
- README lists what the plugin runs and sends

## 0.1.0 - 2026-10-20

- Gate script: init, status, approve, check, gate, next
- PreToolUse hook that keeps code closed until a phase is approved
- Skills: kickoff, phase, design, approve, build, ship, status
- Agents: researcher, explorer, builder, doc-reviewer, design-reviewer, code-reviewer, ship-verifier
- Templates for README, WORKLIST, ADR, phase scope, tasks, progress, gate, screens
