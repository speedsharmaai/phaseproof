# Changelog

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
