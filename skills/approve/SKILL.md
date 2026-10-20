---
name: approve
description: Owner sign-off that opens code for the current phase. Only the owner runs this.
argument-hint: "<NN> [--quick] [--new-base]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" approve:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" approve $ARGUMENTS`

Report the line above to the owner as it is. If it was approved, say that `/phaseproof:build` is next, and mention a cleared block if the line says so. If it was refused, say what is missing and which skill fixes it. Do not try to approve another way.
