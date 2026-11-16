# phaseproof

![phaseproof: make the AI build in phases. Code stays locked until you approve the phase.](.github/assets/header-light.png#gh-light-mode-only)
![phaseproof: make the AI build in phases. Code stays locked until you approve the phase.](.github/assets/header-dark.png#gh-dark-mode-only)

**Claude Code can't write your code until you approve the plan.** Not a prompt asking it nicely: a hook refuses the write.

```
> Add OTP sign-in                                   (abridged session)

  Write(src/auth/otp.ts)
  ⎿  phaseproof: phase 01 is not approved, so code stays closed. Finish and
     review the phase docs, then the owner runs /phaseproof:approve 01.

  Writing phases/phase-01-sign-in/scope.md and tasks.md instead.
  Sending them to the doc reviewer (Opus)... VERDICT: PASS

> /phaseproof:approve 01
  phase 01 approved. Code is open for this phase. The gate will run: npm test.

  Write(src/auth/otp.ts)
  ⎿  Wrote 48 lines
```

Only you can approve. "Just write the code" in chat does not count: the approve skill is owner-only, and the hook refuses it from Bash. After approval, Sonnet builds, Opus reviews the diff against the plan, and the gate re-runs your tests itself before the phase can close.

```
/plugin marketplace add speedsharmaai/phaseproof
/plugin install phaseproof@phaseproof
```

Then, in your project:

```
/phaseproof:kickoff a habit tracker for runners    (or run it in an existing repo to adopt it)
/phaseproof:phase 01 sign-in                       scope and tasks, checked by a reviewer
/phaseproof:approve 01                             you sign off; Claude cannot
/phaseproof:build                                  build, code review, gate
```

Small change? `/phaseproof:quick` skips the planning ceremony and keeps one review and the gate. Something odd? `/phaseproof:doctor`.

[![ci](https://github.com/speedsharmaai/phaseproof/actions/workflows/ci.yml/badge.svg)](https://github.com/speedsharmaai/phaseproof/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-1F5A44)](LICENSE)
[![version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fspeedsharmaai%2Fphaseproof%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=1F5A44)](CHANGELOG.md)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-1F5A44)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/speedsharmaai/phaseproof/badge)](https://scorecard.dev/viewer/?uri=github.com/speedsharmaai/phaseproof)

Plain Node, no dependencies, and the plugin's own code makes no network requests ([privacy](PRIVACY.md)). The hooks never modify or delete your files; when something looks wrong they stop and tell you. See the [changelog](CHANGELOG.md) for what's new.

## Why

Coding agents fail in the same few ways: they start writing code before anyone agreed what to build, they skip tests, they mark work done because it compiles, and they review their own work and like it.

phaseproof is the process I ran by hand across a dozen shipped projects, packed into one plugin:

1. **Docs before code.** Each phase gets a `scope.md` with a measurable "Done when" and a `tasks.md` where every section ends in a **Check:** you can run.
2. **A different model reviews.** Sonnet builds, Opus reviews. The reviewer sees the spec and the diff, not the builder's reasoning, and must answer `VERDICT: PASS | FAIL` with `file:line` evidence.
3. **You approve.** Code stays closed until the docs pass review and you run `/phaseproof:approve`.
4. **Checks are re-run, not trusted.** The gate script runs your test and typecheck commands itself before it closes a phase, refuses if the commands you approved were changed, and refuses if code changed after the code review was saved.
5. **Tests can be locked.** Acceptance tests written with the plan and listed under **Locked tests:** are approved with it. After that the builder has to make them pass instead of editing them.
6. **Ship with proof.** New build on a spare port, health check, swap, keyword check on the live URL, rollback written down.
7. **Lessons come back when they matter.** A lesson that says which files it is about is put in front of Claude when it edits those files. The code reviewer is asked to rule on each one: a fact it calls broken refuses the gate, and one it skips is a gate warning. After `/compact`, the open blockers and the failing check come back too.

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
| `/phaseproof:doctor` | Checks Node, git, config, checks, phase folder, locked tests and approval, and says what to fix |
| `/phaseproof:report` | What the reviews and gates caught, phase by phase: review rounds, failed reviews, blockers, gate warnings |

The script behind the skills has one more command you can run yourself, `node ${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs facts [path]...`. It lists the facts bound to files, the facts for a path, or with `--since [ref]` the facts that cover the code changed since the approval, and names facts whose paths match no file.

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
- closes code again when `scope.md`, `tasks.md` or `screens.md` change after approval; re-approving a full phase then needs a fresh docs review. Ticking a box in tasks.md (`- [ ]` to `- [x]`) and line endings are not a change. Only the owner makes a phase quick, with `approve --quick`; nothing in scope.md can. Each phase number may have one folder
- closes code when a phase is blocked after two failed code reviews, until the owner approves it again
- keeps locked tests closed: before the phase's first approval, files listed under **Locked tests:** in scope.md may be written if they look like test files, are not committed yet, and have no symlink in their path; a committed test stays closed. Once approved, every locked test is closed to file tools, through any spelling or symlink, even inside `docs/` or `phases/` and even if it is later taken off the list. Paths are matched without regard to case on every system, so two tests that differ only in case are treated as one. Adding a locked test to an approved phase is the owner's job: they write it, list it, and approve again. Their contents are part of the approved scope, so a shell edit or deletion closes code and the gate until the owner approves again, and the message names the file. Line endings are ignored. Approval refuses a locked test that is missing, outside the project, absolute, behind a symlink, cased differently from the file on disk, or not a test
- runs each command listed under **Gate runs:** in scope.md at every `check` and `gate`, next to the project's checks. They are part of the approved scope, so changing them closes code like any scope edit. Pointing one at the locked tests (`node --test tests/otp.test.js`) means a changed project test command cannot drop them. Runner config still can: jest or vitest with `passWithNoTests` and an ignore pattern, or a pytest conftest that skips, can make the same command run nothing and pass. Prefer runner flags that fail when no test runs, give commands that reach a server a timeout (`curl -m 10`), and the code reviewer is told to check runner config changes. phaseproof reads scope.md as plain text: only ``` fences and HTML comments hide a line from it, so a `**Gate runs:**` line inside a `~~~` block or an indented example counts. `approve` prints every gate command and every test the scope allows removing; read that line before you sign
- warns at the gate when the code changed since approval outgrows the phase's **Budget:** (`300 lines, 8 files`, `1,200 lines`, `2k LOC`); docs, binary files and untracked files over 1 MB are not counted, and a move git detects as a rename counts as one file with its edited lines. A move that is neither staged nor committed counts as a delete and an add. `status` shows how much is used
- closes code and refuses the gate when the checks or doc paths in `.phaseproof/config.json` change after approval; until the owner approves again, only the default doc paths count as docs, so widening them opens nothing. `approve` prints the commands it binds, and any non-default doc paths, so you see what you are signing. This binds the command text, not what it runs: an edited `npm test` script, or a runner config that excludes a file, changes what runs without changing the command. The code reviewer is told to run the locked tests itself and to flag such edits. Approvals from before 0.5 have no record of the config and are not checked
- allows Markdown, `docs/`, `phases/` and `design/`, except for locked tests and while the config has changed (below)
- blocks writes to `.phaseproof/gates`, `approvals`, `runs` and `blocks`, by file tools or by Bash, and blocks running `approve` from Bash. Paths are matched under every spelling the file system folds to `.phaseproof` (letter case, trailing dots, the Windows short name). The Bash part is a text match on the command: it stops an agent that runs `approve` by habit, not one that hides the word on purpose (`$(printf approve)`)
- catches shell writes: while code is closed, a `PreToolUse` hook records `git status` before every Bash call and `PostToolUse` / `PostToolUseFailure` hooks compare it after. If the command changed, committed or wiped code (including your own uncommitted changes), Claude is told which files and asked to stop and wait for you, and you get a notice too. phaseproof itself never modifies or deletes a file, and never tells Claude to run a destructive fix

Saving the code review with the Write or Edit tool records the code as it is at that moment: the paths that differ from the approval's base, with a hash of each. Saving the review file again records again. The gate compares that record with the code as it is. Any recorded file that was changed, reverted or deleted afterwards, and any tracked file that newly differs, refuses the gate and names the file; an untracked file that only appears afterwards (coverage output, snapshots) warns. Staging or committing reviewed code is not a change, but a pre-commit hook or a check that rewrites tracked files is: commit or gitignore that output before the review. A review saved some other way, or a git call that failed while the review was saved, gets a warning that says why instead of a comparison. If the review was recorded but the code as it is now cannot be read, or git times out, the gate refuses and says why. Files marked assume-unchanged or skip-worktree are invisible to the comparison, and the gate warns when there are any. The record trusts that whoever saves the review file just ran the review: saving an old PASS again after changing code makes the gate accept that code. Commits inside a submodule are not compared.

The gate script also compares test files with the first approval and prints warnings, without blocking, for tests that look deleted and for newly added skip or focus markers (`.skip`, `.only`, `xit`, `@pytest.mark.skip`, `#[ignore]` and similar). Renames that are committed, staged, or unchanged moves are recognised; a test moved and edited without staging shows up as a possible deletion until you `git add` it. Files the owner lists under **Removes tests:** in scope.md (comma-separated or as a bullet list, paths relative to the project folder; a path ending in `/` covers a folder) are left out. Tests inside git submodules, outside a sparse checkout, in gitignored files, or behind a git clean filter are not compared reliably, and each git call gives up after 20 seconds with a warning. These checks warn rather than block because git has too many ways to move a file for a pattern to be certain; the code reviewer and you make the call.

When Claude is about to finish a turn while a phase is building, a `Stop` hook checks the last recorded `check` run. If it failed and no code has changed since, Claude is asked once to fix it or tell you plainly that the checks are red and why it is stopping. It never runs the checks itself, asks once per failed check run (not once per turn, so it cannot keep re-blocking the same result), and stays quiet while background tasks run, after a block, and after the gate. It records which run it asked about in `.phaseproof/runs/`.

At the start of every session, and after `/compact`, `/clear`, a resume or a fork, a `SessionStart` hook puts the current phase, its Goal and Done when, and whether code is open back into Claude's context, so a long session does not drift off the plan. While a phase is building it also adds where the work stands: up to three blockers from the last code review, the failing commands and last lines of the last check run, and the first unticked task in tasks.md. Each piece is clipped and labelled as data from the phase records, and the whole addition stays under 1,000 characters. Blockers and a failing run are marked when code was edited with the Write or Edit tool after them (the time of the last code edit is kept in `.phaseproof/cache/`, which `.phaseproof/.gitignore` keeps out of git; edits made from Bash are not counted), and nothing is added while the phase is blocked or its approval is stale. Compaction is where agents most often lose the plan; this puts back the parts that are already written down.

Every command and hook uses the nearest folder above it that has `.phaseproof/state.json`, so running phaseproof from a subfolder works, and `init` refuses inside a project that is already tracked. Each check gets 10 minutes before it is stopped, with every process it started, and counted as failed; a failing check prints its last 20 lines. Claude's Bash tool stops a call after 2 minutes unless it asks for more, so long suites should be run with a longer Bash timeout. Without git, or before the first commit, the shell guard, the test comparison, the budget and the "code changed after review" check are off, and `approve` says so.

In any project without `.phaseproof/state.json` it does nothing. If the hook gets input it cannot parse, it allows the call rather than locking your session.

### Facts bound to files

A line in `docs/learnings.md` that ends with `(applies to: src/auth/**, src/otp.ts)`, or an ADR with an `**Applies to:**` line, is a fact bound to those files:

```
- OTP codes expired after 50 minutes, not 5 -> a locked test checks expiry (applies to: src/auth/**)
```

When Claude edits a bound file, the `PreToolUse` hook adds the matching facts to its context along with that edit, at most three, each with its source line and whether a gate has checked it yet. Claude reads them right after the call, so the edit itself still goes ahead, and Claude can correct a change that breaks one straight away. In a test where the fact said codes expire after 5 minutes and Claude was told to set 3600 seconds, it made the edit, quoted the fact, and flagged the conflict. Memory written at the start of a session gets summarised away; this arrives with the edit it is about. The hook only adds context: it never allows a call that your permission settings would ask about, and when the edit is refused nothing is added. Each fact is shown once per session, and again after `/compact` or `/clear`; if you reject the edit at a permission prompt, Claude may not have seen it, and it comes back after the next compact. The text is labelled as data from the project's docs; it is repo content like any other.

At review, the build and quick skills hand the code reviewer every fact that covers the changed code (`phaseproof facts --since`, up to 20), and the reviewer rules on each one under `## Facts` in its review: holds, broken or outdated, naming the fact by the short id `facts` prints (`[3f9a1c2b7e]`). The id comes from the fact's file, text and paths, so moving lines around does not move a ruling onto another fact, and editing a fact gives it a new id that needs a new ruling. A holds or outdated ruling has to name its word straight after the id, so a copied fact line or a template line is not a ruling. The word broken anywhere on a ruling line makes it broken, and broken wins over holds: when in doubt, the gate refuses. Any broken ruling refuses the gate until a new code review, even if the fact was edited since. For an ADR the id covers the whole file, so changing the decision makes it a new, unchecked fact. The gate refuses when the review calls a fact broken, warns about outdated facts and about facts it did not rule on, and records only the facts it says hold as checked at that gate, in `.phaseproof/runs/facts.json`. Editing a fact's text makes it a new, unchecked fact. Facts bound only to docs are never marked checked, because the gate compares code.

`phaseproof facts` lists every fact and the ones whose paths match no file; `phaseproof facts src/otp.ts` shows the facts for a file. Paths are relative to the project folder: an exact path, a folder ending in `/`, `*` within one part of the path, and `**` as a whole part for any number of folders, matched without regard to case. Matching runs in time proportional to the path, so a pattern cannot stall the hook. The build skill writes the binding when it adds a lesson after a gate. Files over 256 KB are not read. The per-session record of what was shown lives in `.phaseproof/cache/`, which `.phaseproof/.gitignore` keeps out of git.

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
    ├── runs/                     last check results, what code the review saw, review history, facts checked at gates
    ├── blocks/                   phases stopped after two failed reviews
    ├── gates/                    closed phases, with check results and review hashes
    ├── cache/                    per-session state (facts shown, time of the last code edit), gitignored
    ├── .gitignore                keeps cache/ out of git
    └── .gitattributes            union merge for the review history
```

Commit `.phaseproof/` with the code, except `cache/`. The approvals and gates are the audit trail.

## What it runs and sends

- `scripts/stop.mjs` runs when Claude finishes a turn. It reads `.phaseproof/` and, if the last check run failed, runs the same read-only git commands as the review record to see whether code changed since. When it asks Claude to continue, it writes which check run it asked about to `.phaseproof/runs/`.
- `scripts/session.mjs` runs at session start and after compact, clear, resume or fork. It reads `.phaseproof/`, `phases/` and `docs/` and prints a short status for Claude. It runs no git. The only thing it writes is cleanup in `.phaseproof/cache/`: the facts already shown are forgotten after a compact or clear, and session records older than a week are removed.
- The hook runs `node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs` before file edits and Bash calls. It reads files under `.phaseproof/`, the current phase's scope and locked tests, `docs/learnings.md` and `docs/decisions/` in your project, and prints an allow or deny decision, plus any facts bound to the file being edited. To tell whether a locked test is already committed it runs `git ls-tree` and `git rev-parse`. When it shows facts it records their ids for the session in `.phaseproof/cache/`, and adds `cache/` to `.phaseproof/.gitignore` if it is missing. It makes no network calls.
- After a Write or Edit to a code file, `scripts/post.mjs` writes the time, the file's path and its modification time to `.phaseproof/cache/last-edit.json` (adding `cache/` to `.phaseproof/.gitignore` if needed), so the session status can say a review is older than the code.
- After a Write or Edit to any review in `.phaseproof/reviews/`, `scripts/post.mjs` appends one line to `.phaseproof/runs/reviews.jsonl`: the phase, the kind of review, its verdict, the number of blockers, the time and a hash of the review. `report` reads it. If branches that both saved reviews get merged, the `merge=union` rule that `init` and `approve` write to `.phaseproof/.gitattributes` keeps both sides.
- `doctor` only reads: it runs `git --version`, `rev-parse`, `cat-file -e`, `check-ignore --no-index` and `ls-files --others`, and reads `.phaseproof/`, `phases/` and the plugin's own `hooks/hooks.json`.
- After a Write or Edit to `.phaseproof/reviews/phase-NN-code.md`, `scripts/post.mjs` runs `git diff --name-only`, `git ls-files --others` and `git hash-object --stdin-paths` (without writing objects) and records paths and hashes, no file contents, in `.phaseproof/runs/`. For any other file it does nothing.
- While code is closed, `scripts/hook.mjs` and `scripts/post.mjs` run `git status`, `git rev-parse` and `git diff --name-only` around Bash calls to find shell writes to code. They write only short-lived records to `phaseproof/` inside the git directory (`.git/phaseproof/`, or the worktree's or submodule's own git dir), holding paths, sizes and hashes but no file contents, and never change your files.
- At gate time the test guard runs read-only git commands (`ls-tree`, `ls-files`, `diff -M`, and `hash-object --stdin-paths` without writing) to compare test files with the approval. It writes nothing to your repository.
- `scripts/phaseproof.mjs` reads and writes files under `.phaseproof/`, and runs `git rev-parse HEAD` to record the commit. `facts` runs `git ls-files` and, with `--since`, `git rev-parse --verify` and the same read-only git commands as the review record.
- `check` and `gate` run the commands you list in `.phaseproof/config.json` (your tests, typecheck, lint) through your shell, in your project directory. Nothing else is executed.
- No telemetry, no data leaves your machine, no packages are downloaded. The researcher and ship-verifier agents use Claude's own WebSearch and WebFetch tools when a skill asks them to.

## Requirements

- Claude Code with plugin support, and Node.js 20 or later on `PATH` (the hook and the gate script are plain Node, no dependencies)
- Access to the models the agents pin. On a plan without Opus, change the reviewers' model as above.

## Privacy

No server, no telemetry, nothing collected. See [PRIVACY.md](PRIVACY.md).

## Status

v0.9.1. The gate script, the hooks and their tests are done (about 240 tests on Linux, macOS and Windows). The skills and agents are new and will change as they get used on real projects. Issues and PRs are welcome.

## Related projects

- [obra/superpowers](https://github.com/obra/superpowers): a broad skills library for Claude Code
- [github/spec-kit](https://github.com/github/spec-kit): spec-driven development toolkit
- [dsnger/dev-workflow-kit](https://github.com/dsnger/dev-workflow-kit): spec-driven workflow with cross-model review gates

## License

MIT
