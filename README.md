# phaseproof

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
4. **Checks are re-run, not trusted.** The gate script runs your test and typecheck commands itself before it closes a phase.
5. **Ship with proof.** New build on a spare port, health check, swap, keyword check on the live URL, rollback written down.

## How a phase flows

```mermaid
flowchart LR
  A[/phaseproof:phase/] --> B{doc-reviewer<br/>opus}
  B -- FAIL, max 2 rounds --> A
  B -- PASS --> D[/phaseproof:design/<br/>if the phase has UI]
  D --> E[/phaseproof:approve/<br/>owner only]
  B -- PASS, no UI --> E
  E --> F[builder<br/>sonnet]
  F --> G[checks]
  G --> H{code-reviewer<br/>opus}
  H -- FAIL, max 2 rounds --> F
  H -- PASS --> I[gate: re-runs checks<br/>closes the phase]
  I --> J[/phaseproof:ship/]
```

## Commands

| Command | What it does |
|---|---|
| `/phaseproof:kickoff [idea]` | README with the one number and rules, phase list, first ADR, gate turned on |
| `/phaseproof:phase NN name` | Writes the phase's scope and tasks, doc-reviewer checks them |
| `/phaseproof:design NN` | Designs and exports the phase's screens, design-reviewer checks the exports |
| `/phaseproof:approve NN` | Owner sign-off. Claude cannot run it for you |
| `/phaseproof:build` | Builder, checks, code-reviewer, gate, progress notes |
| `/phaseproof:ship [env]` | Dry run, spare-port boot, deploy on your go, live check, rollback |
| `/phaseproof:status` | Where the phase stands and the one next step |

## Model routing

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

To run an agent on a different model, copy its file from `agents/` into `~/.claude/agents/`, change `model:`, and your copy takes priority over the plugin's.

## What the gate does and does not stop

When `.phaseproof/state.json` exists in a project, a `PreToolUse` hook:

- blocks `Write`, `Edit`, `MultiEdit` and `NotebookEdit` on code until the current phase is approved, and again after its gate passes
- always allows Markdown, `docs/`, `phases/` and `design/`
- blocks writes to `.phaseproof/gates`, `approvals` and `runs`, by file tools or by Bash, and blocks running `approve` from Bash

In any project without `.phaseproof/state.json` it does nothing. If the hook gets input it cannot parse, it allows the call rather than locking your session.

It is a guardrail against drift, not a security boundary. A determined agent can still write code through a shell command, and a review report is model output like any other. What it reliably stops is the common failure: an agent that skips the plan, skips the review, or calls a phase done with red tests.

## What it writes in your project

```
your-project/
├── README.md                     one number, rules, phases table
├── WORKLIST.md                   now, next, waiting on the owner
├── docs/
│   ├── decisions/0001-stack.md   ADRs
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
    ├── runs/                     last check results
    └── gates/                    closed phases, with check results and review hashes
```

Commit `.phaseproof/` with the code. The approvals and gates are the audit trail.

## What it runs and sends

- The hook runs `node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs` before file edits and Bash calls. It reads files under `.phaseproof/` in your project and prints an allow or deny decision. It makes no network calls.
- `scripts/phaseproof.mjs` reads and writes files under `.phaseproof/`, and runs `git rev-parse HEAD` to record the commit.
- `check` and `gate` run the commands you list in `.phaseproof/config.json` (your tests, typecheck, lint) through your shell, in your project directory. Nothing else is executed.
- No telemetry, no data leaves your machine, no packages are downloaded. The researcher and ship-verifier agents use Claude's own WebSearch and WebFetch tools when a skill asks them to.

## Requirements

- Claude Code with plugin support, and Node.js 20 or later on `PATH` (the hook and the gate script are plain Node, no dependencies)
- Access to the models the agents pin. On a plan without Opus, change the reviewers' model as above.

## Status

v0.1.0. The gate script, the hook and their tests are done. The skills and agents are new and will change as they get used on real projects. Issues and PRs are welcome.

## Related projects

- [obra/superpowers](https://github.com/obra/superpowers): a broad skills library for Claude Code
- [github/spec-kit](https://github.com/github/spec-kit): spec-driven development toolkit
- [dsnger/dev-workflow-kit](https://github.com/dsnger/dev-workflow-kit): spec-driven workflow with cross-model review gates

## License

MIT
