# Contributing

Thanks for helping. phaseproof is small on purpose, so the bar for new behaviour is "it keeps a phase honest".

## Before you open a PR

- Open an issue first for anything bigger than a fix, so we agree on the shape before you write it.
- Run the tests: `node --test`. Every change to `scripts/` ships with a test in `tests/`; a bug fix starts with a failing one.
- Run `claude plugin validate . --strict` if you touched the manifest, skills, agents or hooks.
- No runtime dependencies. The hook and the gate script stay plain Node.

## Pull requests

- One change per PR. `main` is protected: PRs are squash-merged and need green CI.
- The PR title becomes the commit, in conventional form: `fix: ...`, `feat: ...`, `docs: ...`. Lowercase, no full stop, under 72 characters.
- Commits must be signed.
- Describe what changed, why, and how you tested it. The template has the three headings.

## Reporting security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).

By contributing you agree your work is released under the [MIT license](LICENSE) and you follow the [code of conduct](CODE_OF_CONDUCT.md).
