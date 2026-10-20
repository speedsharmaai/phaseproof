---
name: status
description: Show the current phase and what it is waiting on - docs review, owner approval, checks, code review, gate. Use when the user asks where a phaseproof project stands.
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" status`

Show this to the user and name the single next step: `/phaseproof:phase`, `/phaseproof:design`, `/phaseproof:approve` (owner only), `/phaseproof:build` or `/phaseproof:ship`.
