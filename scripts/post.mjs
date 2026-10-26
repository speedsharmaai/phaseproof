import { closedReason } from './lib/decide.mjs';
import { isMain } from './lib/main.mjs';
import { recordReview } from './lib/drift.mjs';
import { describeViolation, ownerNotice, verify } from './lib/shell.mjs';
import { isActive } from './lib/project.mjs';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

export function respond(raw, projectDir = process.env.CLAUDE_PROJECT_DIR) {
  try {
    const input = JSON.parse(raw);
    const root = projectDir || input.cwd;
    if (FILE_TOOLS.has(input.tool_name)) {
      recordReview(root, input.tool_input?.file_path);
      return '';
    }
    if (input.tool_name !== 'Bash') return '';
    const result = verify(root, input.tool_use_id);
    if (!result) return '';
    const reason = (isActive(root) && closedReason(root)) || 'the phase was closed when the command started.';
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
