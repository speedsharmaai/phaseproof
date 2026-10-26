# phaseproof

![phaseproof: make the AI build in phases. Code stays locked until you approve the phase.](.github/assets/header-light.png#gh-light-mode-only)
![phaseproof: make the AI build in phases. Code stays locked until you approve the phase.](.github/assets/header-dark.png#gh-dark-mode-only)

[![ci](https://github.com/speedsharmaai/phaseproof/actions/workflows/ci.yml/badge.svg)](https://github.com/speedsharmaai/phaseproof/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-1F5A44)](LICENSE)
[![version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fspeedsharmaai%2Fphaseproof%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=1F5A44)](CHANGELOG.md)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-1F5A44)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/speedsharmaai/phaseproof/badge)](https://scorecard.dev/viewer/?uri=github.com/speedsharmaai/phaseproof)

**A Claude Code plugin that makes AI build in phases.** Docs first, design next, code only after you approve, and every phase checked by an independent reviewer agent on a stronger model before it closes.

A phase is done when its "Done when" line is true on the running system, not when its code compiles.

```
/plugin marketplace add speedsharmaai/phaseproof
/plugin install phaseproof@phaseproof
```

## Why

Coding agents fail in the same few ways: they start writing code before anyone agreed what to build, they skip tests, they mark work done because it compiles, and they review their own work and like it.

phaseproof is the process I ran by hand across a dozen shipped projects, packed into one plugin:

1. **Docs before code.** Each phase gets a `scope.md` with a measurable "Done when" and a `tasks.md` where every section ends in a **Check:** you can run.
2. **A different model reviews.** Sonnet builds, Opus reviews. The reviewer sees the spec and the diff, not the builder's reasoning, and must answer `VERDICT: PASS | FAIL` with `file:line` evidence.
3. **You approve.** Code stays closed until the docs pass review and you run `/phaseproof:approve`.
4. **Checks are re-run, not trusted.** The gate script runs your test and typecheck commands itself before it closes a phase, refuses if the commands you approved were changed, and refuses if code changed after the code review was saved.
5. **Tests can be locked.** Acceptance tests written with the plan and listed under **Locked tests:** are approved with it. After that the builder has to make them pass instead of editing them.
6. **Ship with proof.** New build on a spare port, health check, swap, keyword check on the live URL, rollback written down.

## How a phase flows

![Eight steps per phase: plan, doc review, design, owner approval, build, code review, gate, ship. Reviews run on Opus and loop back on FAIL, at most twice.](.github/assets/flow-light.png#gh-light-mode-only)
![Eight steps per phase: plan, doc review, design, owner approval, build, code review, gate, ship. Reviews run on Opus and loop back on FAIL, at most twice.](.github/assets/flow-dark.png#gh-dark-mode-only)

## What you see

![Claude Code output: a Write to src/auth/otp.ts is refused because phase 01 is not approved; after /phaseproof:approve 01 code is open.](.github/assets/terminal-light.png#gh-light-mode-only)
![Claude Code output: a Write to src/auth/otp.ts is refused because phase 01 is not approved; after /phaseproof:approve 01 code is open.](.github/assets/terminal-dark.png#gh-dark-mode-only)

## Commands

| Command | What it does |
|---|---|
| `/phaseproof:kickoff [idea]` | README with the one number and rules, phase list, first ADR, gate turned on |
| `/phaseproof:phase NN name` | Writes the phase's scope and tasks, doc-reviewer checks them |
| `/phaseproof:quick what` | Small change, light process: one-screen scope, you approve with `--quick`, one code review, gate |
| `/phaseproof:design NN` | Designs and exports the phase's screens, design-reviewer checks the exports |
| `/phaseproof:approve NN [--quick]` | Owner sign-off. `--quick` skips the docs review for a small change. Claude cannot run it for you |
| `/phaseproof:build` | Builder, checks, code-reviewer, gate, progress notes |
| `/phaseproof:ship [env]` | Dry run, spare-port boot, deploy on your go, live check, rollback |
| `/phaseproof:status` | Where the phase stands and the one next step |

## Model routing

![haiku reads, sonnet builds, opus judges.](.github/assets/routing-light.png#gh-light-mode-only)
![haiku reads, sonnet builds, opus judges.](.github/assets/routing-dark.png#gh-dark-mode-only)

Every agent pins its own model, so you never switch with `/model` by hand. Cheap models read, the default model builds, the strong model judges.

| Agent | Model | Effort | Job |
|---|---|---|---|
| researcher | haiku | medium | web lookups with sources |
| explorer | haiku | medium | read-only codebase map |
| builder | sonnet | medium | code and tests for one phase |
| doc-reviewer | opus | high | scope and tasks |
| design-reviewer | opus | high | screen exports against screens.md |
| code-reviewer | opus | high | diff against the phase, runs checks |
| ship-verifier | sonnet | medium | dry run, boot, health and live checks |

This follows Anthropic's own split: Haiku for simple tasks, Sonnet for daily coding, Opus for complex reasoning ([model config docs](https://code.claude.com/docs/en/model-config)). Reviewers run on a stronger model than the builder because a model is bad at catching its own mistakes.

Each agent also carries a senior role and judges from the user's seat: the design reviewer checks what a new user understands in the first five seconds, the code reviewer reads as the on-call engineer and the next maintainer, the doc reviewer checks that the phase names who it is for and what they can do afterwards.

To run an agent on a different model, copy its file from `agents/` into `~/.claude/agents/`, change `model:`, and your copy takes priority over the plugin's.

## What the gate does and does not stop

When `.phaseproof/state.json` exists in a project, a `PreToolUse` hook:

- blocks `Write`, `Edit`, `MultiEdit` and `NotebookEdit` on code until the current phase is approved, and again after its gate passes
- closes code again when `scope.md`, `tasks.md` or `screens.md` change after approval; re-approving a full phase then needs a fresh docs review. Only the owner makes a phase quick, with `approve --quick`; nothing in scope.md can. Each phase number may have one folder
- closes code when a phase is blocked after two failed code reviews, until the owner approves it again
- keeps locked tests closed: before the phase's first approval, files listed under **Locked tests:** in scope.md may be written if they look like test files, are not committed yet, and have no symlink in their path; an existing test stays closed. Once approved, every locked test is closed to file tools, even inside `docs/` or `phases/` and even if it is later taken off the list. Adding a locked test to an approved phase is the owner's job: they write it, list it, and approve again. Their contents are part of the approved scope, so a shell edit or deletion closes code and the gate until the owner approves again, and the message names the file. Line endings are ignored. Approval refuses a locked test that is missing, outside the project, absolute, behind a symlink, cased differently from the file on disk, or not a test
- closes code and refuses the gate when the checks or doc paths in `.phaseproof/config.json` change after approval; until the owner approves again, only the default doc paths count as docs, so widening them opens nothing. `approve` prints the commands it binds, and any non-default doc paths, so you see what you are signing. This binds the command text, not what it runs: an edited `npm test` script, or a runner config that excludes a file, changes what runs without changing the command. The code reviewer is told to run the locked tests itself and to flag such edits. Approvals from before 0.5 have no record of the config and are not checked
- always allows Markdown, `docs/`, `phases/` and `design/`
- blocks writes to `.phaseproof/gates`, `approvals`, `runs` and `blocks`, by file tools or by Bash, and blocks running `approve` from Bash
- catches shell writes: while code is closed, a `PreToolUse` hook records `git status` before every Bash call and `PostToolUse` / `PostToolUseFailure` hooks compare it after. If the command changed, committed or wiped code (including your own uncommitted changes), Claude is told which files and asked to stop and wait for you, and you get a notice too. phaseproof itself never modifies or deletes a file, and never tells Claude to run a destructive fix

Saving the code review with the Write or Edit tool records the code as it is at that moment: the paths that differ from the approval's base, with a hash of each. Saving the review file again records again. The gate compares that record with the code as it is. Any recorded file that was changed, reverted or deleted afterwards, and any tracked file that newly differs, refuses the gate and names the file; an untracked file that only appears afterwards (coverage output, snapshots) warns. Staging or committing reviewed code is not a change, but a pre-commit hook or a check that rewrites tracked files is: commit or gitignore that output before the review. A review saved some other way, or a git call that failed, gets a warning that says why instead of a comparison. The record trusts that whoever saves the review file just ran the review: saving an old PASS again after changing code makes the gate accept that code. Commits inside a submodule are not compared.

The gate script also compares test files with the first approval and prints warnings, without blocking, for tests that look deleted and for newly added skip or focus markers (`.skip`, `.only`, `xit`, `@pytest.mark.skip`, `#[ignore]` and similar). Renames that are committed, staged, or unchanged moves are recognised; a test moved and edited without staging shows up as a possible deletion until you `git add` it. Files the owner lists under **Removes tests:** in scope.md (comma-separated or as a bullet list, paths relative to the project folder; a path ending in `/` covers a folder) are left out. Tests inside git submodules, outside a sparse checkout, in gitignored files, or behind a git clean filter are not compared reliably, and each git call gives up after 20 seconds with a warning. These checks warn rather than block because git has too many ways to move a file for a pattern to be certain; the code reviewer and you make the call.

At the start of every session, and after `/compact`, `/clear` or a resume, a `SessionStart` hook puts the current phase, its Goal and Done when, and whether code is open back into Claude's context, so a long session does not drift off the plan.

In any project without `.phaseproof/state.json` it does nothing. If the hook gets input it cannot parse, it allows the call rather than locking your session.

Locked tests stop edits to the listed files. They do not stop code that special-cases those tests to pass, or a change to the test script or runner config that stops them running; the code reviewer is told to treat both as blockers, and that is a model's judgement, not a guarantee. Fixtures and mocks the tests use cannot be locked.

It is a guardrail against drift, not a security boundary. The shell guard detects writes after the fact; it does not prevent or undo them. It only sees what `git status` sees: gitignored or excluded paths, files marked assume-unchanged, changes inside nested repos, files outside the project, background and detached processes, commands interrupted before they finish, a command that deletes `.git` or the guard's own records, and network calls are out of its reach. Files over 1 MB, and runs with more than 2000 dirty files, are compared by size and modification time only, so a same-size rewrite that keeps the timestamp goes unnoticed. It cannot tell who made a change, so an edit you save in your editor during a command is reported too. For real prevention, use an OS-level sandbox. A review report is model output like any other. What it reliably stops is the common failure: an agent that skips the plan, skips the review, or calls a phase done with red tests.

## What it writes in your project

```
your-project/
├── README.md                     one number, rules, phases table
├── WORKLIST.md                   now, next, waiting on the owner
├── docs/
│   ├── decisions/0001-stack.md   ADRs
│   ├── learnings.md              what earlier phases taught, read before planning and review
│   └── design/                   screens table, tokens, exports/
├── phases/
│   ├── README.md                 order and the kill line
│   └── phase-01-auth/
│       ├── scope.md              Goal, Done when, in and out of scope
│       ├── tasks.md              sections, each ending in a Check
│       ├── screens.md            if the phase has UI
│       ├── progress.md           verification transcript
│       └── gate.md               criteria table and the call
└── .phaseproof/
    ├── config.json               the check commands
    ├── state.json                current phase
    ├── reviews/                  reviewer reports, verbatim
    ├── approvals/                owner sign-offs
    ├── runs/                     last check results, what code the review saw
    ├── blocks/                   phases stopped after two failed reviews
    └── gates/                    closed phases, with check results and review hashes
```

Commit `.phaseproof/` with the code. The approvals and gates are the audit trail.

## What it runs and sends

- `scripts/session.mjs` runs at session start and after compact, clear or resume. It reads `.phaseproof/` and `phases/` and prints a short status for Claude; it writes nothing.
- The hook runs `node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs` before file edits and Bash calls. It reads files under `.phaseproof/` in your project and prints an allow or deny decision. It makes no network calls.
- After a Write or Edit to `.phaseproof/reviews/phase-NN-code.md`, `scripts/post.mjs` runs `git diff --name-only`, `git ls-files --others` and `git hash-object --stdin-paths` (without writing objects) and records paths and hashes, no file contents, in `.phaseproof/runs/`. For any other file it does nothing.
- While code is closed, `scripts/hook.mjs` and `scripts/post.mjs` run `git status`, `git rev-parse` and `git diff --name-only` around Bash calls to find shell writes to code. They write only short-lived records to `phaseproof/` inside the git directory (`.git/phaseproof/`, or the worktree's or submodule's own git dir), holding paths, sizes and hashes but no file contents, and never change your files.
- At gate time the test guard runs read-only git commands (`ls-tree`, `ls-files`, `diff -M`, and `hash-object --stdin-paths` without writing) to compare test files with the approval. It writes nothing to your repository.
- `scripts/phaseproof.mjs` reads and writes files under `.phaseproof/`, and runs `git rev-parse HEAD` to record the commit.
- `check` and `gate` run the commands you list in `.phaseproof/config.json` (your tests, typecheck, lint) through your shell, in your project directory. Nothing else is executed.
- No telemetry, no data leaves your machine, no packages are downloaded. The researcher and ship-verifier agents use Claude's own WebSearch and WebFetch tools when a skill asks them to.

## Requirements

- Claude Code with plugin support, and Node.js 20 or later on `PATH` (the hook and the gate script are plain Node, no dependencies)
- Access to the models the agents pin. On a plan without Opus, change the reviewers' model as above.

## Privacy

No server, no telemetry, nothing collected. See [PRIVACY.md](PRIVACY.md).

## Status

v0.5.0. The gate script, the hook and their tests are done. The skills and agents are new and will change as they get used on real projects. Issues and PRs are welcome.

## Related projects

- [obra/superpowers](https://github.com/obra/superpowers): a broad skills library for Claude Code
- [github/spec-kit](https://github.com/github/spec-kit): spec-driven development toolkit
- [dsnger/dev-workflow-kit](https://github.com/dsnger/dev-workflow-kit): spec-driven workflow with cross-model review gates

## License

MIT
