import { closedReason } from './lib/decide.mjs';
import { isMain } from './lib/main.mjs';
import { isActive } from './lib/project.mjs';
import { describeViolation, ownerNotice, verify } from './lib/shell.mjs';

export function respond(raw, projectDir = process.env.CLAUDE_PROJECT_DIR) {
  try {
    const input = JSON.parse(raw);
    const root = projectDir || input.cwd;
    if (input.tool_name !== 'Bash' || !isActive(root)) return '';
    const result = verify(root, input.tool_use_id);
    if (!result) return '';
    const reason = closedReason(root) ?? 'the phase was closed when the command started.';
    const message = describeViolation(reason, result);
    const systemMessage = ownerNotice(result);
    if (input.hook_event_name === 'PostToolUseFailure') {
      return JSON.stringify({ systemMessage, hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: message } });
    }
    return JSON.stringify({ systemMessage, decision: 'block', reason: message });
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
