import { closedReason, decide } from './lib/decide.mjs';
import { isMain } from './lib/main.mjs';
import { isActive } from './lib/project.mjs';
import { snapshot } from './lib/shell.mjs';

export function respond(raw, projectDir = process.env.CLAUDE_PROJECT_DIR) {
  try {
    const input = JSON.parse(raw);
    const root = projectDir || input.cwd;
    const d = decide({ root, toolName: input.tool_name, toolInput: input.tool_input ?? {} });
    if (d.allow) {
      if (input.tool_name === 'Bash' && isActive(root) && closedReason(root)) {
        snapshot(root, input.tool_use_id, { background: Boolean(input.tool_input?.run_in_background) });
      }
      return '';
    }
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: d.reason,
      },
    });
  } catch {
    return '';
  }
}

if (isMain(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  process.stdout.write(respond(raw));
}
