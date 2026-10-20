---
name: ship
description: Release checklist with proof - dry-run diff, new build booted on a spare port, health check, swap, live keyword check, written rollback. Use before and after deploying a phase.
argument-hint: "[environment]"
---

Ship to $ARGUMENTS (production if empty).

1. Find the project's deploy scripts or runbook. If there are none, write `docs/runbook/deploy.md` first and stop for the owner to confirm it.
2. Send `phaseproof:ship-verifier` the runbook path with steps 1-2 of its checklist: dry-run diff, then boot the new build on a spare port and hit its health endpoint. It must not deploy.
3. Show the owner the dry-run result and the rollback command. Deploy only after the owner says go, or if they have already allowed this project to self-deploy.
4. After the deploy, send `phaseproof:ship-verifier` steps 3-4: live URL, a keyword only the new version has, rollback written down.
5. Add both reports to the phase's `progress.md` under "Verification transcript". If anything failed, say so first and give the rollback command.
