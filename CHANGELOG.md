# Changelog

## 0.5.0 - 2026-10-26

- Locked tests: acceptance tests listed under `**Locked tests:**` in scope.md can be written while the phase is planned, are reviewed with the docs, and are closed to edits once the owner approves. Their contents are part of the approved scope, so changing or deleting them by any route closes code and the gate until the owner approves again, and the message names the file
- The gate refuses when the check commands or doc paths in `.phaseproof/config.json` changed after approval, and `approve` prints the commands it binds. Before, a builder could replace the test command and the gate would re-run that instead. What a command runs (an npm script, runner config) is not bound
- The gate refuses when reviewed code changed after the code review was saved, and names the files. Untracked files that only appear afterwards warn. The record is made when the review is saved with the Write or Edit tool
- Empty doc paths in config.json no longer make every file a doc
- Locked paths are matched without regard to case or Unicode form on every system, and through symlinks; `approve` names locks dropped since the previous approval
- If the review was recorded but the code cannot be read now (or git times out), the gate refuses and says why; files hidden with assume-unchanged or skip-worktree get a warning
- The gate record has a new `warnings` field with every warning; `testWarnings` keeps only the test guard's
- Approvals made before 0.5 have no config hash and are not checked against config changes
- The code reviewer reports each "Done when" criterion as verified or not, with the evidence, and treats code that special-cases locked tests as a blocker
- The doc reviewer checks that locked tests test what "Done when" promises

## 0.4.0 - 2026-10-20

- `/phaseproof:quick` for small changes: the owner approves with `approve --quick`, which skips the docs review; one code review and the gate still apply. Nothing in scope.md can make a phase quick
- Test guard: at gate time, tests that look deleted since the first approval and new skip or focus markers (JS/TS, Python, Go, Ruby, Rust, JVM, C#, Swift) are printed as warnings and recorded in gate.json. They do not block: after seven review rounds, every blocking version either had a bypass or refused legitimate work
- SessionStart hook re-states the current phase, its goal and whether code is open after startup, compact, clear and resume
- Existing codebases: kickoff maps the repo first and records the stack and conventions it actually has
- `docs/learnings.md`: each phase records what the reviewer caught; planning and both reviewers read it
- Code reviewer flags weakened tests and quick scopes that were really full phases

## 0.3.0 - 2026-10-20

- Shell guard: while code is closed, every Bash call is bracketed by a git snapshot and a diff. If the command changed, committed or wiped code, Claude is told which files and asked to stop and wait, and the owner gets a notice. Covers failing commands too (`PostToolUseFailure`)
- phaseproof never changes or deletes a file for this, and never suggests a destructive fix. An automatic rollback and an "undo it" message were built first and dropped after independent reviews found ways each could destroy uncommitted work
- Snapshots live in `.git/phaseproof/`, outside the working tree, so `git clean` and `git stash` cannot remove them and nothing is added to your project

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
