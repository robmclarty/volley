// Asks before a Bash command that names keyframes.md, or that would get around
// the pre-commit gate guarding it (.githooks/pre-commit).
//
// Claude Code's Edit(...) permission rules only see its file tools, so a shell
// write (`sed -i`, `>`, `cp`, a `python -c`) reached keyframes.md unasked. This
// closes that for any command that names the file. A command that reaches it
// without naming it (a glob, a variable, a script) still gets through here, and
// the pre-commit gate is what stops that change from landing.
//
// It asks rather than denies: a person can still approve the edit, which is
// what AGENTS.md's "unless a person asks you to" means.
import { readFileSync } from 'node:fs';

const CHECKS = [
  { pattern: /keyframes\.md/, reason: 'it names keyframes.md' },
  {
    pattern: /\bgit\b[^|;&]*\bcommit\b[^|;&]*(--no-verify|\s-[A-Za-z]*n)/,
    reason: 'it skips the pre-commit gate that guards keyframes.md',
  },
  {
    pattern: /core\.hooksPath|\.githooks/,
    reason: 'it touches the git hooks that guard keyframes.md',
  },
  {
    pattern: /\.claude\/(settings|hooks)/,
    reason: 'it touches the Claude Code settings that guard keyframes.md',
  },
];

const payload = JSON.parse(readFileSync(0, 'utf8'));
const command = String(payload?.tool_input?.command ?? '');
const reasons = CHECKS.filter((check) => check.pattern.test(command)).map((check) => check.reason);

if (reasons.length > 0) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `keyframes.md guard: ${reasons.join('; ')}`,
      },
    }),
  );
}
