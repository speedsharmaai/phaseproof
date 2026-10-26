---
name: doctor
description: Check the phaseproof setup in this project - Node, git, config, checks, phase folder, locked tests, approval - and say what to fix. Use when something in phaseproof seems not to work or right after installing it.
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/phaseproof.mjs" doctor` and show its output as it is.

Then, for each FAIL and warn line, say in one sentence what to do about it, starting with the FAIL lines. Do not change any file yourself; anything under `.phaseproof/` or an approval is the owner's call.
