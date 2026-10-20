# Privacy

phaseproof has no server, no account and no telemetry. It collects nothing.

## What it stores

Only files inside your project, under `.phaseproof/`:

- `config.json`: the check commands you chose
- `state.json`: the current phase number
- `reviews/`: reviewer reports written during a session
- `approvals/` and `gates/`: timestamps, the git commit hash, check exit codes and hashes of the review files
- `runs/`: the last output lines of your check commands

None of these contain names, emails or other personal data unless you put them there. You can delete the folder at any time.

Outside `.phaseproof/`, it writes only short-lived records to `phaseproof/` inside the git directory (`.git/phaseproof/`, or the worktree's or submodule's git dir) while code is closed: file paths, sizes, modification times, hashes and symlink targets around each shell command, never file contents. Each record is removed after its command. A record left by a command that never ran (denied or interrupted) is pruned by a later snapshot in the same repository once it is a day old.

At gate time it only reads git history and your working tree; it writes nothing.

## What it sends

The plugin's own code (the hook and `scripts/phaseproof.mjs`) makes no network requests.

Two agents can use Claude Code's built-in WebSearch and WebFetch tools when a skill asks them to: `researcher` for public docs and references, and `ship-verifier` for your own deployed URL. Those requests are made by Claude Code under your normal permission settings.

## Contact

Questions: open an issue at https://github.com/speedsharmaai/phaseproof/issues
