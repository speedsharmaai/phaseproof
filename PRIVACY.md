# Privacy

phaseproof has no server, no account and no telemetry. It collects nothing.

## What it stores

Only files inside your project, under `.phaseproof/`:

- `config.json`: the check commands you chose
- `state.json`: the current phase number
- `reviews/`: reviewer reports written during a session
- `approvals/` and `gates/`: timestamps, the git commit hash, check exit codes and hashes of the review files
- `runs/`: the last output lines of your check commands
- `shell/`: short-lived snapshots around shell commands while code is closed, holding file paths, sizes and hashes, never file contents. Gitignored, removed after each command, or within 24 hours if the command never ran.

None of these contain names, emails or other personal data unless you put them there. You can delete the folder at any time.

## What it sends

The plugin's own code (the hook and `scripts/phaseproof.mjs`) makes no network requests.

Two agents can use Claude Code's built-in WebSearch and WebFetch tools when a skill asks them to: `researcher` for public docs and references, and `ship-verifier` for your own deployed URL. Those requests are made by Claude Code under your normal permission settings.

## Contact

Questions: open an issue at https://github.com/speedsharmaai/phaseproof/issues
