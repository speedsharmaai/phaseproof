import { decide } from './lib/decide.mjs';
import { isMain } from './lib/main.mjs';

export function respond(raw, env = process.env) {
  try {
    const input = JSON.parse(raw);
    const root = env.CLAUDE_PROJECT_DIR || input.cwd;
    const d = decide({ root, toolName: input.tool_name, toolInput: input.tool_input ?? {} });
    if (d.allow) return '';
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
