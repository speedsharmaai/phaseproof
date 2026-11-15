# Changelog

## 0.7.1 - 2026-11-15

- Ticking a box in tasks.md no longer closes code. Before, the builder's first `- [x]` made the approval stale and the gate refused with "scope changed". Only tasks.md boxes are folded; a box in scope.md or screens.md is still a scope change. CRLF line endings in the phase docs no longer count as a change. A 0.7.0 approval stays valid and can be re-approved as it is, but if it was made with boxes already ticked, or on CRLF files, the next tick closes code once and needs one more approval
- Every command and hook finds the project from a subfolder (the nearest `.phaseproof/state.json` above). Before, the CLI said "not tracked yet" after any `cd`, and following its advice made a second `.phaseproof/` inside the project. `init` now refuses there. This also means a Claude Code session opened in a subfolder of a tracked project is now gated, where before phaseproof did nothing there. `doctor` names the folder it is using
- `.phaseproof/` records are protected under every spelling the file system folds to that folder: any letter case (including the long s, `ſ`, which macOS folds to `s`), trailing dots or spaces, NTFS stream suffixes and the 8.3 short name on Windows. A path that spells the project folder itself differently (another letter case, or through a symlink such as `/tmp` for `/private/tmp`) now counts as inside the project, for code and records alike; before, it was treated as outside and allowed. Before, a write to `.PhaseProof/approvals/...` on macOS or Windows landed in `.phaseproof/` and was allowed. Reviews must be saved under the exact path `.phaseproof/reviews/`
- A failing check prints its last 20 lines under the FAIL line
- A check is stopped after 10 minutes, together with every process it started, and counted as failed, instead of hanging the gate. Interrupting `check` or `gate` stops the running check too
- An empty or broken `state.json` gives a clear message pointing at `doctor` instead of a TypeError
- `approve` says when there is no git repository or no commit yet, and which protections are off because of it. Kickoff asks for a git repository with one commit
- The review parser reads `**VERDICT:** PASS` and `` `VERDICT: FAIL` ``, ignores the template line `VERDICT: PASS | FAIL`, reads `VERDICT: FAILED` as FAIL, and counts numbered and bold blockers. A review with a FAIL verdict line anywhere is a FAIL, even if another line says PASS
- `init` and `approve` write the `merge=union` rule for the review history to `.phaseproof/.gitattributes`, as the README already said
- `init` on a tracked project with `--check` says the checks were not changed and where to edit them
- The session context is put back after a fork (`/fork`, `/branch`, `--fork-session`) too
- `doctor` warns when `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` makes Claude Code ignore the reviewers' `model: opus`

## 0.7.0 - 2026-10-27

- `/phaseproof:doctor` checks Node, git, the plugin's hooks, config, checks, the phase folder and scope, locked tests, a stale or lost approval, an ignored `.phaseproof/` and piles of untracked output, and says what to fix
- `/phaseproof:report` shows what the process caught, phase by phase: review rounds, failed reviews, blockers found and gate warnings. Review history is recorded from this version on, one line per review saved

## 0.6.0 - 2026-10-27

- `**Gate runs:**` in scope.md: phase commands the gate runs itself next to the project's checks, approved with the scope. Point one at the locked tests and a changed project test command cannot drop them (runner config still can; see the README)
- `**Budget:**` in scope.md (`300 lines, 8 files`): the gate warns when the phase's code outgrows it, `status` shows how much is used, and the code reviewer treats unjustified overruns as a major
- A Stop hook asks Claude to fix red checks, or say plainly that they are red, before it finishes a turn with a failed check run and no code changed since. It asks once per failed run, so it cannot re-block turn after turn
- Re-reviews start from the previous review's blockers and the diff since that review, so a fix round costs less than the first review

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
